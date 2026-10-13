// Run short-lived child processes with a hard timeout and bounded output.
// Every external command the host runs (probes, apt, uv, ffmpeg, tar, pactl)
// goes through here so none of them can hang a host call: each runs in its
// own process group, which is signalled as a whole on timeout or abort, and a
// descendant that keeps the output pipes open cannot hold the result back.
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RunOptions {
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Each output chunk is also written here (install logs). */
  readonly log?: { write(chunk: string | Uint8Array): unknown };
  /** Output kept in memory per stream; the rest is dropped from the front. */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const KILL_GRACE_MS = 2_000;
/** After the command exits, how long descendants may keep its output pipes open. */
const PIPE_GRACE_MS = 1_000;

/** Never rejects for a non-zero exit; rejects when the binary cannot start or the signal aborts. */
export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError(options.signal));
    options.log?.write(`$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? os.tmpdir(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group (and session): a timeout or abort reaches the
      // command's descendants too, and none of them gets the worker's terminal.
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    const keep = (chunks: Buffer[], chunk: Buffer, size: number): number => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) size -= chunks.shift()!.length;
      return size;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes = keep(out, chunk, outBytes);
      options.log?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes = keep(err, chunk, errBytes);
      options.log?.write(chunk);
    });
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    // "close" waits for every holder of the pipes; a backgrounded or
    // un-killable descendant (sudo's child after SIGKILL) must not hold it.
    child.once("exit", () => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPE_GRACE_MS).unref();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (aborted && options.signal) return reject(abortError(options.signal));
      if (timedOut) options.log?.write(`(timed out after ${options.timeoutMs} ms)\n`);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
  });
}

/** Like run(), but rejects with the output tail unless the command exits 0. */
export async function runChecked(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code === 0 && !result.timedOut) return result;
  const how = result.timedOut
    ? `не завершилась за ${Math.round(options.timeoutMs / 1000)} с`
    : `завершилась с кодом ${result.code ?? result.signal}`;
  throw new Error(`Команда «${path.basename(command)} ${args.slice(0, 3).join(" ")}» ${how}: ${outputTail(result)}`);
}

/** Last few non-empty output lines, for error messages. */
export function outputTail(result: Pick<RunResult, "stdout" | "stderr">, lines = 3): string {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-lines)
    .join(" | ");
}

/** Absolute path of an executable: `name` itself when it contains a slash, else the first PATH match. */
export async function which(name: string, envPath: string | undefined = process.env.PATH): Promise<string | null> {
  if (name.includes("/")) return (await isExecutable(name)) ? path.resolve(name) : null;
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `work`, or a rejection as soon as `signal` aborts. Host handlers use it so a
 * call the caller gave up on settles at once instead of outliving the daemon's
 * cancel grace (which kills the whole worker); the work itself winds down on
 * its own bounded timeouts.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Операция отменена");
}
