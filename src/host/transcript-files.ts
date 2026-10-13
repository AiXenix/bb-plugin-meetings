// Readers for the transcriber's output. segments.jsonl grows while a meeting
// is live and is polled every couple of seconds, so it is parsed
// incrementally: only bytes appended since the last read, up to the last
// complete line (a partial last line is left for the next read).
// transcript.json is cached by inode+size+mtime. Both caches keep only the
// most recently used files: a long-lived worker sees every meeting of the day.
import fs from "node:fs/promises";
import { segmentSchema, transcriptSchema, type Segment, type Transcript } from "../shared/runtime-files.js";

interface LiveCache {
  readonly ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes consumed: everything up to and including the last newline seen. */
  offset: number;
  /** First bytes of the file, to notice a rewrite that is not an append. */
  head: Buffer;
  /** Sorted by id; a repeated id replaces the earlier line. */
  segments: Segment[];
}

const HEAD_BYTES = 256;
/** Files per cache; more than the meetings that are live or being viewed at once. */
export const CACHE_LIMIT = 16;
const liveCache = new Map<string, LiveCache>();
const transcriptCache = new Map<string, { key: string; transcript: Transcript | null }>();

/** Map lookup that marks the entry most recently used. */
function touch<V>(cache: Map<string, V>, file: string): V | undefined {
  const value = cache.get(file);
  if (value !== undefined) {
    cache.delete(file);
    cache.set(file, value);
  }
  return value;
}

/** Insert as most recently used, evicting the least recently used beyond the limit. */
function remember<V>(cache: Map<string, V>, file: string, value: V): void {
  cache.delete(file);
  cache.set(file, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Test hook: how many files each cache holds. */
export function cacheSizes(): { live: number; transcripts: number } {
  return { live: liveCache.size, transcripts: transcriptCache.size };
}

/** Parse complete JSONL lines; invalid lines are skipped. */
export function parseSegmentLines(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = segmentSchema.safeParse(JSON.parse(line));
      if (parsed.success) segments.push(parsed.data);
    } catch {
      // torn or foreign line
    }
  }
  return segments;
}

function merge(into: Segment[], added: readonly Segment[]): void {
  for (const segment of added) {
    const last = into[into.length - 1];
    if (last === undefined || segment.id > last.id) {
      into.push(segment);
      continue;
    }
    let low = 0;
    let high = into.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (into[mid]!.id < segment.id) low = mid + 1;
      else high = mid;
    }
    if (into[low]?.id === segment.id) into[low] = segment;
    else into.splice(low, 0, segment);
  }
}

/** Live segments from segments.jsonl (empty when the file is absent). */
export async function readLiveSegments(file: string): Promise<Segment[]> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    liveCache.delete(file);
    return [];
  }
  try {
    const stat = await handle.stat();
    let cache = touch(liveCache, file);
    if (cache !== undefined && cache.ino === stat.ino && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      // Same inode, size and mtime can still be a same-size rewrite inside one
      // filesystem clock tick (~4 ms): confirm the head did not change.
      const head = Buffer.alloc(cache.head.length);
      if (head.length > 0) await handle.read(head, 0, head.length, 0);
      if (head.equals(cache.head)) return cache.segments;
    }
    // Append-only growth of the same file: read the new tail only. Anything
    // else (new inode, shrink, change without growth, different head) is a
    // rewrite and is parsed from scratch.
    let incremental = cache !== undefined && cache.ino === stat.ino && stat.size > cache.size;
    if (incremental && cache!.head.length > 0) {
      const head = Buffer.alloc(cache!.head.length);
      await handle.read(head, 0, head.length, 0);
      incremental = head.equals(cache!.head);
    }
    if (incremental && cache!.offset > 0) {
      const probe = Buffer.alloc(1);
      await handle.read(probe, 0, 1, cache!.offset - 1);
      incremental = probe[0] === 0x0a;
    }
    if (!incremental || cache === undefined) {
      cache = { ino: stat.ino, size: 0, mtimeMs: 0, offset: 0, head: Buffer.alloc(0), segments: [] };
      remember(liveCache, file, cache);
    }
    const length = stat.size - cache.offset;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cache.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end >= 0) {
        merge(cache.segments, parseSegmentLines(buffer.subarray(0, end).toString("utf8")));
        if (cache.offset === 0) cache.head = Buffer.from(buffer.subarray(0, Math.min(end + 1, HEAD_BYTES)));
        cache.offset += end + 1;
      }
    }
    cache.size = stat.size;
    cache.mtimeMs = stat.mtimeMs;
    return cache.segments;
  } finally {
    await handle.close();
  }
}

/** The final transcript, or null when absent or invalid. */
export async function readTranscript(file: string): Promise<Transcript | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) {
    transcriptCache.delete(file);
    return null;
  }
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = touch(transcriptCache, file);
  if (cached?.key === key) return cached.transcript;
  let transcript: Transcript | null = null;
  try {
    const parsed = transcriptSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (parsed.success) transcript = { ...parsed.data, segments: [...parsed.data.segments].sort((a, b) => a.id - b.id) };
  } catch {
    transcript = null;
  }
  remember(transcriptCache, file, { key, transcript });
  return transcript;
}

/** Segments with id > afterId, at most `limit`. */
export function pageSegments(
  segments: readonly Segment[],
  afterId: number,
  limit: number,
): { segments: Segment[]; lastId: number; total: number } {
  let start = 0;
  let high = segments.length;
  while (start < high) {
    const mid = (start + high) >> 1;
    if (segments[mid]!.id <= afterId) start = mid + 1;
    else high = mid;
  }
  const page = segments.slice(start, start + limit);
  return { segments: page, lastId: page.length > 0 ? page[page.length - 1]!.id : afterId, total: segments.length };
}
