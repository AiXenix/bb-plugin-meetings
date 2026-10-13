// Audio/video plumbing for one bot (docs/dev/DESIGN.md §6.1): a per-meeting
// PulseAudio null sink that Chrome plays into (recorded by ffmpeg), a silent
// microphone Chrome can open, and a private Xvfb display.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { BotError, findProcesses, isAlive, killPid, run, sleep } from "./proc.mjs";

// ---------------------------------------------------------------- PulseAudio

/** Make sure a user PulseAudio server answers; start one when none does. */
export async function ensurePulse(log) {
  const probe = async () => {
    try {
      return (await run("pactl", ["info"], { timeoutMs: 5_000 })).code === 0;
    } catch (error) {
      if (error.code === "ENOENT") throw new BotError("dependency_missing", "pactl is not installed (apt install pulseaudio-utils)");
      return false;
    }
  };
  if (await probe()) return;
  log("info", "No PulseAudio server answers; starting one");
  try {
    // --start daemonizes; ignore its stdio so we do not wait for the daemon.
    await new Promise((resolve, reject) => {
      const child = spawn("pulseaudio", ["--start", "--exit-idle-time=-1"], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", resolve);
    });
  } catch (error) {
    throw new BotError("dependency_missing", `Cannot start PulseAudio: ${error.message}`);
  }
  for (let i = 0; i < 20; i += 1) {
    if (await probe()) return;
    await sleep(250);
  }
  throw new BotError("dependency_missing", "PulseAudio did not start (pulseaudio --start)");
}

async function pactl(args) {
  const result = await run("pactl", args, { timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error(`pactl ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

/** Pulse object names for one meeting. `short` is [a-z0-9]{6,12}. */
export function pulseNames(short) {
  return {
    sink: `mtg_${short}`,
    micSink: `mtg_${short}_micsink`,
    mic: `mtg_${short}_mic`,
  };
}

/**
 * Load the capture sink and the silent microphone. Chrome ignores monitor
 * sources, so the mic is a remap of a silent null sink's monitor
 * (docs/dev/research-zoom-probe.md).
 */
export async function loadPulseModules(short, log) {
  const names = pulseNames(short);
  await unloadModulesMatching(new RegExp(`=mtg_${short}(_|\\b|\\.)`), log);
  const modules = [];
  try {
    const load = async (args) => {
      const id = Number((await pactl(["load-module", ...args])).trim());
      if (!Number.isInteger(id)) throw new Error(`pactl load-module ${args[0]} returned no module index`);
      modules.push(id);
      return id;
    };
    await load([
      "module-null-sink",
      `sink_name=${names.sink}`,
      "rate=48000",
      `sink_properties=device.description=${names.sink}`,
    ]);
    await load([
      "module-null-sink",
      `sink_name=${names.micSink}`,
      "rate=48000",
      "channels=1",
      `sink_properties=device.description=${names.micSink}`,
    ]);
    await load([
      "module-remap-source",
      `master=${names.micSink}.monitor`,
      `source_name=${names.mic}`,
      `source_properties=device.description=${names.mic}`,
    ]);
  } catch (error) {
    await unloadPulseModules(modules, log);
    throw new BotError("dependency_missing", `Cannot create PulseAudio devices: ${error.message}`);
  }
  log("info", "PulseAudio devices ready", { ...names, modules });
  return { ...names, modules };
}

export async function unloadPulseModules(ids, log) {
  // Reverse order: the remap source depends on the mic sink.
  for (const id of [...ids].reverse()) {
    try {
      await pactl(["unload-module", String(id)]);
    } catch (error) {
      log?.("warn", `Could not unload PulseAudio module ${id}`, { error: error.message });
    }
  }
}

async function listModules() {
  try {
    return (await pactl(["list", "short", "modules"]))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, name, args = ""] = line.split("\t");
        return { id: Number(id), name, args };
      });
  } catch {
    return [];
  }
}

async function unloadModulesMatching(pattern, log) {
  const stale = (await listModules()).filter((m) => pattern.test(m.args));
  if (stale.length > 0) {
    log?.("info", "Unloading leftover PulseAudio modules", { modules: stale.map((m) => m.id) });
    await unloadPulseModules(stale.map((m) => m.id), log);
  }
}

/**
 * Unload mtg_* modules whose meeting has no live process any more (a bot that
 * was SIGKILLed cannot clean up after itself). A module is in use while any
 * process command line mentions `mtg_<short>` (bot, Chrome profile, ffmpeg).
 */
export async function gcStalePulseModules(ownShort, log) {
  const modules = await listModules();
  const byShort = new Map();
  for (const m of modules) {
    const match = /(?:sink_name|source_name|master)=mtg_([a-z0-9]+?)(?:_micsink|_mic)?(?:\.monitor)?(?:\s|$)/.exec(m.args);
    if (match === null || match[1] === ownShort) continue;
    if (!byShort.has(match[1])) byShort.set(match[1], []);
    byShort.get(match[1]).push(m.id);
  }
  for (const [short, ids] of byShort) {
    if (findProcesses(`mtg_${short}`).length > 0) continue;
    log("info", `Unloading stale PulseAudio modules of mtg_${short}`, { modules: ids });
    await unloadPulseModules(ids, log);
  }
}

// ---------------------------------------------------------------- Xvfb

const X_LOCK = (n) => `/tmp/.X${n}-lock`;
const X_SOCKET = (n) => `/tmp/.X11-unix/X${n}`;

function lockOwner(n) {
  try {
    return Number(fs.readFileSync(X_LOCK(n), "utf8").trim());
  } catch {
    return null;
  }
}

/**
 * Start Xvfb on a free display >= :100. Two bots can race for the same
 * number: Xvfb takes the lock file atomically and the loser exits, so we just
 * try the next number.
 */
export async function startXvfb({ width, height, log }) {
  const base = 100 + (process.pid % 97);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const n = 100 + ((base - 100 + attempt) % 400);
    if (fs.existsSync(X_LOCK(n)) || fs.existsSync(X_SOCKET(n))) continue;
    let child;
    try {
      // -terminate: exit when the last client (Chrome) disconnects, so a
      // SIGKILLed bot does not leave the display behind.
      child = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-terminate"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      throw new BotError("dependency_missing", `Cannot start Xvfb: ${error.message}`);
    }
    let stderr = "";
    let exited = false;
    let spawnError = null;
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      spawnError = error;
      exited = true;
    });
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      if (fs.existsSync(X_SOCKET(n)) && lockOwner(n) === child.pid) {
        log("info", `Xvfb ready on :${n}`, { pid: child.pid });
        return { display: `:${n}`, number: n, process: child };
      }
      await sleep(50);
    }
    if (spawnError?.code === "ENOENT") throw new BotError("dependency_missing", "Xvfb is not installed (apt install xvfb)");
    if (!exited) {
      child.kill("SIGKILL");
      throw new BotError("dependency_missing", `Xvfb :${n} did not start within 10 s: ${stderr.trim().slice(-300)}`);
    }
    log("debug", `Xvfb :${n} unavailable, trying the next display`, { stderr: stderr.trim().slice(-200) });
  }
  throw new BotError("dependency_missing", "No free X display found in :100-:499");
}

export async function stopXvfb(xvfb) {
  if (!xvfb?.process) return;
  const { pid } = xvfb.process;
  if (xvfb.process.exitCode !== null || xvfb.process.signalCode !== null) return;
  killPid(pid, "SIGTERM");
  for (let i = 0; i < 30 && isAlive(pid); i += 1) await sleep(100);
  if (isAlive(pid)) killPid(pid, "SIGKILL");
}

/** Send a key to the X display (dismisses Chrome's native "Open xdg-open?" dialog). */
export async function xdotoolKey(display, key) {
  try {
    const result = await run("xdotool", ["key", "--clearmodifiers", key], {
      timeoutMs: 5_000,
      env: { ...process.env, DISPLAY: display },
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ffmpeg

const PCM_BYTES_PER_SEC = 32_000; // s16le 16 kHz mono

/**
 * One ffmpeg process, one PulseAudio input, two outputs: audio.ogg (Opus, the
 * archive) and audio.pcm (s16le 16 kHz mono, tailed by the live transcriber).
 */
export class Recorder {
  constructor({ source, oggPath, pcmPath, log, onUnexpectedExit }) {
    this.source = source;
    this.oggPath = oggPath;
    this.pcmPath = pcmPath;
    this.log = log;
    this.onUnexpectedExit = onUnexpectedExit;
    this.process = null;
    this.stopping = false;
    this.exited = null;
    this.stderrTail = "";
    this.recordingStartedAt = null;
  }

  get pid() {
    return this.process?.pid ?? null;
  }

  bytes() {
    try {
      return fs.statSync(this.pcmPath).size;
    } catch {
      return 0;
    }
  }

  seconds() {
    return this.bytes() / PCM_BYTES_PER_SEC;
  }

  /**
   * Start recording; resolves with the epoch ms of audio sample 0 as soon as
   * the first audio arrives. The estimate is `now - bytes/32` (each one is late
   * by the write latency, so the smallest is the tightest); it keeps improving
   * for ~1.5 s in the background and `onRefine(ms)` reports better values.
   */
  async start({ onRefine } = {}) {
    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "pulse",
      "-sample_rate",
      "48000",
      "-channels",
      "1",
      "-fragment_size",
      "1920",
      "-i",
      `${this.source}`,
      "-map",
      "0:a",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "voip",
      "-ar",
      "48000",
      "-ac",
      "1",
      // Write Ogg pages as they fill so a killed ffmpeg still leaves a playable archive.
      "-flush_packets",
      "1",
      "-page_duration",
      "1000000",
      this.oggPath,
      "-map",
      "0:a",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "-flush_packets",
      "1",
      this.pcmPath,
    ];
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      throw new BotError("dependency_missing", `Cannot start ffmpeg: ${error.message}`);
    }
    this.process = child;
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.exitPromise = new Promise((resolve) => {
      child.on("error", (error) => {
        this.exited = { code: null, signal: null, error };
        resolve();
      });
      child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        resolve();
      });
    });
    this.exitPromise.then(() => {
      if (!this.stopping) this.onUnexpectedExit?.(this.exited, this.stderrTail.trim().slice(-500));
    });

    const spawnedAt = Date.now();
    const estimate = () => {
      const bytes = this.bytes();
      return bytes > 0 ? Date.now() - (bytes / PCM_BYTES_PER_SEC) * 1000 : null;
    };
    let best = null;
    while (Date.now() - spawnedAt < 10_000 && !this.exited) {
      best = estimate();
      if (best !== null) break;
      await sleep(10);
    }
    if (this.exited) {
      const missing = this.exited.error?.code === "ENOENT";
      throw new BotError(missing ? "dependency_missing" : "recording_failed", `ffmpeg exited at start: ${missing ? "ffmpeg is not installed" : this.stderrTail.trim().slice(-300)}`);
    }
    if (best === null) {
      throw new BotError("recording_failed", `ffmpeg produced no audio within 10 s: ${this.stderrTail.trim().slice(-300)}`);
    }
    this.recordingStartedAt = Math.round(Math.max(best, spawnedAt));
    this.log("info", "Recording started", { pid: child.pid, recordingStartedAt: this.recordingStartedAt, startupMs: this.recordingStartedAt - spawnedAt });
    // Refine in the background.
    (async () => {
      const until = Date.now() + 1_500;
      while (Date.now() < until && !this.exited) {
        await sleep(20);
        const next = estimate();
        if (next !== null && next < best) best = next;
      }
      const refined = Math.round(Math.max(best, spawnedAt));
      if (refined !== this.recordingStartedAt) {
        this.log("debug", "Refined recordingStartedAt", { from: this.recordingStartedAt, to: refined });
        this.recordingStartedAt = refined;
        onRefine?.(refined);
      }
    })();
    return this.recordingStartedAt;
  }

  /** Graceful stop: 'q' on stdin, then SIGINT, then SIGKILL, so the Ogg trailer gets written. */
  async stop() {
    const child = this.process;
    if (child === null || this.exited) return;
    this.stopping = true;
    const waitExit = (ms) => Promise.race([this.exitPromise.then(() => true), sleep(ms).then(() => false)]);
    try {
      child.stdin.write("q");
      child.stdin.end();
    } catch {
      // stdin already closed
    }
    if (await waitExit(5_000)) return;
    this.log("warn", "ffmpeg ignored 'q'; sending SIGINT");
    child.kill("SIGINT");
    if (await waitExit(3_000)) return;
    this.log("warn", "ffmpeg ignored SIGINT; killing it");
    child.kill("SIGKILL");
    await waitExit(2_000);
  }
}

/**
 * Reads what was appended to audio.pcm since the last call and returns its
 * RMS (0..1). Used for the "no audio at all" timeout.
 */
export class PcmTail {
  constructor(pcmPath) {
    this.pcmPath = pcmPath;
    this.offset = 0;
  }

  /** RMS of the new audio, or null when nothing new was written. */
  readRms(maxBytes = 2 * PCM_BYTES_PER_SEC) {
    let fd;
    try {
      const size = fs.statSync(this.pcmPath).size;
      if (size <= this.offset) return null;
      const start = Math.max(this.offset, size - maxBytes);
      const length = (size - start) & ~1;
      if (length <= 0) return null;
      fd = fs.openSync(this.pcmPath, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      this.offset = start + length;
      return rmsS16le(buffer);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/** RMS of s16le samples, normalised to 0..1. */
export function rmsS16le(buffer) {
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = buffer.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}
