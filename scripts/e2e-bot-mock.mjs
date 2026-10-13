#!/usr/bin/env node
// End-to-end test of the bot runner against the local mock meeting
// (docs/dev/DESIGN.md §6.3): real Chrome on Xvfb, real PulseAudio + ffmpeg,
// the Zoom adapter's join/sample/chat/leave code, speaker fusion.
//
// Usage: node scripts/e2e-bot-mock.mjs [profile|default|fixture|alone|stop|sigterm|all] [--keep]
//   profile  copied signed-in profile; the bot is host (its Leave popover offers "End Meeting for All")
//   default  built-in tone script, host ends the meeting, chat announcement
//   fixture  .e2e/fixtures/mock-script.json (Russian speech clips) when present
//   alone    everyone leaves; the bot leaves after aloneTimeoutSec
//   stop     stop.request + debug.request + remote control while recording
//   sigterm  Zoom drops computer audio mid-meeting, then SIGTERM (what the host sends on stop)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { E2E, ROOT, createMeeting, ffprobeDuration, prepareRuntime, readJsonSafe, runBot } from "./dev-bot.mjs";

const MOCK_DIR = path.join(ROOT, "runtime", "mock-meeting");
const FIXTURES = path.join(E2E, "fixtures");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg" };
const BOT_NAME = "Notetaker E2E";
const ANNOUNCEMENT = "Привет! Я записываю встречу (тест).";

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
  });
  const short = config.meetingId.slice(4, 16);
  console.log(`  dir ${dir}\n  url ${url}`);
  events.length = 0;
  const started = Date.now();
  const bot = runBot(dir, { echo: process.env.E2E_ECHO === "1" });
  if (options.during) await options.during({ dir, checks, bot, events });
  const timeout = setTimeout(() => {
    console.log("  timeout: killing the bot");
    try {
      process.kill(-bot.child.pid, "SIGKILL");
    } catch {}
  }, (options.timeoutSec ?? 240) * 1000);
  const { code } = await bot.exited;
  clearTimeout(timeout);
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
  const utterances = events.filter((e) => e.type === "utterance").sort((a, b) => a.start - b.start);
  const mode = events.find((e) => e.type === "audio-mode")?.mode ?? null;
  console.log(`  mock audio mode: ${mode}; utterances: ${utterances.length}; mic: ${JSON.stringify(events.find((e) => e.type === "mic") ?? null)}`);
  checks.ok(events.some((e) => e.type === "joined" && e.name === BOT_NAME), "bot typed its name and joined", events.find((e) => e.type === "joined"));
  checks.ok(events.some((e) => e.type === "joined" && e.previewMic === "Unmute"), "bot muted the mic in the preview");
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
  if (options.after) await options.after({ dir, checks, state, log, events });
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
