// setup.json: the last (or running) env.setup. A run lives in one host worker
// and refreshes `heartbeatAt` while it works; a "running" record whose
// heartbeat stopped (the worker exited) is reported as interrupted.
import type { EnvReport } from "../shared/contract.js";
import { readJson, tailLines, writeJsonAtomic } from "./fsutil.js";
import type { HostPaths } from "./paths.js";

export interface SetupRecord {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly message: string;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Host worker running the setup. */
  readonly pid: number | null;
  readonly heartbeatAt: number | null;
}

export const HEARTBEAT_MS = 10_000;
const STALE_MS = 6 * HEARTBEAT_MS;

const IDLE: SetupRecord = { phase: "idle", message: "Установка ещё не запускалась", startedAt: null, finishedAt: null, pid: null, heartbeatAt: null };

/** Roots whose setup runs in this process (filled by setup.ts). */
export const runningHere = new Set<string>();

export async function readSetupRecord(paths: HostPaths): Promise<SetupRecord> {
  const value = (await readJson(paths.setupState)) as Partial<SetupRecord> | null;
  if (value === null || typeof value.phase !== "string") return IDLE;
  const record: SetupRecord = {
    phase: (["idle", "running", "done", "failed"] as const).find((phase) => phase === value.phase) ?? "idle",
    message: typeof value.message === "string" ? value.message : "",
    startedAt: typeof value.startedAt === "number" ? value.startedAt : null,
    finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
    pid: typeof value.pid === "number" ? value.pid : null,
    heartbeatAt: typeof value.heartbeatAt === "number" ? value.heartbeatAt : null,
  };
  if (record.phase !== "running" || runningHere.has(paths.root)) return record;
  // Another worker (e.g. during a plugin reload) may still be running it.
  if (record.pid !== process.pid && record.heartbeatAt !== null && Date.now() - record.heartbeatAt < STALE_MS) return record;
  return { ...record, phase: "failed", message: `Установка была прервана: ${record.message}` };
}

export function writeSetupRecord(paths: HostPaths, record: SetupRecord): Promise<void> {
  return writeJsonAtomic(paths.setupState, record);
}

export async function setupSummary(paths: HostPaths): Promise<EnvReport["setup"]> {
  const record = await readSetupRecord(paths);
  const logTail = (await tailLines(paths.setupLog, 30, 64 * 1024, 500)) ?? "";
  return {
    phase: record.phase,
    message: record.message,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    logTail,
  };
}
