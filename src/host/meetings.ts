// Meeting lifecycle on the recording machine: start the detached bot (and
// live transcriber), import a recording, stop with escalation, report status
// from the files in the meeting directory, detect crashed bots, respawn the
// transcriber, and delete everything. No state lives in memory: every call
// re-reads the meeting directory (DESIGN §2, §4).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeSnapshot } from "../shared/contract.js";
import {
  MEETING_ID_PATTERN,
  TERMINAL_BOT_PHASES,
  botConfigSchema,
  botStateSchema,
  rosterSchema,
  transcriberStateSchema,
  type BotConfig,
  type BotState,
  type TranscriberConfig,
  type TranscriberState,
} from "../shared/runtime-files.js";
import { run, outputTail, which } from "./exec.js";
import {
  createJsonExclusive,
  errorMessage,
  isFile,
  lstatOrNull,
  readJson,
  readJsonAs,
  removeTree,
  statOrNull,
  tailLines,
  tmpName,
  writeJsonAtomic,
} from "./fsutil.js";
import { BOT_SCRIPT_NAME, MEETING_FILES as F, TRANSCRIBER_SCRIPT_NAME, meetingDir, type HostPaths } from "./paths.js";
import { PLAYWRIGHT_CORE } from "./platform.js";
import {
  findLive,
  killMeetingProcesses,
  readPids,
  signalPid,
  spawnDetached,
  unloadPulseModules,
  updatePids,
  waitForExit,
  type PidsFile,
  type ProcInfo,
} from "./processes.js";
import { ensureRuntimeDir } from "./setup.js";
import { pageSegments, readLiveSegments, readTranscript } from "./transcript-files.js";

/** The bot's temporary Chrome profile inside the meeting dir (runtime/bot/bot-runner.mjs). */
const BOT_PROFILE_DIR = "chrome-profile";
/** A stop request older than this with the bot still alive is escalated to SIGKILL by a repeated stop. */
export const STOP_ESCALATION_MS = 45_000;
/**
 * Status polls escalate on their own after this long: well past the bot's
 * own worst case (leave 14 s + recorder 10 s + cleanup watchdog 20 s), so
 * only a bot that is hung or ignores the request gets killed.
 */
export const AUTO_STOP_ESCALATION_MS = 2 * STOP_ESCALATION_MS;
/** SIGTERM before SIGKILL when tearing down a meeting's processes (ffmpeg finalizes, Chrome flushes the profile). */
const TEARDOWN_GRACE_MS = 1_500;
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const TRANSCRIBER_STOP_GRACE_MS = 5_000;
const MAX_TRANSCRIBER_BACKOFF_MS = 10 * 60_000;

/** Environment of every detached process: the worker's env plus where the host data lives. */
export function childEnv(paths: HostPaths): NodeJS.ProcessEnv {
  return { ...process.env, MEETINGS_HOST_DATA: paths.root, PYTHONUNBUFFERED: "1" };
}

function file(dir: string, name: string): string {
  return path.join(dir, name);
}

async function dirExists(dir: string): Promise<boolean> {
  return (await lstatOrNull(dir))?.isDirectory() ?? false;
}

async function readState(dir: string): Promise<BotState | null> {
  return readJsonAs(file(dir, F.state), botStateSchema);
}

async function readTranscriberState(dir: string): Promise<TranscriberState | null> {
  return readJsonAs(file(dir, F.transcriber), transcriberStateSchema);
}

export async function liveBotPid(dir: string, state?: BotState | null, pids?: PidsFile): Promise<number | null> {
  const record = pids ?? (await readPids(file(dir, F.pids)));
  const current = state === undefined ? await readState(dir) : state;
  return findLive([record.bot?.pid, current?.pid], dir, BOT_SCRIPT_NAME);
}

async function liveTranscriberPid(dir: string, state?: TranscriberState | null, pids?: PidsFile): Promise<number | null> {
  const record = pids ?? (await readPids(file(dir, F.pids)));
  const current = state === undefined ? await readTranscriberState(dir) : state;
  return findLive([record.transcriber?.pid, current?.pid], dir, TRANSCRIBER_SCRIPT_NAME);
}

/** Spares a live transcriber (and the ffmpeg it may run) when tearing down only the bot. */
function transcriberGuard(transcriberPid: number | null): (proc: ProcInfo) => boolean {
  return (proc) =>
    (transcriberPid !== null && proc.pgid === transcriberPid) ||
    proc.argv.some((arg) => path.basename(arg) === TRANSCRIBER_SCRIPT_NAME);
}

function emptySnapshot(meetingId: string): RuntimeSnapshot {
  return {
    meetingId,
    exists: false,
    bot: null,
    botAlive: false,
    transcriber: null,
    transcriberAlive: false,
    roster: null,
    files: { audioBytes: null, screenshotMtime: null, transcriptFinal: false, segments: 0 },
  };
}

// ── status ───────────────────────────────────────────────────────────────

export async function snapshot(paths: HostPaths, meetingId: string): Promise<RuntimeSnapshot> {
  const dir = meetingDir(paths, meetingId);
  if (!(await dirExists(dir))) return emptySnapshot(meetingId);
  const pids = await readPids(file(dir, F.pids));

  let state = await readState(dir);
  let botPid = await liveBotPid(dir, state, pids);
  if (botPid !== null && (await stopRequestAge(dir)) > AUTO_STOP_ESCALATION_MS) {
    // Asked to stop long ago and still running: hung (its own timeouts never fired).
    await forceStopBot(paths, meetingId, dir, pids, botPid);
    botPid = await liveBotPid(dir, state, pids);
  }
  if (botPid === null) {
    // Dead (or never started) bot: what it left on disk is final now.
    state = await readState(dir);
    botPid = await liveBotPid(dir, state, pids);
  }
  if (botPid === null) state = await reconcileDeadBot(paths, meetingId, dir, state, pids);

  const transcriber = await readTranscriberState(dir);
  const transcriberPid = await liveTranscriberPid(dir, transcriber, pids);
  const [roster, audio, screenshot, transcript] = await Promise.all([
    readJsonAs(file(dir, F.roster), rosterSchema),
    statOrNull(file(dir, F.audio)),
    statOrNull(file(dir, F.screenshot)),
    readTranscript(file(dir, F.transcript)),
  ]);
  const segments = transcript !== null ? transcript.segments.length : (await readLiveSegments(file(dir, F.segments))).length;
  return {
    meetingId,
    exists: true,
    bot: state,
    botAlive: botPid !== null,
    transcriber,
    transcriberAlive: transcriberPid !== null,
    roster,
    files: {
      audioBytes: audio?.isFile() ? audio.size : null,
      screenshotMtime: screenshot?.isFile() ? Math.round(screenshot.mtimeMs) : null,
      transcriptFinal: transcript !== null,
      segments,
    },
  };
}

/**
 * The bot is gone but its state says it is still working: it crashed or was
 * killed. Record a terminal state (ended when a stop was requested, else
 * failed/browser_crashed) and clean up what it left behind (Chrome, Xvfb,
 * ffmpeg, pulse modules). The transcriber keeps running to finish the audio.
 */
async function reconcileDeadBot(
  paths: HostPaths,
  meetingId: string,
  dir: string,
  state: BotState | null,
  pids: PidsFile,
): Promise<BotState | null> {
  if (state !== null && TERMINAL_BOT_PHASES.has(state.phase)) return state;
  if (state === null && pids.bot === undefined) return null;
  const now = Date.now();
  const stopRequested = await isFile(file(dir, F.stopRequest));
  const lastLine = ((await tailLines(file(dir, F.botLog), 1, 64 * 1024, 300)) ?? "").trim();
  const base: BotState = state ?? {
    version: 1,
    meetingId,
    pid: pids.bot?.pid ?? 0,
    phase: "starting",
    detail: "",
    startedAt: pids.bot?.startedAt ?? now,
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
  const next: BotState = stopRequested
    ? {
        ...base,
        phase: "ended",
        detail: "The bot process exited after a stop request",
        endReason: base.endReason ?? "stopped",
        endedAt: base.endedAt ?? now,
        activeSpeakers: [],
        updatedAt: now,
      }
    : {
        ...base,
        phase: "failed",
        detail: "The bot process exited unexpectedly",
        endReason: "error",
        error: {
          code: "browser_crashed",
          message: `The bot process exited unexpectedly${lastLine !== "" ? `: ${lastLine}` : ""}`,
        },
        endedAt: now,
        activeSpeakers: [],
        updatedAt: now,
      };
  // Reported even when it cannot be persisted (a full disk is a likely reason
  // the bot died): the next poll tries again.
  await writeJsonAtomic(file(dir, F.state), next).catch(() => undefined);
  await cleanupAfterBot(paths, meetingId, dir, pids, base);
  return next;
}

async function cleanupAfterBot(paths: HostPaths, meetingId: string, dir: string, pids: PidsFile, state: BotState | null): Promise<void> {
  const transcriberPid = await liveTranscriberPid(dir, undefined, pids);
  const groups = [pids.bot?.pid, state?.pid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
  await killMeetingProcesses(dir, { groups, exclude: transcriberGuard(transcriberPid), graceMs: TEARDOWN_GRACE_MS }).catch(
    () => undefined,
  );
  await unloadPulseModules(paths, meetingId).catch(() => 0);
  // The bot deletes its throwaway Chrome profile on a normal exit only.
  await removeTree(file(dir, BOT_PROFILE_DIR)).catch(() => undefined);
}

/** Segments after `afterId`: the final transcript when there is one, else the live segments.jsonl. */
export async function meetingSegments(paths: HostPaths, meetingId: string, afterId: number, limit: number) {
  const dir = meetingDir(paths, meetingId);
  const transcript = await readTranscript(file(dir, F.transcript));
  const segments = transcript?.segments ?? (await readLiveSegments(file(dir, F.segments)));
  return { final: transcript !== null, ...pageSegments(segments, afterId, limit) };
}

export function meetingTranscript(paths: HostPaths, meetingId: string) {
  return readTranscript(file(meetingDir(paths, meetingId), F.transcript));
}

/**
 * Snapshots of several meetings. One meeting that cannot be read is left out
 * (the server skips meetings without a snapshot) rather than failing the
 * batch for every other meeting; only when all fail does the call fail.
 */
export async function statusMany(paths: HostPaths, meetingIds: readonly string[]): Promise<RuntimeSnapshot[]> {
  const results = await Promise.allSettled(meetingIds.map((meetingId) => snapshot(paths, meetingId)));
  const snapshots = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined && snapshots.length === 0) throw failed.reason;
  return snapshots;
}

// ── start ────────────────────────────────────────────────────────────────

/** Files of a previous attempt that would confuse a fresh bot run in the same directory. */
const RUN_FILES = [
  F.state,
  F.transcriber,
  F.segments,
  F.embeddings,
  F.transcript,
  F.transcriptMd,
  F.transcriptTxt,
  F.audio,
  F.pcm,
  F.speakers,
  "signals.jsonl",
  F.roster,
  F.events,
  F.stopRequest,
  F.debugRequest,
  F.viewer,
  F.control,
  F.screenshot,
  F.pids,
  BOT_PROFILE_DIR,
];

async function prepareDir(paths: HostPaths, dir: string, meetingId: string): Promise<void> {
  const stat = await lstatOrNull(dir);
  if (stat === null) {
    await fs.mkdir(dir, { recursive: true });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`${dir} существует и не является каталогом`);
  const pids = await readPids(file(dir, F.pids));
  const state = await readState(dir);
  if ((await liveBotPid(dir, state, pids)) !== null) throw new Error(`Бот для встречи ${meetingId} уже запущен`);
  if (((await statOrNull(file(dir, F.audio)))?.size ?? 0) > 0) {
    throw new Error(`У встречи ${meetingId} уже есть запись; для нового подключения создайте новую встречу`);
  }
  // A previous attempt that never recorded: clear its leftovers and files.
  const transcriberPid = await liveTranscriberPid(dir, undefined, pids);
  if (transcriberPid !== null) await stopTranscriber(dir, transcriberPid);
  const groups = [pids.bot?.pid, state?.pid].filter((pid): pid is number => typeof pid === "number" && pid > 0);
  await killMeetingProcesses(dir, { groups, graceMs: TEARDOWN_GRACE_MS });
  await unloadPulseModules(paths, meetingId).catch(() => 0);
  for (const name of RUN_FILES) await removeTree(file(dir, name));
}

function initialState(config: BotConfig, pid: number): BotState {
  const now = Date.now();
  return {
    version: 1,
    meetingId: config.meetingId,
    pid,
    phase: "starting",
    detail: "Starting the bot",
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
}

async function requireRuntime(paths: HostPaths, options: { readonly bot: boolean }): Promise<void> {
  try {
    await ensureRuntimeDir(paths);
  } catch (error) {
    throw new Error(`Компоненты для записи не установлены: ${errorMessage(error)}`);
  }
  // Only the bot imports playwright-core; transcription works without it.
  const playwright = path.join(paths.runtime, "node_modules", PLAYWRIGHT_CORE.name, "package.json");
  if (options.bot && (await statOrNull(playwright)) === null) {
    throw new Error("Компоненты для записи не установлены: нет playwright-core, запустите установку компонентов (bb meetings setup)");
  }
}

/** Everything spawnTranscriber needs: checked before a running transcriber or its results are touched. */
async function requireTranscriberRuntime(paths: HostPaths): Promise<void> {
  if ((await statOrNull(paths.venvPython)) === null) {
    throw new Error("Python-окружение транскрибатора не установлено: запустите установку компонентов (bb meetings setup)");
  }
  await requireRuntime(paths, { bot: false });
}

/** Meeting ids of sign-in sessions (mode "login") whose bot is alive. */
export async function liveLoginSessions(paths: HostPaths): Promise<string[]> {
  const live: string[] = [];
  for (const meetingId of await listMeetingIds(paths)) {
    const dir = meetingDir(paths, meetingId);
    const config = (await readJson(file(dir, F.config))) as { mode?: unknown } | null;
    if (config?.mode === "login" && (await liveBotPid(dir)) !== null) live.push(meetingId);
  }
  return live;
}

export async function startMeeting(paths: HostPaths, input: BotConfig): Promise<RuntimeSnapshot> {
  const config = botConfigSchema.parse(input);
  const dir = meetingDir(paths, config.meetingId);
  await fs.mkdir(paths.meetings, { recursive: true });
  if (config.mode === "login") {
    const other = (await liveLoginSessions(paths)).filter((id) => id !== config.meetingId);
    if (other.length > 0) throw new Error(`Уже идёт вход в Zoom (${other[0]}); завершите его сначала`);
    if (config.zoomProfileDir !== null) await fs.mkdir(path.dirname(config.zoomProfileDir), { recursive: true });
  }
  await requireRuntime(paths, { bot: true });
  await prepareDir(paths, dir, config.meetingId);
  await writeJsonAtomic(file(dir, F.config), config);

  const pid = await spawnDetached({
    command: process.execPath,
    args: [paths.botScript, "--meeting-dir", dir],
    cwd: dir,
    logFile: file(dir, F.botLog),
    env: childEnv(paths),
  });
  // The bot replaces this with its own state; until then status shows "starting".
  await writeJsonAtomic(file(dir, F.pids), { bot: { pid, startedAt: Date.now() } });
  await createJsonExclusive(file(dir, F.state), initialState(config, pid));

  if (config.mode === "meeting" && config.liveTranscription) {
    try {
      const transcriberPid = await spawnTranscriber(paths, dir, config.transcriber, "live");
      await updatePids(file(dir, F.pids), {
        transcriber: { pid: transcriberPid, startedAt: Date.now(), mode: "live", restarts: 0 },
      });
    } catch (error) {
      // Recording matters more; the server respawns the transcriber later.
      await fs.appendFile(file(dir, F.transcriberLog), `\n=== ${new Date().toISOString()} live transcriber not started: ${errorMessage(error)}\n`);
    }
  }
  return snapshot(paths, config.meetingId);
}

// ── transcriber ──────────────────────────────────────────────────────────

async function spawnTranscriber(
  paths: HostPaths,
  dir: string,
  transcriber: TranscriberConfig,
  mode: "live" | "offline",
): Promise<number> {
  await requireTranscriberRuntime(paths);
  // -I: isolated from the user's site-packages and PYTHON* env (so -u replaces PYTHONUNBUFFERED).
  const args = [
    "-I",
    "-u",
    paths.transcriberScript,
    "--meeting-dir",
    dir,
    "--mode",
    mode,
    "--models-dir",
    paths.models,
    "--host-data",
    paths.root,
    "--threads",
    String(transcriber.threads),
  ];
  if (transcriber.gigaamUrl !== null && transcriber.gigaamUrl.trim() !== "") args.push("--gigaam-url", transcriber.gigaamUrl.trim());
  return spawnDetached({
    command: paths.venvPython,
    args,
    cwd: dir,
    logFile: file(dir, F.transcriberLog),
    env: childEnv(paths),
  });
}

async function stopTranscriber(dir: string, pid: number): Promise<void> {
  signalPid(pid, "SIGTERM");
  if (await waitForExit([pid], TRANSCRIBER_STOP_GRACE_MS)) return;
  await killMeetingProcesses(dir, {
    groups: [pid],
    exclude: (proc) => proc.pgid !== pid && !proc.argv.some((arg) => path.basename(arg) === TRANSCRIBER_SCRIPT_NAME),
  });
}

async function updateConfigTranscriber(dir: string, transcriber: TranscriberConfig): Promise<void> {
  const config = await readJsonAs(file(dir, F.config), botConfigSchema);
  if (config === null) throw new Error(`В каталоге встречи нет корректного config.json: ${dir}`);
  await writeJsonAtomic(file(dir, F.config), { ...config, transcriber });
}

export interface EnsureTranscriberInput {
  readonly meetingId: string;
  readonly mode: "live" | "offline";
  readonly transcriber: TranscriberConfig;
}

/** Drop the previous results so nothing looks final (or current) while an offline run works. */
async function clearTranscriptionOutputs(dir: string): Promise<void> {
  for (const name of [F.transcript, F.transcriptMd, F.transcriptTxt, F.segments, F.embeddings, F.transcriber]) {
    await removeTree(file(dir, name));
  }
}

/**
 * live: spawn the transcriber when it is not running and the transcript is
 * not final (it resumes from its checkpoint), with a crash-loop backoff. A
 * run that was offline (import, re-transcription) or a meeting whose
 * audio.pcm is gone restarts offline instead: there is nothing to tail.
 * offline: re-transcribe from audio.ogg from scratch, replacing a running one.
 */
export async function ensureTranscriber(paths: HostPaths, input: EnsureTranscriberInput): Promise<RuntimeSnapshot> {
  const dir = meetingDir(paths, input.meetingId);
  if (!(await dirExists(dir))) throw new Error(`Встреча ${input.meetingId} не найдена на этом компьютере`);
  const pids = await readPids(file(dir, F.pids));
  const alive = await liveTranscriberPid(dir, undefined, pids);
  const botAlive = (await liveBotPid(dir, undefined, pids)) !== null;
  const hasArchive = ((await statOrNull(file(dir, F.audio)))?.size ?? 0) > 0;

  if (input.mode === "live") {
    const final = (await readTranscript(file(dir, F.transcript))) !== null;
    if (alive !== null || final) return snapshot(paths, input.meetingId);
    const last = pids.transcriber;
    if (last !== undefined) {
      const backoff = Math.min(MAX_TRANSCRIBER_BACKOFF_MS, 10_000 * 2 ** Math.min(last.restarts ?? 0, 6));
      if (Date.now() - last.startedAt < backoff) return snapshot(paths, input.meetingId);
    }
    const restarts = (last?.restarts ?? -1) + 1;
    const noLiveInput = !botAlive && hasArchive && !(await isFile(file(dir, F.pcm)));
    const mode = last?.mode === "offline" || noLiveInput ? "offline" : "live";
    await requireTranscriberRuntime(paths);
    await updateConfigTranscriber(dir, input.transcriber);
    if (mode === "offline") await clearTranscriptionOutputs(dir);
    const pid = await spawnTranscriber(paths, dir, input.transcriber, mode);
    await updatePids(file(dir, F.pids), { transcriber: { pid, startedAt: Date.now(), mode, restarts } });
    return snapshot(paths, input.meetingId);
  }

  if (botAlive) throw new Error("Бот ещё записывает встречу: повторная расшифровка возможна после её окончания");
  if (!hasArchive) throw new Error("У встречи нет аудиозаписи (audio.ogg)");
  // Before anything is stopped or deleted: a re-transcription that cannot start must not cost the old transcript.
  await requireTranscriberRuntime(paths);
  if (alive !== null) await stopTranscriber(dir, alive);
  await updateConfigTranscriber(dir, input.transcriber);
  await clearTranscriptionOutputs(dir);
  const pid = await spawnTranscriber(paths, dir, input.transcriber, "offline");
  await updatePids(file(dir, F.pids), { transcriber: { pid, startedAt: Date.now(), mode: "offline", restarts: 0 } });
  return snapshot(paths, input.meetingId);
}

// ── import ───────────────────────────────────────────────────────────────

async function probeDuration(ffprobe: string, audio: string, signal?: AbortSignal): Promise<number> {
  const result = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", audio], {
    timeoutMs: 60_000,
    signal,
  });
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * `signal` is the call's: when the server gives up (its deadline is shorter
 * than a long conversion can take), ffmpeg is killed and the half-made
 * meeting dir removed instead of finishing for a meeting already marked failed.
 */
export async function importMeeting(
  paths: HostPaths,
  input: BotConfig,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<RuntimeSnapshot> {
  const config = botConfigSchema.parse(input);
  if (!path.isAbsolute(sourcePath)) throw new Error(`Нужен абсолютный путь к файлу: ${sourcePath}`);
  const source = await statOrNull(sourcePath);
  if (source === null) throw new Error(`Файл не найден: ${sourcePath}`);
  if (!source.isFile()) throw new Error(`Это не обычный файл: ${sourcePath}`);
  const [ffmpeg, ffprobe] = await Promise.all([which("ffmpeg"), which("ffprobe")]);
  if (ffmpeg === null || ffprobe === null) throw new Error("Для импорта нужны ffmpeg и ffprobe (sudo apt-get install -y ffmpeg)");
  // Before the (possibly long) conversion, not after it.
  await requireTranscriberRuntime(paths);

  const dir = meetingDir(paths, config.meetingId);
  if ((await lstatOrNull(dir)) !== null) throw new Error(`Встреча ${config.meetingId} уже существует на этом компьютере`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await writeJsonAtomic(file(dir, F.config), config);
    const audio = file(dir, F.audio);
    const partial = tmpName(audio);
    // Runs from a neutral cwd: nothing the host itself starts may look like a meeting process.
    const converted = await run(
      ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "48000",
        "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", partial],
      { timeoutMs: IMPORT_TIMEOUT_MS, cwd: os.tmpdir(), signal },
    );
    if (converted.code !== 0 || converted.timedOut) {
      await fs.rm(partial, { force: true });
      throw new Error(`ffmpeg не смог извлечь звук из ${path.basename(sourcePath)}: ${outputTail(converted) || "нет вывода"}`);
    }
    await fs.rename(partial, audio);
    const seconds = await probeDuration(ffprobe, audio, signal);
    if (seconds <= 0) throw new Error(`В файле ${path.basename(sourcePath)} нет звука`);
    const now = Date.now();
    const state: BotState = {
      version: 1,
      meetingId: config.meetingId,
      pid: 0,
      phase: "ended",
      detail: `Imported from ${path.basename(sourcePath)}`,
      startedAt: now,
      joinedAt: null,
      recordingStartedAt: null,
      endedAt: now,
      endReason: "stopped",
      error: null,
      participants: { count: null, names: [] },
      activeSpeakers: [],
      audio: { seconds, bytes: Math.round(seconds * 16_000) * 2 },
      updatedAt: now,
    };
    await writeJsonAtomic(file(dir, F.state), state);
    signal?.throwIfAborted();
    const pid = await spawnTranscriber(paths, dir, config.transcriber, "offline");
    await writeJsonAtomic(file(dir, F.pids), { transcriber: { pid, startedAt: Date.now(), mode: "offline", restarts: 0 } });
  } catch (error) {
    await killMeetingProcesses(dir, { graceMs: TEARDOWN_GRACE_MS }).catch(() => undefined);
    await removeTree(dir);
    throw error;
  }
  return snapshot(paths, config.meetingId);
}

// ── stop / delete / list ─────────────────────────────────────────────────

async function readStopRequestedAt(dir: string): Promise<number | null> {
  const request = (await readJson(file(dir, F.stopRequest))) as { requestedAt?: unknown } | null;
  return typeof request?.requestedAt === "number" ? request.requestedAt : null;
}

/** Milliseconds since stop.request was written; -Infinity when there is none. */
async function stopRequestAge(dir: string): Promise<number> {
  const requestedAt = await readStopRequestedAt(dir);
  return requestedAt === null ? Number.NEGATIVE_INFINITY : Date.now() - requestedAt;
}

/** The bot had its chance to leave and finalize the recording: kill it and what it started, sparing the transcriber. */
async function forceStopBot(paths: HostPaths, meetingId: string, dir: string, pids: PidsFile, botPid: number): Promise<void> {
  await killMeetingProcesses(dir, {
    groups: [botPid, ...(pids.bot ? [pids.bot.pid] : [])],
    exclude: transcriberGuard(await liveTranscriberPid(dir, undefined, pids)),
    graceMs: TEARDOWN_GRACE_MS,
  });
  await unloadPulseModules(paths, meetingId).catch(() => 0);
}

export async function stopMeeting(paths: HostPaths, meetingId: string): Promise<RuntimeSnapshot> {
  const dir = meetingDir(paths, meetingId);
  if (!(await dirExists(dir))) return emptySnapshot(meetingId);
  const now = Date.now();
  const requestedAt = await readStopRequestedAt(dir);
  if (requestedAt === null) await writeJsonAtomic(file(dir, F.stopRequest), { requestedAt: now });

  const pids = await readPids(file(dir, F.pids));
  const state = await readState(dir);
  const botPid = await liveBotPid(dir, state, pids);
  if (botPid !== null) {
    if (requestedAt !== null && now - requestedAt > STOP_ESCALATION_MS) await forceStopBot(paths, meetingId, dir, pids, botPid);
    else signalPid(botPid, "SIGTERM");
  }
  return snapshot(paths, meetingId);
}

export async function deleteMeeting(paths: HostPaths, meetingId: string): Promise<boolean> {
  const dir = meetingDir(paths, meetingId);
  const stat = await lstatOrNull(dir);
  if (stat === null) return false;
  if (stat.isDirectory()) {
    const pids = await readPids(file(dir, F.pids));
    const state = await readState(dir);
    const transcriber = await readTranscriberState(dir);
    const groups = [pids.bot?.pid, pids.transcriber?.pid, state?.pid, transcriber?.pid].filter(
      (pid): pid is number => typeof pid === "number" && pid > 0,
    );
    await killMeetingProcesses(dir, { groups, graceMs: TEARDOWN_GRACE_MS });
    await unloadPulseModules(paths, meetingId).catch(() => 0);
  }
  await removeTree(dir);
  return true;
}

export async function listMeetingIds(paths: HostPaths): Promise<string[]> {
  const entries = await fs.readdir(paths.meetings, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && MEETING_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
