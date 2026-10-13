// Small process helpers: run a command with a timeout, find processes by
// command line (PID-reuse safe cleanup), and kill them.
import { spawn } from "node:child_process";
import fs from "node:fs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error with a BotErrorCode (src/shared/runtime-files.ts). */
export class BotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BotError";
    this.code = code;
  }
}

/** Thrown inside the join flow when a stop was requested. */
export class StopRequested extends Error {
  constructor() {
    super("Stop requested");
    this.name = "StopRequested";
  }
}

/**
 * Run a command to completion. Never throws for a non-zero exit; throws only
 * when the binary cannot be started.
 */
export function run(cmd, args, { timeoutMs = 15_000, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, signal, stdout, stderr });
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Pids (other than ours) whose command line contains `needle` as a substring of any argument. */
export function findProcesses(needle) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const argv = readCmdline(pid);
    if (argv !== null && argv.some((arg) => arg.includes(needle))) found.push({ pid, argv });
  }
  return found;
}

export function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Resolve after `ms`, or earlier when `signal` aborts. Never rejects. */
export function sleepUnless(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Race a promise against a timeout; resolves `fallback` on timeout or rejection. */
export async function within(promise, ms, fallback = undefined) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
