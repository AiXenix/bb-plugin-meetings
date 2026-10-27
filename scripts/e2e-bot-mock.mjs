#!/usr/bin/env node
// End-to-end test of the bot runner against the local mock meeting
// (docs/dev/DESIGN.md §6.3): real Chrome on Xvfb, real PulseAudio + ffmpeg,
// the Zoom adapter's join/sample/chat/leave code, speaker fusion.
//
// Usage: node scripts/e2e-bot-mock.mjs [profile|default|avatar|avatar-start|fixture|alone|stop|sigterm|deaf-rejoin|deaf-reload|deaf-forever|deaf-silent|deaf-capture|all] [--keep]
//   profile  copied signed-in profile; the bot is host (its Leave popover offers "End Meeting for All")
//   avatar   the avatar as the camera (host-rendered MJPEG, fake devices): it plays in the bot's tile, audio still recorded
//   avatar-start  the camera starts off in the preview and again after entering: the bot turns it on both times
//   default  built-in tone script, host ends the meeting, chat announcement
//   fixture  .e2e/fixtures/mock-script.json (Russian speech clips) when present
//   alone    everyone leaves; the bot leaves after aloneTimeoutSec
//   stop     stop.request + debug.request + remote control while recording
//   sigterm  Zoom drops computer audio mid-meeting, then SIGTERM (what the host sends on stop)
//   deaf-rejoin   indicators work but no audio reaches the bot until it leaves and rejoins computer audio
//   deaf-reload   ...until it reloads the meeting page and joins again (the recording keeps running)
//   deaf-forever  ...never: the warning (audioIssue, escalated) shows while recording, retries continue
//   deaf-silent   no false positive: a silent meeting, then a sticky indicator (screen share) over silence
//   deaf-capture  the participants' tracks carry sound but the page plays none of it (capture mode) until the
//                 bot leaves and rejoins computer audio; only the recording counts as recovered
// Every scenario runs the deaf-bot guard with short timings (E2E_DEAF_GUARD) and, unless it is a deaf
// scenario, checks that it never fired.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { E2E, ROOT, TEST_AVATAR_RGB, createMeeting, ffprobeDuration, prepareAvatar, prepareRuntime, readJsonSafe, runBot } from "./dev-bot.mjs";

const MOCK_DIR = path.join(ROOT, "runtime", "mock-meeting");
const FIXTURES = path.join(E2E, "fixtures");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg" };
const BOT_NAME = "Notetaker E2E";
const EVIDENCE = path.join(E2E, "evidence", "avatar");
const ANNOUNCEMENT = "Привет! Я записываю встречу (тест).";
/** Deaf-bot guard timings for the mock (speakerSelectors.deafGuard): a 10 s window instead of 45 s. */
const E2E_DEAF_GUARD = { windowMs: 10_000, minSpeakingMs: 4_000, minChanges: 2, captureSoundMs: 4_000, retryMs: 8_000, persistentRetryMs: 20_000, recoverySpanMs: 3_000, recoveryWindowMs: 12_000 };
const DEAF_ACTION = /^Deaf bot: (participants speak|still no meeting audio|the participants' audio)/;

// ------------------------------------------------------------------ server

function startServer() {
  const events = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/mock-meeting/log") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          events.push(JSON.parse(body));
        } catch {
          // ignore
        }
        res.writeHead(204).end();
      });
      return;
    }
    let base = null;
    let rel = null;
    if (url.pathname.startsWith("/mock-meeting/")) [base, rel] = [MOCK_DIR, url.pathname.slice("/mock-meeting/".length)];
    else if (url.pathname.startsWith("/fixtures/")) [base, rel] = [FIXTURES, url.pathname.slice("/fixtures/".length)];
    const file = base ? path.join(base, decodeURIComponent(rel || "index.html")) : null;
    if (!file || !file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, events }));
  });
}

// ------------------------------------------------------------------ checks

class Checks {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.passes = 0;
  }

  ok(condition, message, detail) {
    if (condition) {
      this.passes += 1;
      console.log(`  ok   ${message}`);
    } else {
      this.failures.push(message);
      console.log(`  FAIL ${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    }
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pcmRms(file, fromSec, toSec) {
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, Math.floor(fromSec * 16000)) * 2;
    const length = Math.max(0, Math.floor((toSec - fromSec) * 16000)) * 2;
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    let sum = 0;
    const n = Math.floor(read / 2);
    for (let i = 0; i < n; i += 1) sum += (buffer.readInt16LE(i * 2) / 32768) ** 2;
    return n === 0 ? 0 : Math.sqrt(sum / n);
  } finally {
    fs.closeSync(fd);
  }
}

function pulseModulesFor(short) {
  try {
    return execFileSync("pactl", ["list", "short", "modules"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(`mtg_${short}`));
  } catch {
    return [];
  }
}

function processesMentioning(needle) {
  const out = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmd.includes(needle)) out.push(`${entry}: ${cmd.slice(0, 160)}`);
    } catch {
      // gone
    }
  }
  return out;
}

function xvfbDisplays() {
  return processesMentioning("Xvfb").filter((line) => /Xvfb :\d+/.test(line));
}

// ------------------------------------------------------------------ scenario runner

async function runScenario(name, { port, events }, options) {
  console.log(`\n=== scenario ${name} ===`);
  const checks = new Checks(name);
  const query = new URLSearchParams(options.query ?? {});
  const url = `http://127.0.0.1:${port}/mock-meeting/index.html${query.size ? `?${query}` : ""}`;
  const { dir, config } = await createMeeting(url, {
    idPrefix: `e2e${name.slice(0, 3)}`,
    botName: BOT_NAME,
    aloneTimeoutSec: options.aloneTimeoutSec ?? 120,
    waitingTimeoutSec: 60,
    maxDurationSec: options.maxDurationSec ?? 600,
    silenceTimeoutSec: 0,
    screenshotIntervalSec: 2,
    chatAnnouncement: options.chat ?? "",
    zoomProfileDir: options.zoomProfileDir ?? null,
    avatarVideo: options.avatar ? await prepareAvatar("test", BOT_NAME) : null,
    speakerSelectors: { deafGuard: E2E_DEAF_GUARD },
  });
  const short = config.meetingId.slice(4, 16);
  console.log(`  dir ${dir}\n  url ${url}`);
  events.length = 0;
  const started = Date.now();
  const bot = runBot(dir, { echo: process.env.E2E_ECHO === "1" });
  // Every distinct state.json audioIssue seen while the bot runs (the deaf-bot warning).
  const issues = [];
  const issuePoll = setInterval(() => {
    const st = readJsonSafe(path.join(dir, "state.json"));
    if (st === null) return;
    const key = JSON.stringify(st.audioIssue ?? null);
    if (issues.at(-1)?.key !== key) issues.push({ t: Date.now(), phase: st.phase, issue: st.audioIssue ?? null, key });
  }, 300);
  if (options.during) await options.during({ dir, checks, bot, events, issues });
  const timeout = setTimeout(() => {
    console.log("  timeout: killing the bot");
    try {
      process.kill(-bot.child.pid, "SIGKILL");
    } catch {}
  }, (options.timeoutSec ?? 240) * 1000);
  const { code } = await bot.exited;
  clearTimeout(timeout);
  clearInterval(issuePoll);
  console.log(`  bot exited with ${code} after ${Math.round((Date.now() - started) / 1000)} s`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // ---- terminal state and phases
  const state = readJsonSafe(path.join(dir, "state.json"));
  const log = readJsonl(path.join(dir, "events.jsonl"));
  const phases = log.filter((e) => e.data?.phase).map((e) => e.data.phase);
  checks.ok(code === 0, "exit code 0", { code, state: state?.phase, error: state?.error });
  checks.ok(state?.phase === "ended", "final phase ended", state?.phase);
  checks.ok(state?.endReason === options.endReason, `endReason ${options.endReason}`, state?.endReason);
  const expected = ["starting", "joining", "in_meeting", "leaving"];
  checks.ok(JSON.stringify(phases) === JSON.stringify(expected), "phase sequence starting → joining → in_meeting → leaving (→ ended)", phases);
  checks.ok(state?.pid === bot.child.pid && state?.meetingId === config.meetingId, "state pid/meetingId");
  checks.ok(Number.isFinite(state?.joinedAt) && Number.isFinite(state?.recordingStartedAt) && state.recordingStartedAt >= state.joinedAt, "joinedAt ≤ recordingStartedAt");

  // ---- audio
  const ogg = path.join(dir, "audio.ogg");
  const pcm = path.join(dir, "audio.pcm");
  const pcmBytes = fs.existsSync(pcm) ? fs.statSync(pcm).size : 0;
  const pcmSec = pcmBytes / 32000;
  const oggSec = fs.existsSync(ogg) ? ffprobeDuration(ogg) : null;
  checks.ok(pcmBytes > 0 && pcmBytes % 2 === 0, "audio.pcm written (s16le)", pcmBytes);
  checks.ok(oggSec !== null && Math.abs(oggSec - pcmSec) < 0.6, "audio.ogg duration ≈ audio.pcm duration", { oggSec, pcmSec });
  checks.ok(Math.abs((state?.audio?.seconds ?? 0) - pcmSec) < 0.2 && state?.audio?.bytes === pcmBytes, "state.audio matches audio.pcm", state?.audio);
  const leftEvent = log.find((e) => /^Phase leaving/.test(e.msg));
  if (leftEvent && state?.recordingStartedAt) {
    const expectedSec = (leftEvent.t - state.recordingStartedAt) / 1000;
    checks.ok(pcmSec >= expectedSec - 0.5 && pcmSec <= expectedSec + 15, "recorded length ≈ recording start → leave", { pcmSec, expectedSec });
  }
  try {
    const codec = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "csv=p=0", ogg], { encoding: "utf8" }).trim();
    checks.ok(codec === "opus,48000,1", "audio.ogg is Opus 48 kHz mono", codec);
  } catch (error) {
    checks.ok(false, "ffprobe audio.ogg", error.message);
  }

  // ---- mock-side events
  // Deaf scenarios: only what was played after the bot could hear again, and after its recovery step
  // finished (the sampler pauses during one), is checked as audio and speakers.
  const deafOff = events.filter((e) => (e.type === "deaf" || e.type === "capture") && e.on === false).at(-1)?.t ?? Infinity;
  const recoveryDone = log.filter((e) => /^Deaf bot: .* (done|did not work)$/.test(e.msg)).map((e) => e.t).filter((t) => t <= deafOff + 120_000);
  const audibleFrom = options.deaf ? Math.max(deafOff, ...recoveryDone.filter((t) => t >= deafOff - 60_000)) : -Infinity;
  const allUtterances = events.filter((e) => e.type === "utterance").sort((a, b) => a.start - b.start);
  const utterances = allUtterances.filter((u) => u.start >= audibleFrom + 300);
  if (options.deaf) console.log(`  audible from ${Number.isFinite(audibleFrom) ? new Date(audibleFrom).toISOString() : "never"}: ${utterances.length} of ${allUtterances.length} utterances`);
  const mode = events.find((e) => e.type === "audio-mode")?.mode ?? null;
  console.log(`  mock audio mode: ${mode}; utterances: ${utterances.length}; mic: ${JSON.stringify(events.find((e) => e.type === "mic") ?? null)}`);
  checks.ok(events.some((e) => e.type === "joined" && e.name === BOT_NAME), "bot typed its name and joined", events.find((e) => e.type === "joined"));
  checks.ok(events.some((e) => e.type === "joined" && e.previewMic === "Unmute"), "bot muted the mic in the preview");
  if (!options.avatar) {
    // The no-avatar path is unchanged: camera stopped in the preview, never on.
    checks.ok(events.some((e) => e.type === "joined" && e.previewVideo === "Start Video"), "no avatar: bot stopped the camera in the preview");
    checks.ok(!events.some((e) => e.type === "camera" && e.on), "no avatar: the camera never came on", events.filter((e) => e.type === "camera"));
    checks.ok(log.some((e) => /^Camera off: /.test(e.msg)), "no avatar: the camera decision is logged");
  }
  checks.ok(events.some((e) => e.type === "popup-dismissed"), "popup sweep dismissed the tooltip");
  if (options.chat) checks.ok(events.some((e) => e.type === "chat" && e.text === options.chat), "chat announcement posted", events.filter((e) => e.type === "chat"));
  if (options.expectLeaveClick !== false) checks.ok(events.some((e) => e.type === "left"), "bot clicked Leave → Leave Meeting");
  checks.ok(mode === "webrtc", "mock audio went through WebRTC (one track per participant)", mode);

  // ---- recorded audio is the meeting audio
  if (state?.recordingStartedAt && utterances.length > 0) {
    const loud = utterances.map((u) => pcmRms(pcm, (u.start - state.recordingStartedAt) / 1000 + 0.3, (u.end - state.recordingStartedAt) / 1000 - 0.3));
    checks.ok(loud.every((r) => r > 0.02), "speech is audible in audio.pcm during every utterance", loud.map((r) => r.toFixed(3)));
    const gaps = [];
    for (let i = 0; i + 1 < utterances.length; i += 1) {
      const from = (utterances[i].end - state.recordingStartedAt) / 1000 + 0.25;
      const to = (utterances[i + 1].start - state.recordingStartedAt) / 1000 - 0.1;
      if (to - from > 0.3) gaps.push(pcmRms(pcm, from, to));
    }
    checks.ok(gaps.every((r) => r < 0.01), "gaps between utterances are quiet (alignment of recordingStartedAt)", gaps.map((r) => r.toFixed(4)));
  }

  // ---- speakers.jsonl
  const speakerLines = readJsonl(path.join(dir, "speakers.jsonl"));
  if (utterances.length > 0) {
    checks.ok(speakerLines.every((l) => Array.isArray(l.speakers) && typeof l.src === "string" && typeof l.t === "number" && typeof l.lagMs === "number"), "speakers.jsonl lines have t/speakers/src/lagMs");
    checks.ok(!speakerLines.some((l) => l.speakers.some((s) => s.toLowerCase() === BOT_NAME.toLowerCase())), "the bot never appears as a speaker");
    const errors = [];
    const order = [];
    for (const u of utterances) {
      const hit = speakerLines.find((l) => l.speakers.includes(u.speaker) && l.t - l.lagMs >= u.start - 1500 && l.t - l.lagMs <= u.end);
      if (!hit) {
        errors.push({ speaker: u.speaker, start: u.start, missing: true });
        continue;
      }
      order.push(u.speaker);
      errors.push({ speaker: u.speaker, src: hit.src, errMs: Math.round(hit.t - hit.lagMs - u.start) });
    }
    console.log(`  speaker onsets: ${JSON.stringify(errors)}`);
    checks.ok(JSON.stringify(order) === JSON.stringify(utterances.map((u) => u.speaker)), "every utterance has a speaker line, in script order", order);
    checks.ok(errors.every((e) => !e.missing && Math.abs(e.errMs) <= 700), "lag-corrected onsets within ±700 ms", errors);
    // Once a participant has talked alone for a few seconds, their WebRTC track is
    // known: every later utterance of theirs must come from the track signal.
    const repeats = errors.filter((e, i) => utterances.slice(0, i).some((u) => u.speaker === e.speaker && u.end - u.start >= 3000));
    if (mode === "webrtc" && repeats.length > 0) {
      checks.ok(repeats.every((e) => e.src === "track"), "repeat speakers are attributed by their WebRTC track (src track)", repeats);
    }
    // Offsets: every utterance end must be followed by a change away from that speaker.
    const ends = utterances.map((u) => {
      const off = speakerLines.find((l) => l.t - l.lagMs > u.start + 500 && !l.speakers.includes(u.speaker));
      return off ? Math.round(off.t - off.lagMs - u.end) : null;
    });
    // A store-sourced end can be overtaken by the next speaker's (faster) track onset,
    // so an offset may land at the next onset: allow the 1 s gap.
    checks.ok(ends.every((e) => e !== null && Math.abs(e) <= 1200), "lag-corrected offsets within ±1200 ms", ends);
  }

  // ---- roster and signals
  const roster = readJsonSafe(path.join(dir, "roster.json"));
  if (options.expectRoster) {
    checks.ok(roster && roster.count === options.expectRoster.count, `roster count ${options.expectRoster.count}`, roster);
    checks.ok(roster && JSON.stringify([...roster.names].sort()) === JSON.stringify([...options.expectRoster.names].sort()), "roster names", roster?.names);
  }
  const signals = readJsonl(path.join(dir, "signals.jsonl"));
  const spanSec = signals.length > 1 ? (signals.at(-1).t - signals[0].t) / 1000 : 0;
  checks.ok(signals.length > 0 && signals.length <= spanSec + 2, "signals.jsonl written at ≤ 1 line/s", { lines: signals.length, spanSec });
  checks.ok(fs.existsSync(path.join(dir, "screen.jpg")) && fs.readFileSync(path.join(dir, "screen.jpg")).subarray(0, 2).toString("hex") === "ffd8", "screen.jpg is a JPEG");
  // ---- deaf-bot guard: never fires in a meeting the bot hears
  if (!options.deaf) {
    checks.ok(!log.some((e) => DEAF_ACTION.test(e.msg)), "deaf-bot guard: no false positive", log.filter((e) => /^Deaf /.test(e.msg)).map((e) => e.msg));
    checks.ok(issues.every((i) => i.issue === null) && (state?.audioIssue ?? null) === null, "state.json audioIssue stayed null", issues.map((i) => i.issue));
  }
  const debugFiles = fs.existsSync(path.join(dir, "debug")) ? fs.readdirSync(path.join(dir, "debug")) : [];
  checks.ok(debugFiles.some((f) => /joined\.json$/.test(f)), "debug dump at join", debugFiles.length);
  const joinedDump = debugFiles.find((f) => /joined\.json$/.test(f));
  if (joinedDump) {
    const dump = readJsonSafe(path.join(dir, "debug", joinedDump));
    const people = options.peopleAtJoin ?? options.expectRoster?.count ?? new Set(utterances.map((u) => u.speaker)).size + 1;
    checks.ok(
      dump?.forensics?.store?.found === true && (utterances.length === 0 || dump.forensics.store.attendeesCount === people),
      "Redux-like store discovered through the React container (attendees at join)",
      { found: dump?.forensics?.store?.found, attendees: dump?.forensics?.store?.attendeesCount, people },
    );
  }

  // ---- cleanup
  checks.ok(!fs.existsSync(path.join(dir, "chrome-profile")), "temporary Chrome profile deleted");
  checks.ok(processesMentioning(dir).length === 0, "no process mentions the meeting dir", processesMentioning(dir));
  checks.ok(pulseModulesFor(short).length === 0, "PulseAudio modules unloaded", pulseModulesFor(short));
  const display = log.map((e) => /^Xvfb ready on (:\d+)/.exec(e.msg)?.[1]).find(Boolean);
  const xvfbAfter = display ? xvfbDisplays().filter((line) => line.includes(`Xvfb ${display} `)) : ["display not logged"];
  checks.ok(xvfbAfter.length === 0, `the bot's Xvfb ${display ?? "?"} is gone`, xvfbAfter);
  if (options.after) await options.after({ dir, checks, state, log, events, issues, utterances, allUtterances });
  return checks;
}

function writeControl(dir, cmd) {
  const controlDir = path.join(dir, "control");
  fs.mkdirSync(controlDir, { recursive: true });
  const tmp = path.join(controlDir, `${cmd.seq}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ t: Date.now(), ...cmd }));
  fs.renameSync(tmp, path.join(controlDir, `${cmd.seq}.json`));
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForPhase(dir, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readJsonSafe(path.join(dir, "state.json"))?.phase === phase) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// ------------------------------------------------------------------ avatar camera

/** Mean RGB of an 8x8 patch of a JPEG around (x, y). */
function pixelAt(jpg, x, y) {
  const crop = `crop=8:8:${Math.max(0, Math.round(x) - 4)}:${Math.max(0, Math.round(y) - 4)},scale=1:1:flags=area`;
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", jpg, "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...out.subarray(0, 3)];
}

const near = (a, b, tol = 45) => Array.isArray(a) && a.length >= 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** While recording: the bot's own tile plays the avatar video, and a fresh screenshot shows it. */
async function watchAvatar({ dir, checks, events }) {
  checks.ok(await waitForPhase(dir, "in_meeting", 90_000), "reached in_meeting");
  const playing = () => events.find((e) => e.type === "camera" && e.playing && e.inBotTile);
  checks.ok(await waitFor(() => playing() !== undefined, 30_000), "the bot's camera plays in its own tile", events.filter((e) => e.type === "camera"));
  const cam = playing();
  if (!cam) return;
  const shot = path.join(dir, "screen.jpg");
  const fresh = () => fs.existsSync(shot) && fs.statSync(shot).mtimeMs > cam.t + 500;
  checks.ok(await waitFor(fresh, 15_000), "a screenshot taken after the camera started");
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const kept = path.join(EVIDENCE, `mock-${path.basename(dir)}.jpg`);
  fs.copyFileSync(shot, kept);
  const px = pixelAt(kept, cam.box.x + cam.box.w / 2, cam.box.y + cam.box.h * 0.28);
  checks.ok(near(px, TEST_AVATAR_RGB), "the bot's screenshot shows the avatar in its tile", { px, expected: TEST_AVATAR_RGB, box: cam.box, kept });
}

/** After the run: decisions logged, Chrome's fake devices, the frame content, the fake (silent) mic. */
function avatarAfter({ log, checks, events }) {
  checks.ok(log.some((e) => /^Camera: the avatar video/.test(e.msg)), "the avatar camera decision is logged");
  const args = log.find((e) => e.msg === "Chrome started")?.data?.mediaArgs ?? [];
  checks.ok(
    args.includes("--use-fake-device-for-media-stream") &&
      args.some((a) => a.startsWith("--use-file-for-fake-video-capture=") && a.endsWith(".mjpeg")) &&
      args.some((a) => a.startsWith("--use-file-for-fake-audio-capture=") && a.endsWith("silence.wav")),
    "Chrome got the avatar video as its camera and silence.wav as its microphone",
    args,
  );
  checks.ok(events.some((e) => e.type === "joined" && e.previewVideo === "Stop Video"), "the camera was on in the preview when the bot clicked Join");
  const cam = events.find((e) => e.type === "camera" && e.playing);
  checks.ok(cam?.width === 1280 && cam?.height === 720, "the camera is the 1280x720 avatar video", cam && { width: cam.width, height: cam.height, label: cam.label });
  checks.ok(near(cam?.avatarColor, TEST_AVATAR_RGB), "the camera frame shows the avatar circle", cam?.avatarColor);
  checks.ok(Array.isArray(cam?.backgroundColor) && cam.backgroundColor.every((v) => v < 80), "the camera frame has the dark background", cam?.backgroundColor);
  checks.ok(log.some((e) => e.msg === "Camera is on (avatar)"), "the bot confirmed the camera is on after admission");
  const cameraWarnings = log.filter((e) => e.level === "warn" && /camera/i.test(e.msg));
  checks.ok(cameraWarnings.length === 0, "no camera warnings", cameraWarnings);
  checks.ok(log.some((e) => /^Zoom plays the meeting to the default output/.test(e.msg)), "the bot checked that the meeting plays to the recorded (default) output");
  const mic = events.find((e) => e.type === "mic");
  checks.ok(/fake/i.test(mic?.label ?? ""), "the page's microphone is Chrome's fake (silent) device", mic);
}

// ------------------------------------------------------------------ deaf-bot guard

/**
 * No meeting audio in a deaf mock recording: WebRTC comfort noise sits around -84 dBFS and the page
 * reload clicks once at about -75 dBFS for 5 ms; the mock's speech tones peak near -8 dBFS.
 */
const NO_SPEECH_PEAK = 33; // -60 dBFS

/** Max |sample| of audio.pcm (s16le). */
function pcmPeak(file) {
  const buffer = fs.readFileSync(file);
  let peak = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(i)));
  return peak;
}

const index = (log, pattern, from = 0) => log.findIndex((e, i) => i >= from && pattern.test(e.msg));

/** Common checks of a deaf scenario: detection with real evidence, decisions logged, the recording never interrupted. */
function deafCommon({ dir, log, checks, events }) {
  const detected = log.find((e) => /^Deaf bot: participants speak, but the recording is digital silence/.test(e.msg));
  checks.ok(detected?.level === "warn", "deaf bot detected (warn in events.jsonl)", detected ?? null);
  checks.ok(
    detected && detected.data.changes >= E2E_DEAF_GUARD.minChanges && detected.data.speakingSec * 1000 >= E2E_DEAF_GUARD.minSpeakingMs && (detected.data.peakDbfs ?? -Infinity) < -80 && detected.data.trackMax === 0,
    "detection evidence: speakers changing, digital silence, silent WebRTC tracks",
    detected?.data,
  );
  checks.ok(fs.readdirSync(path.join(dir, "debug")).some((f) => /-deaf\.json$/.test(f)), "debug dump at detection");
  const firstDeaf = events.find((e) => e.type === "deaf" && e.on === true);
  checks.ok(firstDeaf !== undefined, "the mock really was deaf", events.filter((e) => e.type === "deaf"));
  const endAt = events.filter((e) => e.type === "end").at(-1)?.t ?? Infinity;
  checks.ok(
    !events.some((e) => e.type === "ended-for-all") && events.filter((e) => e.type === "left").every((e) => e.t >= endAt),
    "recovery never clicked Leave Meeting / End (the only Leave is after the meeting ended)",
    events.filter((e) => ["left", "ended-for-all", "end"].includes(e.type)),
  );
}

const DEFAULT_NAMES = ["Анна Смирнова", "Борис Петров", "Вера Иванова"];
const FAKE_PROFILE = path.join(E2E, "fake-zoom-profile");

/** A stand-in for the signed-in Zoom profile: a cookie-ish file, a lock and a cache that must not be copied. */
function makeFakeProfile() {
  fs.rmSync(FAKE_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(path.join(FAKE_PROFILE, "Default", "Cache"), { recursive: true });
  fs.writeFileSync(path.join(FAKE_PROFILE, "Default", "Preferences"), JSON.stringify({ profile: { name: "zoom" }, marker: "kept" }));
  fs.writeFileSync(path.join(FAKE_PROFILE, "Default", "Cache", "big.bin"), "x");
  fs.writeFileSync(path.join(FAKE_PROFILE, "Default", "marker.txt"), "signed-in");
  fs.symlinkSync("otherhost-12345", path.join(FAKE_PROFILE, "SingletonLock"));
  return FAKE_PROFILE;
}

const SCENARIOS = {
  profile: {
    // A signed-in bot can be the host: Leave must never pick the red "End Meeting for All".
    query: { end: "ended", host: "1" },
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    zoomProfileDir: makeFakeProfile,
    after: async ({ log, checks, events }) => {
      checks.ok(!events.some((e) => e.type === "ended-for-all"), 'the host bot never clicked "End Meeting for All"');
      checks.ok(log.some((e) => /Copied the signed-in Zoom profile/.test(e.msg)), "meeting mode copied zoomProfileDir");
      checks.ok(fs.readFileSync(path.join(FAKE_PROFILE, "Default", "marker.txt"), "utf8") === "signed-in", "the persistent profile is untouched");
      checks.ok(fs.lstatSync(path.join(FAKE_PROFILE, "SingletonLock")).isSymbolicLink(), "the persistent profile keeps its own lock");
    },
  },
  default: {
    query: {},
    chat: ANNOUNCEMENT,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
  },
  avatar: {
    // The camera takes 4 s to start (Zoom disables the button meanwhile, seen live 2026-10-13).
    query: { end: "ended", cameraDelaySec: "4" },
    avatar: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    during: watchAvatar,
    after: async (ctx) => avatarAfter(ctx),
  },
  "avatar-start": {
    // The preview offers the camera off and the meeting starts with it off again: the bot presses Start Video both times.
    query: { end: "ended", previewVideo: "off", joinVideo: "off" },
    avatar: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    during: watchAvatar,
    after: async (ctx) => {
      avatarAfter(ctx);
      const { log, checks, events } = ctx;
      checks.ok(log.some((e) => e.msg === "Started the camera in the preview (avatar)"), "pressed Start Video in the preview");
      checks.ok(log.some((e) => e.msg === "Starting the camera (avatar)"), "pressed Start Video in the meeting footer");
      checks.ok(events.some((e) => e.type === "video-button" && e.on === true), "the mock saw the footer Start Video click");
    },
  },
  fixture: {
    query: { script: "/fixtures/mock-script.json" },
    endReason: "meeting_ended",
    timeoutSec: 600,
    available: () => fs.existsSync(path.join(FIXTURES, "mock-script.json")),
    roster: () => {
      const items = readJsonSafe(path.join(FIXTURES, "mock-script.json")) ?? [];
      const names = [...new Set(items.map((i) => i.speaker))];
      return { count: names.length + 1, names };
    },
  },
  alone: {
    query: { end: "alone" },
    aloneTimeoutSec: 10,
    endReason: "alone",
    peopleAtJoin: 4,
    expectRoster: { count: 1, names: [] },
  },
  stop: {
    query: { end: "none" },
    endReason: "stopped",
    during: async ({ dir, checks }) => {
      const joined = await waitForPhase(dir, "in_meeting", 90_000);
      checks.ok(joined, "reached in_meeting");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // live view: viewer.json → screenshot every second
      fs.writeFileSync(path.join(dir, "viewer.json"), JSON.stringify({ until: Date.now() + 6_000 }));
      const before = fs.existsSync(path.join(dir, "screen.jpg")) ? fs.statSync(path.join(dir, "screen.jpg")).mtimeMs : 0;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const after = fs.existsSync(path.join(dir, "screen.jpg")) ? fs.statSync(path.join(dir, "screen.jpg")).mtimeMs : 0;
      checks.ok(after > before, "viewer.json makes the bot screenshot every second");
      // remote control: open the chat panel by clicking its footer button, type, Enter
      writeControl(dir, { seq: 1, action: "click", x: 0, y: 0 });
      writeControl(dir, { seq: 2, action: "key", key: "Escape" });
      writeControl(dir, { seq: 3, action: "bogus" });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const ack = readJsonSafe(path.join(dir, "control", "ack.json"));
      checks.ok(ack?.seq === 3 && ack.ok === false, "control commands executed in order and acknowledged", ack);
      fs.writeFileSync(path.join(dir, "debug.request"), "");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      checks.ok(!fs.existsSync(path.join(dir, "debug.request")), "debug.request consumed");
      const requested = fs.readdirSync(path.join(dir, "debug")).filter((f) => /request\.(json|jpg|html)$/.test(f));
      checks.ok(requested.length >= 3, "debug.request dumped json/html/jpg", requested);
      fs.writeFileSync(path.join(dir, "stop.request"), "");
    },
    after: async ({ log, checks }) => {
      checks.ok(log.some((e) => /stop\.request found/.test(e.msg)), "stop.request noticed");
    },
    expectRoster: { count: 4, names: DEFAULT_NAMES },
  },
  sigterm: {
    query: { end: "none", audioDropSec: "4" },
    endReason: "stopped",
    during: async ({ dir, checks, bot, events }) => {
      checks.ok(await waitForPhase(dir, "in_meeting", 90_000), "reached in_meeting");
      const dropped = () => events.findIndex((e) => e.type === "audio-dropped");
      const rejoined = () => events.findIndex((e, i) => e.type === "audio-joined" && dropped() >= 0 && i > dropped());
      const remuted = () => events.some((e, i) => e.type === "audio-button" && e.state === "muted" && rejoined() >= 0 && i > rejoined());
      checks.ok(await waitFor(() => dropped() >= 0, 30_000), "the mock dropped computer audio");
      checks.ok(await waitFor(() => rejoined() >= 0, 30_000), "the bot joined computer audio again");
      checks.ok(await waitFor(remuted, 15_000), "the bot muted its microphone again");
      process.kill(bot.child.pid, "SIGTERM");
    },
    after: async ({ log, checks }) => {
      checks.ok(log.some((e) => e.msg === "Stop requested (SIGTERM)"), "SIGTERM noticed");
      checks.ok(log.some((e) => e.msg === "Left the meeting"), "left through the Leave popover (Chrome still open after SIGTERM)");
      checks.ok(!log.some((e) => /Chrome closed|^Fatal/.test(e.msg)), "no Chrome-closed fatal", log.filter((e) => /Chrome closed|^Fatal/.test(e.msg)));
      const details = log.map((e) => e.msg);
      const off = details.findIndex((m) => /computer audio is not joined: joining it again/.test(m));
      checks.ok(off >= 0 && details.slice(off + 1).includes("Recording"), "state.detail flagged the missing computer audio, then went back to Recording");
    },
    expectRoster: { count: 4, names: DEFAULT_NAMES },
  },
  "deaf-rejoin": {
    // Deaf until "More audio controls" → "Leave Computer Audio" → Join Audio; Zoom also plays to a non-default speaker.
    query: { deaf: "rejoin", loops: "3", speaker: "other" },
    deaf: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    timeoutSec: 300,
    after: async (ctx) => {
      const { log, checks, events, issues, state, utterances } = ctx;
      deafCommon(ctx);
      const left = events.findIndex((e) => e.type === "audio-left");
      checks.ok(left >= 0, "the bot pressed Leave Computer Audio in the audio menu");
      checks.ok(events.some((e, i) => e.type === "audio-joined" && i > left), "then joined computer audio again");
      checks.ok(events.some((e) => e.type === "speaker-selected" && e.deviceId === "default"), "picked the default speaker (Same as System)");
      checks.ok(events.some((e) => e.type === "deaf" && e.on === false && /rejoined/.test(e.why)), "the mock delivered audio again after the rejoin");
      checks.ok(events.filter((e) => e.type === "joined").length === 1, "no page reload was needed");
      const recovered = index(log, /^Audio recovered after/);
      checks.ok(recovered > index(log, /^Deaf bot: rejoining the meeting audio done/), "\"Audio recovered\" logged after the rejoin", log.filter((e) => /^(Deaf|Audio recovered)/.test(e.msg)).map((e) => e.msg));
      checks.ok(issues.some((i) => i.issue && i.issue.escalated === false && /^Бот не слышит участников встречи/.test(i.issue.message)), "state.json showed the issue while recovering", issues.map((i) => i.issue));
      checks.ok(!issues.some((i) => i.issue?.escalated), "never escalated to the warning");
      checks.ok(issues.at(-1)?.issue === null && (state?.audioIssue ?? null) === null, "the issue cleared after recovery");
      checks.ok(utterances.length >= 6, "speech after the recovery was checked in audio.pcm", utterances.length);
      checks.ok(log.some((e) => e.msg === "Picked the default speaker in Zoom's audio menu: Same as System"), "the speaker choice is logged");
    },
  },
  "deaf-reload": {
    // Rejoining audio does not help; only a reloaded page (the second load in this tab) hears the meeting.
    query: { deaf: "reload", loops: "2" },
    deaf: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    timeoutSec: 300,
    after: async (ctx) => {
      const { log, checks, events, issues, state, utterances } = ctx;
      deafCommon(ctx);
      const steps = log.filter((e) => /^Deaf bot: (participants speak|still no meeting audio)/.test(e.msg)).map((e) => e.data?.action ?? null);
      checks.ok(JSON.stringify(steps.slice(0, 3)) === JSON.stringify(["rejoin_audio", "rejoin_audio", "reload"]), "ladder: rejoin, rejoin, reload", steps);
      checks.ok(events.filter((e) => e.type === "audio-left").length >= 2, "both audio rejoins ran in the mock");
      const joins = events.filter((e) => e.type === "joined");
      checks.ok(joins.length === 2, "the bot joined the reloaded page through the normal join flow", joins.length);
      checks.ok(events.some((e) => e.type === "deaf" && e.on === false && e.loads === 2), "the reloaded page delivered audio");
      checks.ok(log.some((e) => /^Rejoined the meeting after the page reload/.test(e.msg)), "rejoin after the reload logged");
      checks.ok(index(log, /^Audio recovered after/) > index(log, /^Rejoined the meeting after the page reload/), "\"Audio recovered\" after the reload");
      checks.ok(state?.joinedAt < joins[1]?.t, "state.joinedAt stays the first join");
      checks.ok(issues.some((i) => i.issue && /перезагружаю страницу встречи/.test(i.issue.message)), "the issue said the page is being reloaded", issues.map((i) => i.issue?.message));
      checks.ok(!issues.some((i) => i.issue?.escalated), "never escalated to the warning");
      checks.ok((state?.audioIssue ?? null) === null, "the issue cleared after recovery");
      checks.ok(utterances.length >= 6, "speech after the reload was checked in audio.pcm", utterances.length);
    },
  },
  "deaf-forever": {
    // Nothing helps: the escalated warning shows while the meeting runs, rejoins continue, the final state keeps it.
    query: { deaf: "forever", loops: "3" },
    deaf: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    timeoutSec: 360,
    after: async (ctx) => {
      const { log, checks, events, issues, state, dir } = ctx;
      deafCommon(ctx);
      const escalated = issues.find((i) => i.issue?.escalated === true);
      checks.ok(escalated?.phase === "in_meeting", "the escalated warning appeared while recording", issues.map((i) => [i.phase, i.issue?.escalated]));
      checks.ok(
        /^Бот не слышит участников встречи/.test(escalated?.issue?.message ?? "") &&
          /Автоматически пробовали: переподключить звук встречи \(2 раза\), перезагрузить страницу встречи \(1 раз\)/.test(escalated?.issue?.message ?? ""),
        "the warning says what was tried",
        escalated?.issue?.message,
      );
      const warn = index(log, /^Deaf bot: still no meeting audio after 3 recovery attempt/);
      checks.ok(warn >= 0 && log[warn].level === "warn", "warning decision logged");
      checks.ok(index(log, /^Deaf bot: still no meeting audio; rejoining the meeting audio again/, warn) > warn, "kept rejoining the audio after the warning");
      checks.ok(!log.some((e) => /^Audio recovered/.test(e.msg)), "never claimed recovery");
      checks.ok(events.filter((e) => e.type === "joined").length === 2, "one page reload");
      checks.ok(state?.audioIssue?.escalated === true && /^Бот не слышал участников встречи до конца записи/.test(state.audioIssue.message), "the final state keeps the issue (past tense)", state?.audioIssue);
      const peak = pcmPeak(path.join(dir, "audio.pcm"));
      checks.ok(peak <= NO_SPEECH_PEAK, "audio.pcm has no meeting audio, peak below -60 dBFS (the mock never played to the bot)", peak);
    },
  },
  "deaf-capture": {
    // The tracks carry everyone's sound, the page plays none of it: detected without the indicators' help,
    // the tracks never pass for a recovery, "Leave Computer Audio" + Join Audio brings the playback back.
    query: { capture: "rejoin", loops: "3" },
    deaf: true,
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    timeoutSec: 300,
    after: async ({ dir, log, checks, events, issues, state, utterances }) => {
      const detected = log.find((e) => /^Deaf bot: the participants' audio tracks carry sound, but the recording is digital silence \(capture\)/.test(e.msg));
      checks.ok(detected?.level === "warn", "capture detected (warn in events.jsonl)", log.filter((e) => /^Deaf /.test(e.msg)).map((e) => e.msg));
      checks.ok(
        detected?.data?.reason === "capture" && detected.data.trackSoundSec * 1000 >= E2E_DEAF_GUARD.captureSoundMs && detected.data.trackMax >= 0.01 && (detected.data.peakDbfs ?? -Infinity) < -80,
        "detection evidence: sounding tracks, digital silence in the recording",
        detected?.data,
      );
      checks.ok(fs.readdirSync(path.join(dir, "debug")).some((f) => /-deaf\.json$/.test(f)), "debug dump at detection");
      checks.ok(events.some((e) => e.type === "capture" && e.on === true), "the mock really played nothing", events.filter((e) => e.type === "capture"));
      const left = events.findIndex((e) => e.type === "audio-left");
      checks.ok(left >= 0 && events.some((e, i) => e.type === "audio-joined" && i > left), "the bot left and joined computer audio again");
      const fixedAt = events.find((e) => e.type === "capture" && e.on === false)?.t ?? Infinity;
      checks.ok(Number.isFinite(fixedAt), "the mock played the meeting again after the rejoin");
      const recovered = log.find((e) => /^Audio recovered after .* in the recording/.test(e.msg));
      checks.ok(recovered && recovered.t >= fixedAt && /^recording/.test(recovered.data?.by ?? ""), "\"Audio recovered\" only once the recording had sound (the tracks never counted)", recovered ?? null);
      checks.ok(!log.some((e) => /^Audio recovered/.test(e.msg) && e.t < fixedAt), "no recovery claimed while only the tracks had sound");
      checks.ok(
        issues.some((i) => i.issue && i.issue.reason === "capture" && i.issue.escalated === false && /^Бот слышит участников, но звук не попадает в запись\./.test(i.issue.message)),
        "state.json showed the capture issue while recovering",
        issues.map((i) => i.issue),
      );
      checks.ok(!issues.some((i) => i.issue?.escalated), "never escalated to the warning");
      checks.ok(issues.at(-1)?.issue === null && (state?.audioIssue ?? null) === null, "the issue cleared after recovery");
      checks.ok(events.filter((e) => e.type === "joined").length === 1, "no page reload was needed");
      const endAt = events.filter((e) => e.type === "end").at(-1)?.t ?? Infinity;
      checks.ok(
        !events.some((e) => e.type === "ended-for-all") && events.filter((e) => e.type === "left").every((e) => e.t >= endAt),
        "recovery never clicked Leave Meeting / End",
        events.filter((e) => ["left", "ended-for-all", "end"].includes(e.type)),
      );
      checks.ok(utterances.length >= 6, "speech after the recovery was checked in audio.pcm", utterances.length);
    },
  },
  "deaf-silent": {
    // No false positive: 20 s of a silent meeting with nobody lit, then a sticky indicator over silence.
    query: { silent: "1", sticky: "Анна Смирнова", stickyAfterSec: "20", loops: "2" },
    endReason: "meeting_ended",
    expectRoster: { count: 4, names: DEFAULT_NAMES },
    after: async ({ log, checks, events, dir }) => {
      checks.ok(events.some((e) => e.type === "sticky"), "the mock lit a sticky indicator");
      checks.ok(log.some((e) => /^Deaf guard: the recording is silent, but nobody is speaking: not deaf/.test(e.msg)), "decision logged: silent meeting, nobody speaking");
      checks.ok(log.some((e) => /^Deaf guard: the recording is silent, but the speaker indicator does not change \(sticky\): not deaf/.test(e.msg)), "decision logged: sticky indicator");
      const peak = pcmPeak(path.join(dir, "audio.pcm"));
      checks.ok(peak <= NO_SPEECH_PEAK, "audio.pcm has no meeting audio (peak below -60 dBFS)", peak);
      const sticky = readJsonl(path.join(dir, "speakers.jsonl")).filter((l) => l.speakers.includes("Анна Смирнова"));
      checks.ok(sticky.length === 1, "the sticky indicator was one speaker line", sticky);
    },
  },
};

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const which = args[0] ?? "all";
  const names = which === "all" ? Object.keys(SCENARIOS) : which.split(",");
  prepareRuntime({ quiet: true });
  const server = await startServer();
  console.log(`mock meeting served on http://127.0.0.1:${server.port}/mock-meeting/`);
  const results = [];
  try {
    for (const name of names) {
      const scenario = SCENARIOS[name];
      if (!scenario) throw new Error(`unknown scenario ${name}`);
      if (scenario.available && !scenario.available()) {
        console.log(`\n=== scenario ${name}: skipped (fixture missing) ===`);
        continue;
      }
      const options = {
        ...scenario,
        expectRoster: scenario.expectRoster ?? scenario.roster?.(),
        zoomProfileDir: typeof scenario.zoomProfileDir === "function" ? scenario.zoomProfileDir() : scenario.zoomProfileDir,
      };
      results.push(await runScenario(name, server, options));
    }
  } finally {
    server.server.close();
  }
  console.log("\n=== summary ===");
  let failed = 0;
  for (const r of results) {
    console.log(`${r.failures.length === 0 ? "PASS" : "FAIL"} ${r.name}: ${r.passes} ok, ${r.failures.length} failed${r.failures.length ? ` (${r.failures.join("; ")})` : ""}`);
    failed += r.failures.length;
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
