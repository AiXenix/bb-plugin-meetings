// Small filesystem helpers shared by the host modules. Every JSON file the
// host writes goes through writeJsonAtomic so readers (bot, transcriber,
// other host calls) never see a half-written file.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

export function tmpName(file: string): string {
  return `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = tmpName(file);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Create `file` only when it does not exist yet, atomically (link(2) fails
 * with EEXIST). Returns false when another writer got there first.
 */
export async function createJsonExclusive(file: string, value: unknown): Promise<boolean> {
  const tmp = tmpName(file);
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await fs.link(tmp, file);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Parsed JSON, or null when the file is missing or not valid JSON. */
export async function readJson(file: string): Promise<unknown> {
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** JSON validated by `schema`, or null when missing, unreadable or invalid. */
export async function readJsonAs<T>(file: string, schema: ZodType<T>): Promise<T | null> {
  const value = await readJson(file);
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function statOrNull(file: string): Promise<Stats | null> {
  return fs.stat(file).catch(() => null);
}

export async function lstatOrNull(file: string): Promise<Stats | null> {
  return fs.lstat(file).catch(() => null);
}

export async function isFile(file: string): Promise<boolean> {
  return (await statOrNull(file))?.isFile() ?? false;
}

export async function isDirectory(file: string): Promise<boolean> {
  return (await statOrNull(file))?.isDirectory() ?? false;
}

/**
 * The last `lines` lines of a text file, reading at most `maxBytes` from its
 * end so huge logs stay cheap. Overlong lines are clipped. Null when the file
 * is missing, a symlink (it could lead outside the meeting dir) or not a
 * regular file (O_NONBLOCK: a FIFO must not block the open).
 */
export async function tailLines(
  file: string,
  lines: number,
  maxBytes = 1024 * 1024,
  maxLineChars = 4000,
): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const { size } = stat;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    // A cut in the middle of the file starts with a partial line: drop it.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const all = text.replace(/\n+$/, "").split("\n");
    return all
      .slice(-lines)
      .map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line))
      .join("\n");
  } finally {
    await handle.close();
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Remove `target` unless it is a symlink pointing elsewhere, in which case only the link goes. */
export async function removeTree(target: string): Promise<void> {
  const stat = await lstatOrNull(target);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    await fs.unlink(target);
    return;
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
