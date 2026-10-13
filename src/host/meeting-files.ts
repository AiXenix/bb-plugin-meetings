// Reading from and writing requests into a meeting directory: whitelisted
// chunked file reads, absolute paths for agents, log tails, and the
// remote-control channel to a running bot (control/<seq>.json, viewer.json,
// debug.request; DESIGN §6.5).
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_READ_CHUNK } from "../shared/contract.js";
import {
  READABLE_FILES,
  controlCommandSchema,
  type ControlCommand,
  type ReadableFile,
} from "../shared/runtime-files.js";
import { createJsonExclusive, errorCode, lstatOrNull, readJson, tailLines, writeJsonAtomic } from "./fsutil.js";
import { liveBotPid } from "./meetings.js";
import { MEETING_FILES as F, meetingDir, type HostPaths } from "./paths.js";

/** How long a control command keeps the bot in "someone is watching" mode. */
export const CONTROL_VIEWER_MS = 30_000;
/** viewer.json is never set further ahead than this. */
const MAX_VIEWER_AHEAD_MS = 10 * 60_000;
const LOG_FILES = [F.botLog, F.transcriberLog, F.events] as const;

async function meetingDirIfExists(paths: HostPaths, meetingId: string): Promise<string | null> {
  const dir = meetingDir(paths, meetingId);
  return (await lstatOrNull(dir))?.isDirectory() ? dir : null;
}

// ── readFile / filePath ──────────────────────────────────────────────────

export interface FileChunk {
  readonly base64: string | null;
  readonly totalBytes: number;
  readonly mtimeMs: number | null;
}

export async function readMeetingFile(
  paths: HostPaths,
  input: { readonly meetingId: string; readonly file: ReadableFile; readonly offset: number; readonly length: number },
): Promise<FileChunk> {
  if (!(READABLE_FILES as readonly string[]).includes(input.file)) throw new Error(`Файл ${input.file} нельзя читать`);
  const missing: FileChunk = { base64: null, totalBytes: 0, mtimeMs: null };
  const dir = await meetingDirIfExists(paths, input.meetingId);
  if (dir === null) return missing;
  let handle: fs.FileHandle;
  try {
    // O_NOFOLLOW: a symlink planted in the meeting dir must not lead outside it.
    // O_NONBLOCK: a FIFO must not hang the open (it is refused as not a regular file below).
    handle = await fs.open(path.join(dir, input.file), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return missing;
    if (errorCode(error) === "ELOOP") throw new Error(`${input.file} — символическая ссылка, чтение запрещено`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${input.file} не является обычным файлом`);
    const start = Math.min(input.offset, stat.size);
    const length = Math.max(0, Math.min(input.length, MAX_READ_CHUNK, stat.size - start));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    return {
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      totalBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    };
  } finally {
    await handle.close();
  }
}

export type MeetingPathFile =
  | "dir"
  | "audio.ogg"
  | "screen.jpg"
  | "transcript.json"
  | "transcript.md"
  | "transcript.txt"
  | "bot.log"
  | "transcriber.log";

export async function meetingFilePath(paths: HostPaths, meetingId: string, name: MeetingPathFile): Promise<string | null> {
  const dir = await meetingDirIfExists(paths, meetingId);
  if (dir === null) return null;
  if (name === "dir") return dir;
  const target = path.join(dir, name);
  return (await lstatOrNull(target))?.isFile() ? target : null;
}

// ── logs ─────────────────────────────────────────────────────────────────

export async function meetingLogs(paths: HostPaths, meetingId: string, lines: number): Promise<string> {
  const dir = await meetingDirIfExists(paths, meetingId);
  if (dir === null) return `Каталог встречи ${meetingId} не найден на этом компьютере.`;
  const count = Math.max(1, Math.min(1000, Math.floor(lines)));
  const sections: string[] = [];
  for (const name of LOG_FILES) {
    // Bounded: at most 1 MiB read per file and 2000 chars per line.
    const tail = await tailLines(path.join(dir, name), count, 1024 * 1024, 2000);
    if (tail === null || tail === "") continue;
    sections.push(`== ${name} (последние ${count} строк)\n${tail}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "Логов пока нет.";
}

// ── requests to a running bot ────────────────────────────────────────────

export async function requestDebugDump(paths: HostPaths, meetingId: string): Promise<boolean> {
  const dir = await meetingDirIfExists(paths, meetingId);
  if (dir === null || (await liveBotPid(dir)) === null) return false;
  await writeJsonAtomic(path.join(dir, F.debugRequest), { requestedAt: Date.now() });
  return true;
}

async function readViewerUntil(dir: string): Promise<number> {
  const viewer = (await readJson(path.join(dir, F.viewer))) as { until?: unknown } | null;
  return typeof viewer?.until === "number" ? viewer.until : 0;
}

export async function setViewer(paths: HostPaths, meetingId: string, untilMs: number): Promise<boolean> {
  const dir = await meetingDirIfExists(paths, meetingId);
  if (dir === null) return false;
  await writeJsonAtomic(path.join(dir, F.viewer), { until: Math.min(untilMs, Date.now() + MAX_VIEWER_AHEAD_MS) });
  return true;
}

/** Highest command seq in control/: the larger of the pending files and the bot's ack. */
export async function lastControlSeq(controlDir: string): Promise<number> {
  const names = await fs.readdir(controlDir).catch(() => [] as string[]);
  let max = 0;
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const ack = await readJson(path.join(controlDir, "ack.json"));
  const acked = typeof ack === "number" ? ack : typeof (ack as { seq?: unknown } | null)?.seq === "number" ? (ack as { seq: number }).seq : 0;
  return Math.max(max, acked);
}

export type ControlInput = Omit<ControlCommand, "seq" | "t"> & { readonly meetingId: string };

function requireFields(input: ControlInput): void {
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`Для команды ${input.action} нужно ${what}`);
  };
  switch (input.action) {
    case "click":
    case "dblclick":
      need(input.x !== undefined && input.y !== undefined, "указать x и y");
      break;
    case "type":
      need(input.text !== undefined && input.text !== "", "указать text");
      break;
    case "key":
      need(input.key !== undefined && input.key !== "", "указать key");
      break;
    case "scroll":
      need(input.dy !== undefined, "указать dy");
      break;
    case "done":
      break;
  }
}

/**
 * Queue one command as control/<seq>.json (seq = 1 + the highest pending or
 * acknowledged seq; created exclusively so concurrent calls never share a
 * seq) and keep the viewer alive. Not queued when the bot is not running.
 */
export async function queueControl(paths: HostPaths, input: ControlInput): Promise<{ queued: boolean; seq: number }> {
  requireFields(input);
  const dir = await meetingDirIfExists(paths, input.meetingId);
  if (dir === null) throw new Error(`Встреча ${input.meetingId} не найдена на этом компьютере`);
  const controlDir = path.join(dir, F.control);
  if ((await liveBotPid(dir)) === null) return { queued: false, seq: await lastControlSeq(controlDir) };

  await fs.mkdir(controlDir, { recursive: true });
  const viewerUntil = Math.max(await readViewerUntil(dir), Date.now() + CONTROL_VIEWER_MS);
  await writeJsonAtomic(path.join(dir, F.viewer), { until: viewerUntil });

  const { meetingId: _meetingId, ...fields } = input;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const seq = (await lastControlSeq(controlDir)) + 1;
    const command = controlCommandSchema.parse(
      Object.fromEntries(Object.entries({ ...fields, seq, t: Date.now() }).filter(([, value]) => value !== undefined)),
    );
    if (await createJsonExclusive(path.join(controlDir, `${seq}.json`), command)) return { queued: true, seq };
  }
  throw new Error("Не удалось поставить команду в очередь: слишком много одновременных команд");
}
