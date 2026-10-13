#!/usr/bin/env node
// Meeting bot runner (docs/dev/DESIGN.md §6). One detached process per
// meeting: `node bot-runner.mjs --meeting-dir <abs>`. It reads config.json,
// sets up PulseAudio + Xvfb + Chrome, joins through a platform adapter,
// records with ffmpeg, logs who speaks, and leaves on stop/end/alone/silence/
// max duration. All state goes to files in the meeting directory (§4);
// stdout/stderr are redirected to bot.log by the host.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PcmTail, Recorder, ensurePulse, gcStalePulseModules, loadPulseModules, startXvfb, stopXvfb, unloadPulseModules } from "./lib/av.mjs";
import { SCREEN, killChromeForProfile, killChromeForProfileSync, launchChrome, prepareProfile, resolveChromePath } from "./lib/chrome.mjs";
import { ControlChannel } from "./lib/control.mjs";
import { appendJsonl, ensureDir, readJson, stamp, writeFileAtomic, writeJsonAtomic } from "./lib/files.mjs";
import { AloneDetector, SilenceDetector, SpeakerFusion, cleanNames, sameSet } from "./lib/fusion.mjs";
import { BotError, StopRequested, findProcesses, killPid, sleep, sleepUnless, within } from "./lib/proc.mjs";
import mockPlatform from "./platform-mock.mjs";
import zoomPlatform, { pageOp, resolveSelectors, zoomFrame } from "./platform-zoom.mjs";

const HEARTBEAT_MS = 2_000;
const SAMPLE_PERIOD_MS = 220;
const SIGNALS_PERIOD_MS = 1_000;
const ROSTER_REFRESH_MS = 10_000;
const SWEEP_PERIOD_MS = 3_000;
const AUDIO_CHECK_MS = 5_000;
const WATCHDOG_MS = 20_000;
const LEAVE_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const LOGIN_FINISH_DELAY_MS = 5_000;
const NO_SPEAKER_DUMP_MS = 120_000;
const MAX_DEBUG_DUMPS = 40;
/** RMS of the recording above which "there is audio" for the no-speaker forensics. */
const AUDIBLE_RMS = 0.003;
const MEETING_ID = /^mtg_[a-z0-9]{6,32}$/;
const PLATFORMS = { zoom: zoomPlatform, mock: mockPlatform };
const SIGNED_IN_COOKIES = new Set(["zm_aid", "_zm_ssid", "zm_haid"]);

function parseArgs(argv) {
  const index = argv.indexOf("--meeting-dir");
  const dir = index >= 0 ? argv[index + 1] : undefined;
  if (!dir) {
    console.error("usage: node bot-runner.mjs --meeting-dir <absolute path>");
    process.exit(2);
  }
  return { meetingDir: path.resolve(dir) };
}

/** Loose runtime check of config.json against botConfigSchema (src/shared/runtime-files.ts). */
function validateConfig(config) {
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };
  need(config && typeof config === "object", "config.json is not an object");
  if (problems.length) return problems;
  need(config.version === 1, "version must be 1");
  need(typeof config.meetingId === "string" && MEETING_ID.test(config.meetingId), "meetingId");
  need(config.mode === undefined || config.mode === "meeting" || config.mode === "login", "mode");
  need(config.platform in PLATFORMS, "platform");
  need(typeof config.joinUrl === "string" && config.joinUrl.length > 0, "joinUrl");
  need(typeof config.botName === "string" && config.botName.trim().length > 0, "botName");
  for (const key of ["maxDurationSec", "aloneTimeoutSec", "waitingTimeoutSec", "screenshotIntervalSec"]) {
    need(Number.isFinite(config[key]) && config[key] >= 0, key);
  }
  need(config.silenceTimeoutSec === undefined || Number.isFinite(config.silenceTimeoutSec), "silenceTimeoutSec");
  return problems;
}

class BotRunner {
  constructor(dir) {
    this.dir = dir;
    this.config = null;
    this.stopController = new AbortController();
    this.stopReason = null;
    this.fatal = null;
    this.outcome = null;
    this.closing = false;
    this.page = null;
    this.context = null;
    this.xvfb = null;
    this.pulse = null;
    this.recorder = null;
    this.profileDir = null;
    this.profileIsTemporary = true;
    this.fusion = null;
    this.screenshotWanted = false;
    this.lastShotAt = 0;
    this.shotBusy = false;
    this.debugDumps = 0;
    this.loginDone = false;
    this.terminalWritten = false;
    this.loggedPhase = null;
    const now = Date.now();
    this.state = {
      version: 1,
      meetingId: "mtg_unknown0",
      pid: process.pid,
      phase: "starting",
      detail: "Starting",
      startedAt: now,
      joinedAt: null,
      recordingStartedAt: null,
      endedAt: null,
      endReason: null,
      error: null,
      participants: { count: null, names: [] },
      activeSpeakers: [],
      audio: { seconds: 0, bytes: 0 },
      updatedAt: now,
    };
    this.log = this.log.bind(this);
    this.setPhase = this.setPhase.bind(this);
  }

  file(name) {
    return path.join(this.dir, name);
  }

  // ---------------------------------------------------------------- logging/state

  log(level, msg, data) {
    const t = Date.now();
    const line = `${new Date(t).toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
    if (level === "debug") return;
    try {
      appendJsonl(this.file("events.jsonl"), data === undefined ? { t, level, msg } : { t, level, msg, data });
    } catch {
      // the meeting dir vanished; stdout still has it
    }
  }

  writeState() {
    if (this.terminalWritten && !TERMINAL.has(this.state.phase)) return;
    const bytes = this.recorder ? this.recorder.bytes() : 0;
    this.state.audio = { seconds: Math.round((bytes / 32_000) * 100) / 100, bytes };
    this.state.updatedAt = Date.now();
    try {
      writeJsonAtomic(this.file("state.json"), this.state);
    } catch (error) {
      console.error(`cannot write state.json: ${error.message}`);
    }
  }

  setPhase(phase, detail) {
    if (this.terminalWritten) return;
    if (this.loggedPhase === phase && this.state.detail === detail) return;
    const changed = this.loggedPhase !== phase;
    this.loggedPhase = phase;
    this.state.phase = phase;
    this.state.detail = detail;
    this.log("info", changed ? `Phase ${phase}: ${detail}` : detail, changed ? { phase } : undefined);
    this.writeState();
    this.wantScreenshot();
  }

  // ---------------------------------------------------------------- stop / errors

  requestStop(reason) {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.log("info", `Stop requested (${reason})`);
    this.stopController.abort();
  }

  setFatal(error) {
    if (this.fatal !== null || this.closing) return;
    if (this.stopReason !== null && error.code === "browser_crashed") {
      // Already stopping: Chrome going away now must not turn "stopped" into "failed".
      this.log("warn", `${error.message} (while stopping)`);
      return;
    }
    this.fatal = error;
    this.log("error", `Fatal: ${error.message}`, { code: error.code ?? "unknown" });
    this.stopController.abort();
  }

  outcomeFromError(error) {
    if (error instanceof StopRequested || (this.stopReason !== null && this.fatal === null && !(error instanceof BotError))) {
      return { phase: "ended", endReason: "stopped", error: null, detail: "Stopped before joining the meeting" };
    }
    const code = error instanceof BotError ? error.code : "unknown";
    const message = error instanceof BotError ? error.message : `${error.name}: ${error.message}`;
    const endReason = code === "waiting_timeout" ? "waiting_timeout" : code === "meeting_ended" ? "meeting_ended" : "error";
    return { phase: "failed", endReason, error: { code, message: message.slice(0, 1000) }, detail: message.slice(0, 300) };
  }

  // ---------------------------------------------------------------- screenshots / debug

  wantScreenshot() {
    this.screenshotWanted = true;
  }

  async screenshot() {
    const page = this.page;
    if (!page || page.isClosed() || this.shotBusy) return;
    this.shotBusy = true;
    try {
      const buffer = await within(page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 5_000 }), 6_000, null);
      if (buffer) await writeFileAtomic(this.file("screen.jpg"), buffer);
      this.lastShotAt = Date.now();
    } catch (error) {
      this.log("debug", "Screenshot failed", { error: error.message });
    } finally {
      this.shotBusy = false;
    }
  }

  async screenshotLoop() {
    while (!this.closing) {
      const now = Date.now();
      const viewer = this.control?.viewerActive(now) ?? false;
      const every = viewer ? 1_000 : this.config.screenshotIntervalSec > 0 ? this.config.screenshotIntervalSec * 1_000 : Infinity;
      if (this.page && (this.screenshotWanted || now - this.lastShotAt >= every)) {
        this.screenshotWanted = false;
        await this.screenshot();
      }
      await sleep(200);
    }
  }

  /** DOM forensics + HTML + screenshot into debug/ (at join, on failure, on request). */
  async dumpDebug(tag, { force = false } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return;
    if (!force && this.debugDumps >= MAX_DEBUG_DUMPS) return;
    this.debugDumps += 1;
    const base = path.join(ensureDir(this.file("debug")), `${stamp()}-${tag}`);
    const frame = zoomFrame(page);
    const shot = await within(page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 5_000 }), 6_000, null);
    if (shot) await writeFileAtomic(`${base}.jpg`, shot).catch(() => {});
    const html = await within(page.content(), 5_000, null);
    if (html) await writeFileAtomic(`${base}.html`, html).catch(() => {});
    if (frame !== page.mainFrame()) {
      const frameHtml = await within(frame.content(), 5_000, null);
      if (frameHtml) await writeFileAtomic(`${base}.frame.html`, frameHtml).catch(() => {});
    }
    const forensics = await within(pageOp(frame, { op: "forensics", sel: this.selectors ?? {} }, 8_000), 9_000, null);
    const report = {
      tag,
      t: Date.now(),
      url: page.url(),
      frames: page.frames().map((f) => ({ name: f.name(), url: f.url().slice(0, 300) })),
      state: { phase: this.state.phase, detail: this.state.detail },
      fusion: this.fusion ? { current: this.fusion.current, tracks: this.fusion.trackSnapshot(), mapping: this.fusion.resolver.mapping() } : null,
      forensics,
    };
    await writeFileAtomic(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
    this.log("info", `Debug dump written: debug/${path.basename(base)}.*`);
  }

  // ---------------------------------------------------------------- remote control

  async executeControl(cmd) {
    const page = this.page;
    if (!page || page.isClosed()) throw new Error("the browser is not ready");
    switch (cmd.action) {
      case "click":
        await page.mouse.click(cmd.x, cmd.y);
        break;
      case "dblclick":
        await page.mouse.dblclick(cmd.x, cmd.y);
        break;
      case "type":
        await page.keyboard.type(cmd.text, { delay: 25 });
        break;
      case "key":
        await page.keyboard.press(cmd.key);
        break;
      case "scroll":
        await page.mouse.move(cmd.x ?? 640, cmd.y ?? 360);
        await page.mouse.wheel(0, cmd.dy ?? 0);
        break;
      case "done":
        if (this.config.mode === "login") this.loginDone = true;
        else this.log("info", "Ignoring 'done' outside a login session");
        break;
      default:
        throw new Error(`unsupported action ${cmd.action}`);
    }
    await sleep(150);
    await this.screenshot();
  }

  // ---------------------------------------------------------------- browser

  async startBrowser({ pulse, profileDir, copyFrom }) {
    this.xvfb = await startXvfb({ ...SCREEN, log: this.log });
    this.xvfb.process.on("exit", (code, signal) => {
      if (!this.closing) this.setFatal(new BotError("browser_crashed", `Xvfb exited (${signal ?? code})`));
    });
    prepareProfile(profileDir, { copyFrom, log: this.log });
    this.profileDir = profileDir;
    const chromePath = resolveChromePath(this.config.chromePath);
    const read = (name) => fs.readFileSync(new URL(`./page/${name}`, import.meta.url), "utf8");
    const { context, page } = await launchChrome({
      chromePath,
      profileDir,
      display: this.xvfb.display,
      pulse,
      initScripts: [read("scheme-guard.js"), read("track-hook.js")],
      log: this.log,
    });
    this.context = context;
    this.page = page;
    page.on("crash", () => this.setFatal(new BotError("browser_crashed", "The meeting tab crashed")));
    page.on("dialog", (dialog) => {
      this.log("info", `Page dialog (${dialog.type()}): ${dialog.message().slice(0, 200)}`);
      const accept = dialog.type() === "beforeunload" || dialog.type() === "alert";
      (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    context.on("close", () => {
      if (!this.closing) this.setFatal(new BotError("browser_crashed", "Chrome closed unexpectedly"));
    });
  }

  makeContext() {
    return {
      page: this.page,
      context: this.context,
      config: this.config,
      selectors: this.selectors,
      display: this.xvfb.display,
      signal: this.stopController.signal,
      log: this.log,
      setPhase: this.setPhase,
      dumpDebug: (tag) => this.dumpDebug(tag),
      wantScreenshot: () => this.wantScreenshot(),
      adapterState: {},
      joinedAt: null,
    };
  }

  // ---------------------------------------------------------------- meeting mode

  async runMeeting() {
    const config = this.config;
    const adapter = PLATFORMS[config.platform];
    const short = config.meetingId.slice(4, 16);
    this.selectors = resolveSelectors(config.speakerSelectors);
    this.setPhase("starting", "Preparing audio devices and a virtual display");
    await ensurePulse(this.log);
    await gcStalePulseModules(short, this.log);
    this.pulse = await loadPulseModules(short, this.log);
    this.setPhase("starting", "Starting Chrome");
    await this.startBrowser({ pulse: this.pulse, profileDir: this.file("chrome-profile"), copyFrom: config.zoomProfileDir ?? null });
    if (this.stopController.signal.aborted) throw this.fatal ?? new StopRequested();

    const ctx = this.makeContext();
    this.ctx = ctx;
    this.setPhase("joining", "Opening the meeting link");
    try {
      await adapter.join(ctx);
    } catch (error) {
      if (this.fatal) throw this.fatal;
      throw error;
    }
    if (this.stopController.signal.aborted) throw this.fatal ?? new StopRequested();

    ctx.joinedAt = this.state.joinedAt = Date.now();
    this.setPhase("in_meeting", "Joined; starting the recording");
    this.recorder = new Recorder({
      source: `${this.pulse.sink}.monitor`,
      oggPath: this.file("audio.ogg"),
      pcmPath: this.file("audio.pcm"),
      log: this.log,
      onUnexpectedExit: (exit, stderr) => this.setFatal(new BotError("recording_failed", `ffmpeg exited unexpectedly (${exit.signal ?? exit.code}): ${stderr}`)),
    });
    try {
      this.state.recordingStartedAt = await this.recorder.start({
        onRefine: (ms) => {
          this.state.recordingStartedAt = ms;
          this.writeState();
        },
      });
    } catch (error) {
      await this.leaveSafely(adapter, ctx);
      throw error;
    }
    this.setPhase("in_meeting", "Recording");

    // The announcement runs next to the sampler so the first speakers are not missed.
    const announcement = (config.chatAnnouncement ?? "").trim();
    const chat =
      announcement === ""
        ? Promise.resolve()
        : adapter.sendChat(ctx, announcement).then(
            (result) => this.log("info", `Posted the chat announcement${result?.verified ? " (seen in the chat list)" : ""}`),
            (error) => this.log("warn", "Could not post the chat announcement", { error: error.message.split("\n")[0] }),
          );
    const joinedDump = this.dumpDebug("joined").catch(() => {});
    const end = await this.sampleLoop(adapter, ctx);
    await within(Promise.all([chat, joinedDump]), 5_000);
    this.setPhase("leaving", end.detail);
    await this.leaveSafely(adapter, ctx);
    await this.recorder.stop();
    this.outcome = end;
  }

  async leaveSafely(adapter, ctx) {
    if (!this.page || this.page.isClosed()) return;
    const done = await within(
      adapter.leave(ctx).then(() => true),
      LEAVE_TIMEOUT_MS,
      false,
    );
    if (!done) {
      this.log("warn", "Leaving took too long; closing the page");
      await within(this.page.goto("about:blank", { timeout: 3_000 }), 4_000);
    }
  }

  async sampleLoop(adapter, ctx) {
    const config = this.config;
    const joinedAt = this.state.joinedAt;
    this.fusion = new SpeakerFusion({ botName: config.botName, lagMs: this.selectors.lagMs, ...this.selectors.fusion });
    const alone = new AloneDetector(config.aloneTimeoutSec * 1_000, joinedAt);
    const silence = new SilenceDetector((config.silenceTimeoutSec ?? 0) * 1_000, this.state.recordingStartedAt ?? joinedAt);
    const pcm = new PcmTail(this.file("audio.pcm"));
    let lastRosterKey = "";
    let lastRosterAt = 0;
    let lastSignalsAt = 0;
    let lastSweepAt = Date.now();
    let lastPcmAt = 0;
    let lastSpeakerAt = Date.now();
    let lastAudibleAt = 0;
    // The first no-speaker dump is due after NO_SPEAKER_DUMP_MS, later ones every 10 min.
    let lastNoSpeakerDump = -Infinity;
    let lastAudioCheckAt = Date.now();
    let failingSince = null;

    for (;;) {
      const now = Date.now();
      if (this.fatal) return this.outcomeFromError(this.fatal);
      if (this.stopReason !== null) return { phase: "ended", endReason: "stopped", error: null, detail: "Stop requested; leaving" };
      if (now - joinedAt >= config.maxDurationSec * 1_000) {
        return { phase: "ended", endReason: "max_duration", error: null, detail: `Reached the maximum duration (${Math.round(config.maxDurationSec / 60)} min); leaving` };
      }

      let sample = null;
      try {
        sample = await adapter.sample(ctx);
        failingSince = null;
      } catch (error) {
        if (this.page.isClosed() && this.stopReason === null) return this.outcomeFromError(new BotError("browser_crashed", "The meeting page closed"));
        failingSince ??= now;
        this.log("debug", "Sample failed", { error: error.message.split("\n")[0] });
        if (now - failingSince > 60_000) {
          return this.outcomeFromError(new BotError("browser_crashed", `The meeting page stopped responding: ${error.message.split("\n")[0]}`));
        }
      }

      if (sample) {
        if (sample.ended) {
          return { phase: "ended", endReason: sample.ended.reason, error: null, detail: `${sample.ended.message}; leaving` };
        }
        const { event, fused } = this.fusion.push(now, sample.signals);
        if (event) {
          appendJsonl(this.file("speakers.jsonl"), event);
          this.log("debug", "Speakers", event);
        }
        if (!sameSet(this.state.activeSpeakers, this.fusion.current)) {
          this.state.activeSpeakers = [...this.fusion.current];
        }
        if (this.fusion.current.length > 0) lastSpeakerAt = now;

        const names = cleanNames(sample.roster ?? [], config.botName);
        const count = Number.isFinite(sample.count) ? sample.count : null;
        const rosterKey = JSON.stringify([count, names]);
        if (rosterKey !== lastRosterKey || now - lastRosterAt >= ROSTER_REFRESH_MS) {
          if (rosterKey !== lastRosterKey) this.log("info", "Participants", { count, names });
          lastRosterKey = rosterKey;
          lastRosterAt = now;
          writeJsonAtomic(this.file("roster.json"), { t: now, count, names });
          this.state.participants = { count, names };
        }
        if (alone.update(now, count)) {
          const mins = Math.round((alone.aloneForMs(now) / 60_000) * 10) / 10;
          return { phase: "ended", endReason: "alone", error: null, detail: `Nobody else in the meeting for ${mins} min; leaving` };
        }
        if (now - lastSignalsAt >= SIGNALS_PERIOD_MS) {
          lastSignalsAt = now;
          appendJsonl(this.file("signals.jsonl"), {
            t: now,
            store: sample.signals.store,
            tile: sample.signals.tile,
            tracks: this.fusion.trackSnapshot(),
            fused: fused.speakers,
            src: fused.src,
            count,
            ...sample.raw,
          });
        }
      }

      if (now - lastPcmAt >= 1_000) {
        lastPcmAt = now;
        const rms = pcm.readRms();
        if (rms !== null && rms >= AUDIBLE_RMS) lastAudibleAt = now;
        if (silence.update(now, rms)) {
          const mins = Math.round((silence.silentForMs(now) / 60_000) * 10) / 10;
          return { phase: "ended", endReason: "silence", error: null, detail: `No audio for ${mins} min; leaving` };
        }
      }
      if (now - lastSpeakerAt > NO_SPEAKER_DUMP_MS && now - lastAudibleAt < 10_000 && now - lastNoSpeakerDump > 10 * 60_000) {
        lastNoSpeakerDump = now;
        this.log("warn", "Audio is playing but no speaker was detected for 2 min; dumping the DOM");
        await this.dumpDebug("no-speaker");
      }
      if (now - lastSweepAt >= SWEEP_PERIOD_MS) {
        lastSweepAt = now;
        await adapter.sweep(ctx).catch(() => {});
      }
      if (adapter.ensureAudio && now - lastAudioCheckAt >= AUDIO_CHECK_MS) {
        // Zoom can offer computer audio late or drop it mid-meeting: without it the recording is silent.
        lastAudioCheckAt = now;
        const audio = await adapter.ensureAudio(ctx).catch(() => null);
        if (audio) {
          const detail = audio.needsJoin ? "Recording, but Zoom's computer audio is not joined: joining it again" : "Recording";
          if (detail !== this.state.detail) this.setPhase("in_meeting", detail);
        }
      }
      await sleepUnless(Math.max(20, SAMPLE_PERIOD_MS - (Date.now() - now)), this.stopController.signal);
    }
  }

  // ---------------------------------------------------------------- login mode

  async runLogin() {
    const profileDir = this.config.zoomProfileDir;
    if (!profileDir) throw new BotError("unknown", "Login mode needs zoomProfileDir in config.json");
    this.profileIsTemporary = false;
    this.selectors = resolveSelectors(null);
    this.setPhase("starting", "Starting Chrome for the Zoom sign-in");
    fs.mkdirSync(profileDir, { recursive: true });
    if (findProcesses(`--user-data-dir=${profileDir}`).length > 0) {
      throw new BotError("unknown", "Another browser is already using the Zoom profile (a login session is running?)");
    }
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(profileDir, lock), { force: true });
    await this.startBrowser({ pulse: null, profileDir, copyFrom: null });
    await this.page.goto("https://zoom.us/signin", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
      this.log("warn", "The sign-in page did not finish loading", { error: error.message.split("\n")[0] });
    });
    // Zoom's cookie banner covers the form; decline it for the user.
    await within(
      this.page.locator("#onetrust-reject-all-handler").click({ timeout: 8_000 }).then(() => this.log("info", "Declined the cookie banner")),
      9_000,
    );
    this.setPhase("joining", 'Sign in to Zoom in the live view, then press "Done"');
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let signedInAt = null;
    for (;;) {
      if (this.fatal) throw this.fatal;
      if (this.stopReason !== null || this.loginDone) break;
      const now = Date.now();
      if (signedInAt === null && (await this.zoomSignedIn())) {
        signedInAt = now;
        this.log("info", "Zoom sign-in detected");
        this.setPhase("joining", "Signed in to Zoom; saving the session");
      }
      if (signedInAt !== null && now - signedInAt >= LOGIN_FINISH_DELAY_MS) break;
      if (now >= deadline) {
        this.outcome = {
          phase: "failed",
          endReason: "waiting_timeout",
          error: { code: "auth_required", message: "Nobody signed in to Zoom within 15 minutes" },
          detail: "Sign-in session timed out",
        };
        return;
      }
      await sleepUnless(1_000, this.stopController.signal);
    }
    const signedIn = await this.zoomSignedIn();
    const why = this.loginDone ? "closed by the user" : this.stopReason !== null ? "stopped" : "finished";
    this.outcome = {
      phase: "ended",
      endReason: "stopped",
      error: null,
      detail: signedIn ? `Signed in to Zoom; session ${why}` : `Login session ${why} without a Zoom sign-in`,
    };
    this.log("info", this.outcome.detail, { signedIn });
  }

  /** Signed in = the page left /signin and a Zoom session cookie exists (DESIGN §6.6). */
  async zoomSignedIn() {
    try {
      const url = new URL(this.page.url());
      if (!/(^|\.)zoom\.(us|com)$/i.test(url.hostname)) return false;
      if (/^\/(signin|signup|login|oauth|saml|google_oauth|apple_oauth|facebook_oauth|sso)/i.test(url.pathname)) return false;
      const cookies = await this.context.cookies(["https://zoom.us", "https://app.zoom.us"]);
      return cookies.some((cookie) => SIGNED_IN_COOKIES.has(cookie.name));
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async run() {
    process.chdir(this.dir);
    const config = readJson(this.file("config.json"), null);
    if (config?.meetingId && MEETING_ID.test(config.meetingId)) this.state.meetingId = config.meetingId;
    const problems = validateConfig(config);
    if (problems.length > 0) {
      this.config = { screenshotIntervalSec: 0, mode: "meeting" };
      this.outcome = { phase: "failed", endReason: "error", error: { code: "unknown", message: `Invalid config.json: ${problems.join(", ")}` }, detail: "Invalid config.json" };
      this.log("error", this.outcome.error.message);
      this.writeTerminalState();
      return 1;
    }
    this.config = { mode: "meeting", silenceTimeoutSec: 0, zoomProfileDir: null, ...config };
    ensureDir(this.file("control"));
    this.log("info", `Bot runner started (${this.config.mode}, ${this.config.platform})`, { pid: process.pid, node: process.version, botName: this.config.botName });
    this.writeState();
    const heartbeat = setInterval(() => this.writeState(), HEARTBEAT_MS);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => this.requestStop(signal));
    process.on("uncaughtException", (error) => {
      this.log("error", "Uncaught exception", { error: error.stack ?? String(error) });
      this.setFatal(new BotError("unknown", `Internal error: ${error.message}`));
    });
    process.on("unhandledRejection", (reason) => {
      this.log("warn", "Unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
    });
    this.control = new ControlChannel({
      dir: this.dir,
      log: this.log,
      onStop: () => this.requestStop("stop.request"),
      onDebug: () => this.dumpDebug("request", { force: true }),
      execute: (cmd) => this.executeControl(cmd),
      canExecute: () => this.page !== null && !this.closing,
    });
    this.control.start();
    const shots = this.screenshotLoop();
    try {
      if (this.config.mode === "login") await this.runLogin();
      else await this.runMeeting();
      if (this.outcome === null) this.outcome = this.outcomeFromError(this.fatal ?? new StopRequested());
    } catch (error) {
      if (!(error instanceof BotError) && !(error instanceof StopRequested)) this.log("error", "Bot failed", { error: error.stack ?? String(error) });
      this.outcome = this.outcomeFromError(this.fatal ?? error);
      if (this.outcome.phase === "failed") await this.dumpDebug("failure", { force: true }).catch(() => {});
      if (this.recorder && this.page && !this.page.isClosed()) {
        this.setPhase("leaving", this.outcome.detail);
        await this.leaveSafely(PLATFORMS[this.config.platform], this.ctx).catch(() => {});
      }
    }
    clearInterval(heartbeat);
    const code = await this.cleanup();
    await within(shots, 1_000);
    return code;
  }

  writeTerminalState() {
    const outcome = this.outcome ?? { phase: "failed", endReason: "error", error: { code: "unknown", message: "The bot stopped unexpectedly" }, detail: "Stopped unexpectedly" };
    this.state.phase = outcome.phase;
    this.state.detail = outcome.detail;
    this.state.endReason = outcome.endReason;
    this.state.error = outcome.error;
    this.state.endedAt = Date.now();
    this.state.activeSpeakers = [];
    this.terminalWritten = true;
    this.writeState();
  }

  async cleanup() {
    this.closing = true;
    const watchdog = setTimeout(() => this.watchdog(), WATCHDOG_MS);
    try {
      this.control?.stop();
      if (this.recorder) await this.recorder.stop();
      const last = this.fusion?.finish(Date.now());
      if (last) appendJsonl(this.file("speakers.jsonl"), last);
      if (this.context) await within(this.context.close(), 8_000);
      if (this.profileDir) {
        const killed = await killChromeForProfile(this.profileDir);
        if (killed > 0) this.log("warn", `Killed ${killed} leftover Chrome process(es)`);
      }
      await stopXvfb(this.xvfb);
      if (this.pulse) await unloadPulseModules(this.pulse.modules, this.log);
      if (this.profileDir && this.profileIsTemporary) fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      this.log("warn", "Cleanup problem", { error: error.message });
    }
    clearTimeout(watchdog);
    this.writeTerminalState();
    this.log("info", `Bot runner finished: ${this.state.phase}${this.state.endReason ? ` (${this.state.endReason})` : ""}`, {
      error: this.state.error,
      audioSec: this.state.audio.seconds,
    });
    return this.state.phase === "ended" ? 0 : 1;
  }

  /** Cleanup hung: kill everything we own synchronously, record the outcome, and exit. */
  watchdog() {
    console.error(`${new Date().toISOString()} ERROR Cleanup hung for ${WATCHDOG_MS / 1000} s; killing the process group`);
    try {
      this.writeTerminalState();
    } catch {}
    try {
      if (this.recorder?.pid) killPid(this.recorder.pid, "SIGKILL");
      if (this.profileDir) killChromeForProfileSync(this.profileDir);
      if (this.xvfb?.process?.pid) killPid(this.xvfb.process.pid, "SIGKILL");
      for (const id of [...(this.pulse?.modules ?? [])].reverse()) spawnSync("pactl", ["unload-module", String(id)], { timeout: 2_000 });
      if (this.profileDir && this.profileIsTemporary) fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch {}
    const code = this.state.phase === "ended" ? 0 : 1;
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      // not a process-group leader
    }
    process.exit(code);
  }
}

const TERMINAL = new Set(["ended", "failed"]);

const { meetingDir } = parseArgs(process.argv.slice(2));
const runner = new BotRunner(meetingDir);
runner.run().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
