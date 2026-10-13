// Detached bot/transcriber processes: spawn them in their own session so they
// survive host-worker restarts, recognize them again from /proc (PID-reuse
// safe: the command line must name both the meeting dir and the script), and
// tear down everything that belongs to a meeting.
import { spawn } from "node:child_process";
import { constants as fsConstants, openSync, closeSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { run, which } from "./exec.js";
import { readJson, sleep, writeJsonAtomic } from "./fsutil.js";
import type { HostPaths } from "./paths.js";

export interface ProcInfo {
  readonly pid: number;
  readonly pgid: number;
  /** Single-letter state from /proc/<pid>/stat ("R", "S", "Z", …). */
  readonly state: string;
  /** Controlling terminal (tty_nr), 0 when none. */
  readonly tty: number;
  /** Working directory, or null when unreadable. */
  readonly cwd: string | null;
  readonly argv: readonly string[];
}

export async function readProc(pid: number): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [stat, cmdline, cwd] = await Promise.all([
    fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null),
    fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null),
    fs.readlink(`/proc/${pid}/cwd`).catch(() => null),
  ]);
  if (stat === null) return null;
  // "pid (comm) S ppid pgrp …" — comm may itself contain spaces and parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    pgid: Number(fields[2]),
    state: fields[0] ?? "?",
    tty: Number(fields[4] ?? 0) || 0,
    cwd: cwd === null ? null : cwd.replace(/ \(deleted\)$/, ""),
    argv: (cmdline ?? "").split("\0").filter((arg) => arg !== ""),
  };
}

export async function listProcs(): Promise<ProcInfo[]> {
  const entries = await fs.readdir("/proc").catch(() => [] as string[]);
  const procs = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => readProc(Number(entry))),
  );
  return procs.filter((proc): proc is ProcInfo => proc !== null && proc.pid !== process.pid);
}

/** `arg` names `dir` itself or something inside it (`--meeting-dir D`, `--user-data-dir=D/profile`). */
export function mentionsDir(arg: string, dir: string): boolean {
  let index = arg.indexOf(dir);
  while (index !== -1) {
    const before = index === 0 ? "" : arg[index - 1]!;
    const after = arg[index + dir.length] ?? "";
    if ((before === "" || before === "=" || before === " " || before === ":") && (after === "" || after === "/")) return true;
    index = arg.indexOf(dir, index + 1);
  }
  return false;
}

export function cwdInside(cwd: string | null, dir: string): boolean {
  return cwd !== null && (cwd === dir || cwd.startsWith(`${dir}/`));
}

function runsScriptFor(proc: ProcInfo, dir: string, scriptName: string): boolean {
  return (
    proc.state !== "Z" &&
    proc.argv.some((arg) => path.basename(arg) === scriptName) &&
    proc.argv.some((arg) => mentionsDir(arg, dir))
  );
}

/** The first of `pids` that is a live process running `scriptName` for meeting dir `dir`. */
export async function findLive(pids: Iterable<number | null | undefined>, dir: string, scriptName: string): Promise<number | null> {
  const seen = new Set<number>();
  for (const pid of pids) {
    if (typeof pid !== "number" || seen.has(pid)) continue;
    seen.add(pid);
    const proc = await readProc(pid);
    if (proc !== null && runsScriptFor(proc, dir, scriptName)) return pid;
  }
  return null;
}

// ── pids.json ────────────────────────────────────────────────────────────

export interface PidRecord {
  readonly pid: number;
  readonly startedAt: number;
  readonly mode?: "live" | "offline";
  /** Transcriber respawns since the last explicit start (crash-loop backoff). */
  readonly restarts?: number;
}
export interface PidsFile {
  readonly bot?: PidRecord;
  readonly transcriber?: PidRecord;
}

export async function readPids(file: string): Promise<PidsFile> {
  const value = await readJson(file);
  if (typeof value !== "object" || value === null) return {};
  const pick = (entry: unknown): PidRecord | undefined => {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.pid !== "number" || typeof record.startedAt !== "number") return undefined;
    return {
      pid: record.pid,
      startedAt: record.startedAt,
      ...(record.mode === "live" || record.mode === "offline" ? { mode: record.mode } : {}),
      ...(typeof record.restarts === "number" ? { restarts: record.restarts } : {}),
    };
  };
  const object = value as Record<string, unknown>;
  const bot = pick(object.bot);
  const transcriber = pick(object.transcriber);
  return { ...(bot ? { bot } : {}), ...(transcriber ? { transcriber } : {}) };
}

export async function updatePids(file: string, patch: Partial<PidsFile>): Promise<void> {
  await writeJsonAtomic(file, { ...(await readPids(file)), ...patch });
}

// ── spawning ─────────────────────────────────────────────────────────────

export interface DetachedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** stdout and stderr are appended here. */
  readonly logFile: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Start a process in its own session and process group (pgid = pid), not
 * tied to the host worker: it keeps running when the worker is evicted or the
 * plugin reloads.
 */
export async function spawnDetached(options: DetachedSpawn): Promise<number> {
  // O_NOFOLLOW: a symlink planted as the log must not make the child append to a file outside the meeting dir.
  const fd = openSync(
    options.logFile,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o666,
  );
  try {
    writeSync(fd, `\n=== ${new Date().toISOString()} start: ${options.command} ${options.args.join(" ")}\n`);
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`Не удалось запустить ${options.command}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

// ── teardown ─────────────────────────────────────────────────────────────

export interface MeetingProcessQuery {
  /** Process groups the host started for this meeting (bot / transcriber pids). */
  readonly groups?: readonly number[];
  /** Spare these (e.g. the transcriber while cleaning up after a crashed bot). */
  readonly exclude?: (proc: ProcInfo) => boolean;
}

/**
 * Every process that belongs to the meeting: its cwd is inside the meeting
 * dir, its command line names the meeting dir, or it shares a process group
 * with such a process and that group is one the host started. Matching is
 * per pid; process groups are never signalled blindly (a dead leader's pid
 * could have been reused). The dir is matched as given and as resolved
 * (/proc/<pid>/cwd is always the resolved path; the data dir may sit behind
 * a symlink). A process with a controlling terminal is the user's (a shell
 * cd'd into the dir, `less transcript.md`): everything the host starts runs
 * in its own session without one, so such a process only goes with a
 * verified group.
 */
export async function findMeetingProcesses(dir: string, query: MeetingProcessQuery = {}): Promise<ProcInfo[]> {
  const real = await fs.realpath(dir).catch(() => dir);
  const dirs = real === dir ? [dir] : [dir, real];
  const procs = await listProcs();
  const ownGroup = (await readProc(process.pid))?.pgid ?? -1;
  const belongs = (proc: ProcInfo) =>
    dirs.some((candidate) => cwdInside(proc.cwd, candidate) || proc.argv.some((arg) => mentionsDir(arg, candidate)));
  const candidateGroups = new Set((query.groups ?? []).filter((group) => group !== ownGroup));
  const verifiedGroups = new Set(procs.filter((proc) => candidateGroups.has(proc.pgid) && belongs(proc)).map((proc) => proc.pgid));
  return procs.filter(
    (proc) =>
      proc.state !== "Z" &&
      ((belongs(proc) && proc.tty === 0) || verifiedGroups.has(proc.pgid)) &&
      !(query.exclude?.(proc) ?? false),
  );
}

export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = await Promise.all(pids.map(async (pid) => {
      const proc = await readProc(pid);
      return proc !== null && proc.state !== "Z";
    }));
    if (!alive.includes(true)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * Kill everything that belongs to the meeting: SIGTERM first when `graceMs`
 * > 0, then SIGKILL, then one more scan for processes forked meanwhile.
 * Returns the pids that were signalled.
 */
export async function killMeetingProcesses(
  dir: string,
  query: MeetingProcessQuery & { readonly graceMs?: number } = {},
): Promise<number[]> {
  const signalled = new Set<number>();
  const targets = await findMeetingProcesses(dir, query);
  if ((query.graceMs ?? 0) > 0 && targets.length > 0) {
    for (const proc of targets) if (signalPid(proc.pid, "SIGTERM")) signalled.add(proc.pid);
    await waitForExit(targets.map((proc) => proc.pid), query.graceMs!);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const remaining = pass === 0 ? targets : await findMeetingProcesses(dir, query);
    for (const proc of remaining) if (signalPid(proc.pid, "SIGKILL")) signalled.add(proc.pid);
    if (remaining.length === 0) break;
    await waitForExit(remaining.map((proc) => proc.pid), 2_000);
  }
  return [...signalled];
}

// ── PulseAudio ───────────────────────────────────────────────────────────

/**
 * Whether a pulse module argument string names one of this meeting's devices
 * (`mtg_<short>`, `mtg_<short>_micsink`, `mtg_<short>_mic`). `<short>` is the
 * meeting id's random part or a ≥ 6-char prefix/suffix of it.
 */
export function pulseArgsMatch(args: string, meetingId: string): boolean {
  const idPart = meetingId.replace(/^mtg_/, "");
  for (const match of args.matchAll(/(?=mtg_([a-z0-9]+))/g)) {
    const token = match[1]!;
    if (token === idPart) return true;
    if (token.length >= 6 && (idPart.startsWith(token) || idPart.endsWith(token))) return true;
  }
  return false;
}

/** Unload the meeting's null sinks / remapped sources. Never autospawns a pulse server. */
export async function unloadPulseModules(paths: HostPaths, meetingId: string): Promise<number> {
  const pactl = await which("pactl");
  if (pactl === null) return 0;
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(paths.pulseClientConf, "autospawn = no\n");
  const env = { ...process.env, PULSE_CLIENTCONFIG: paths.pulseClientConf };
  const listed = await run(pactl, ["list", "short", "modules"], { timeoutMs: 5_000, env }).catch(() => null);
  if (listed === null || listed.code !== 0) return 0;
  const modules = listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([index, , args]) => /^\d+$/.test(index ?? "") && pulseArgsMatch(args ?? "", meetingId))
    .map(([index]) => Number(index))
    // Later modules first: the remapped mic source before the sink it reads.
    .sort((a, b) => b - a);
  let unloaded = 0;
  for (const index of modules) {
    const result = await run(pactl, ["unload-module", String(index)], { timeoutMs: 5_000, env }).catch(() => null);
    if (result?.code === 0) unloaded += 1;
  }
  return unloaded;
}
