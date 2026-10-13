// File-based control channel between the host and a running bot
// (docs/dev/DESIGN.md §6.5): stop.request, debug.request, viewer.json {until}
// and remote-control commands control/<seq>.json acknowledged in
// control/ack.json {seq, t, ok, error?}.
import fs from "node:fs";
import path from "node:path";
import { readJson, removeFile, writeJsonAtomic } from "./files.mjs";

export const CONTROL_ACTIONS = new Set(["click", "dblclick", "type", "key", "scroll", "done"]);
const POLL_MS = 250;
/** Commands queued long before they could run (e.g. while Chrome was starting) are dropped. */
const STALE_COMMAND_MS = 120_000;

/** Validate a control command (mirror of controlCommandSchema). Returns an error string or null. */
export function validateCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return "not an object";
  if (!Number.isInteger(cmd.seq) || cmd.seq < 0) return "bad seq";
  if (!CONTROL_ACTIONS.has(cmd.action)) return `unknown action ${String(cmd.action)}`;
  const inRange = (v, min, max) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);
  if (!inRange(cmd.x, 0, 4000) || !inRange(cmd.y, 0, 4000)) return "x/y out of range";
  if (!inRange(cmd.dy, -5000, 5000)) return "dy out of range";
  if (cmd.text !== undefined && (typeof cmd.text !== "string" || cmd.text.length > 2000)) return "bad text";
  if (cmd.key !== undefined && (typeof cmd.key !== "string" || cmd.key.length > 40)) return "bad key";
  if ((cmd.action === "click" || cmd.action === "dblclick") && (cmd.x === undefined || cmd.y === undefined)) return "click needs x and y";
  if (cmd.action === "type" && typeof cmd.text !== "string") return "type needs text";
  if (cmd.action === "key" && typeof cmd.key !== "string") return "key needs key";
  return null;
}

export class ControlChannel {
  /**
   * @param {object} options
   * @param {string} options.dir meeting directory
   * @param {(level: string, msg: string, data?: object) => void} options.log
   * @param {() => void} options.onStop stop.request appeared
   * @param {() => Promise<void>} options.onDebug debug.request appeared
   * @param {(cmd: object) => Promise<void>} options.execute run one command (throws on failure)
   * @param {() => boolean} options.canExecute the page is ready for input
   */
  constructor({ dir, log, onStop, onDebug, execute, canExecute }) {
    this.dir = dir;
    this.controlDir = path.join(dir, "control");
    this.ackFile = path.join(this.controlDir, "ack.json");
    this.log = log;
    this.onStop = onStop;
    this.onDebug = onDebug;
    this.execute = execute;
    this.canExecute = canExecute;
    this.lastSeq = readJson(this.ackFile, null)?.seq ?? -1;
    this.timer = null;
    this.busy = false;
    this.ticks = 0;
    this.stopSeen = false;
    this.viewer = { mtimeMs: 0, until: 0 };
  }

  start() {
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.log("warn", "Control poll failed", { error: error.message }));
    }, POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A viewer is watching (viewer.json {until} in the future). */
  viewerActive(now = Date.now()) {
    const file = path.join(this.dir, "viewer.json");
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs !== this.viewer.mtimeMs) {
        const data = readJson(file, null);
        const until = Number(data?.until ?? data?.untilMs ?? 0);
        this.viewer = { mtimeMs, until: Number.isFinite(until) ? until : 0 };
      }
    } catch {
      this.viewer = { mtimeMs: 0, until: 0 };
    }
    return now < this.viewer.until;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.ticks += 1;
      if (this.ticks % 4 === 0) await this.#checkRequests();
      if (this.canExecute()) await this.#runCommands();
    } finally {
      this.busy = false;
    }
  }

  async #checkRequests() {
    if (!this.stopSeen && fs.existsSync(path.join(this.dir, "stop.request"))) {
      this.stopSeen = true;
      this.log("info", "stop.request found");
      this.onStop();
    }
    const debugFile = path.join(this.dir, "debug.request");
    if (fs.existsSync(debugFile)) {
      removeFile(debugFile);
      this.log("info", "debug.request found");
      await this.onDebug().catch((error) => this.log("warn", "Debug dump failed", { error: error.message }));
    }
  }

  async #runCommands() {
    let names;
    try {
      names = fs.readdirSync(this.controlDir);
    } catch {
      return;
    }
    const pending = names
      .map((name) => /^(\d+)\.json$/.exec(name))
      .filter((m) => m !== null && Number(m[1]) > this.lastSeq)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    for (const seq of pending) {
      const cmd = readJson(path.join(this.controlDir, `${seq}.json`), null);
      if (cmd === null) return; // still being written; retry next tick
      const invalid = validateCommand(cmd) ?? (cmd.seq !== seq ? "seq does not match the file name" : null);
      let ok = false;
      let error = invalid;
      if (invalid === null && typeof cmd.t === "number" && Date.now() - cmd.t > STALE_COMMAND_MS) error = "stale command skipped";
      if (error === null) {
        try {
          await this.execute(cmd);
          ok = true;
        } catch (failure) {
          error = failure.message.split("\n")[0].slice(0, 300);
        }
      }
      this.lastSeq = seq;
      writeJsonAtomic(this.ackFile, { seq, t: Date.now(), ok, ...(error ? { error } : {}) });
      // Typed text can be a password (Zoom sign-in): never keep it on disk.
      removeFile(path.join(this.controlDir, `${seq}.json`));
      this.log(ok ? "info" : "warn", `Control ${cmd?.action ?? "?"} #${seq} ${ok ? "done" : "failed"}`, error ? { error } : undefined);
    }
  }
}
