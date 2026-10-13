// Shared fixtures for the host tests: a temp <hostData> with a fake runtime
// (a bot runner and a transcriber stub that write the real state files and
// sleep), config builders, polling, and process cleanup.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostPaths, type HostPaths } from "../src/host/paths.js";
import { killMeetingProcesses } from "../src/host/processes.js";
import type { BotConfig } from "../src/shared/runtime-files.js";

/**
 * Fake bot runner. Behavior comes from config.botName:
 *   normal   — in_meeting until SIGTERM or stop.request, then ended/stopped
 *   crash    — dies with exit 3 after 300 ms without a terminal state
 *   stubborn — ignores SIGTERM and stop.request (needs SIGKILL)
 * Each starts a `sleep` child in its process group with cwd = meeting dir,
 * standing in for Chrome/Xvfb/ffmpeg.
 */
export const FAKE_BOT = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[process.argv.indexOf("--meeting-dir") + 1];
const file = (name) => path.join(dir, name);
const config = JSON.parse(fs.readFileSync(file("config.json"), "utf8"));
const behavior = config.botName;
const startedAt = Date.now();
let state = {
  version: 1, meetingId: config.meetingId, pid: process.pid, phase: "in_meeting", detail: "fake bot",
  startedAt, joinedAt: startedAt, recordingStartedAt: startedAt, endedAt: null, endReason: null, error: null,
  participants: { count: 2, names: ["Анна", "Борис"] }, activeSpeakers: [], audio: { seconds: 0, bytes: 0 }, updatedAt: startedAt,
};
function writeState(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
  fs.writeFileSync(file("state.json.tmp"), JSON.stringify(state));
  fs.renameSync(file("state.json.tmp"), file("state.json"));
}
writeState({});
fs.mkdirSync(file("chrome-profile/Default"), { recursive: true });
console.log("fake bot " + behavior + " pid " + process.pid + " hostData " + process.env.MEETINGS_HOST_DATA);
const child = spawn("sleep", ["300"], { cwd: dir, stdio: "ignore" });
fs.writeFileSync(file("child.pid"), String(child.pid));

if (behavior === "crash") {
  setTimeout(() => { console.error("FATAL: simulated crash"); process.exit(3); }, 300);
}
let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  child.kill("SIGKILL");
  writeState({ phase: "ended", endReason: "stopped", endedAt: Date.now(), detail: reason });
  process.exit(0);
}
process.on("SIGTERM", () => {
  if (behavior === "stubborn") console.log("ignoring SIGTERM");
  else stop("SIGTERM");
});
setInterval(() => {
  if (behavior !== "stubborn" && fs.existsSync(file("stop.request"))) stop("stop.request");
  if (fs.existsSync(file("debug.request"))) {
    fs.mkdirSync(file("debug"), { recursive: true });
    fs.writeFileSync(file("debug/dump.json"), "{}");
    fs.unlinkSync(file("debug.request"));
  }
}, 100);
`;

/** Fake transcriber: records how it was started, then sleeps (live) or writes a final transcript (offline). */
export const FAKE_TRANSCRIBER = `
import json, os, signal, sys, time
argv = sys.argv
d = argv[argv.index("--meeting-dir") + 1]
mode = argv[argv.index("--mode") + 1]
def write(name, obj):
    tmp = os.path.join(d, name + ".tmp")
    with open(tmp, "w") as f:
        f.write(json.dumps(obj))
    os.replace(tmp, os.path.join(d, name))
with open(os.path.join(d, "transcriber-runs.jsonl"), "a") as f:
    f.write(json.dumps({"pid": os.getpid(), "argv": argv[1:], "isolated": sys.flags.isolated,
                        "hostData": os.environ.get("MEETINGS_HOST_DATA"), "cwd": os.getcwd()}) + "\\n")
now = int(time.time() * 1000)
state = {"version": 1, "pid": os.getpid(), "mode": mode, "phase": "live" if mode == "live" else "finalizing",
         "detail": "fake", "processedSec": 0, "audioSec": 0, "segments": 0,
         "checkpoint": {"samples": 0, "nextId": 0}, "error": None, "startedAt": now, "updatedAt": now, "finishedAt": None}
write("transcriber.json", state)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
if mode == "offline":
    if os.path.exists(os.path.join(d, "fake-transcriber-slow")):
        time.sleep(300)
    seg = {"id": 0, "start": 0.0, "end": 1.0, "speakerKey": "unknown", "speaker": "Неизвестный", "source": "none", "text": "привет"}
    write("transcript.json", {"version": 1, "meetingId": os.path.basename(d), "audioSec": 1.0, "createdAt": now,
                              "asr": {"engine": "gigaam", "model": None}, "diarization": "ui+acoustic",
                              "speakers": [], "segments": [seg]})
    state.update(phase="done", finishedAt=now)
    write("transcriber.json", state)
    sys.exit(0)
time.sleep(300)
`;

const created: string[] = [];

export async function tempDir(prefix = "meetings-host-"): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Kill whatever the tests started inside temp data dirs, then remove them. */
export async function cleanupTempDirs(): Promise<void> {
  for (const dir of created.splice(0)) {
    const meetings = path.join(dir, "meetings");
    for (const name of await fs.readdir(meetings).catch(() => [] as string[])) {
      await killMeetingProcesses(path.join(meetings, name)).catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function fakeHostData(options: { readonly runtime?: boolean } = {}): Promise<{
  dataDir: string;
  tempDir: string;
  paths: HostPaths;
}> {
  const dataDir = await tempDir();
  const paths = hostPaths(dataDir);
  if (options.runtime ?? true) await installFakeRuntime(paths);
  return { dataDir, tempDir: await tempDir("meetings-host-tmp-"), paths };
}

export async function installFakeRuntime(paths: HostPaths): Promise<void> {
  await fs.mkdir(path.dirname(paths.botScript), { recursive: true });
  await fs.mkdir(path.dirname(paths.transcriberScript), { recursive: true });
  await fs.writeFile(paths.botScript, FAKE_BOT);
  await fs.writeFile(paths.transcriberScript, FAKE_TRANSCRIBER);
  await fs.writeFile(paths.runtimeReady, "{}\n");
  // The bot is only started when playwright-core resolves from the runtime dir.
  const playwright = path.join(paths.runtime, "node_modules", "playwright-core");
  await fs.mkdir(playwright, { recursive: true });
  await fs.writeFile(path.join(playwright, "package.json"), JSON.stringify({ name: "playwright-core", version: "0.0.0-fake" }));
  await fs.mkdir(path.dirname(paths.venvPython), { recursive: true });
  await fs.symlink("/usr/bin/python3", paths.venvPython);
  await fs.mkdir(paths.models, { recursive: true });
}

export function newMeetingId(): string {
  return `mtg_${randomBytes(6).toString("hex")}`;
}

export function botConfig(meetingId: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    version: 1,
    meetingId,
    mode: "meeting",
    platform: "zoom",
    url: "https://zoom.us/j/81234567890?pwd=abc",
    joinUrl: "https://app.zoom.us/wc/81234567890/join?pwd=abc",
    meetingNumber: "81234567890",
    passcode: "abc",
    botName: "normal",
    maxDurationSec: 3600,
    aloneTimeoutSec: 120,
    waitingTimeoutSec: 600,
    silenceTimeoutSec: 0,
    screenshotIntervalSec: 10,
    chatAnnouncement: "",
    speakerSelectors: null,
    chromePath: "/usr/bin/google-chrome-stable",
    zoomProfileDir: null,
    liveTranscription: true,
    transcriber: { gigaamUrl: "http://127.0.0.1:1", diarization: "ui+acoustic", speakerLagMs: 700, keepRawAudio: false, threads: 2 },
    createdAt: Date.now(),
    ...overrides,
  };
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill(0); it is dead for our purposes.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
