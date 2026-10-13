// Pure transcript helpers: speaker turns, playback lookup, incremental
// merging, per-speaker stats, search highlighting and FTS snippet parsing.
import type { SegmentView, SpeakerView } from "../shared/rpc-contract";
import { SNIPPET_CLOSE, SNIPPET_OPEN, TURN_GAP_SEC } from "./constants";

export interface Turn {
  /** Stable React key: the first segment's id. */
  key: number;
  speakerKey: string;
  start: number;
  end: number;
  firstId: number;
  lastId: number;
  segments: SegmentView[];
}

/** Long monologues are split so each block stays small enough to render lazily. */
const MAX_SEGMENTS_PER_TURN = 30;

/** Group consecutive segments of one speaker (pauses < TURN_GAP_SEC) into turns. */
export function buildTurns(segments: readonly SegmentView[], gapSec: number = TURN_GAP_SEC): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const segment of segments) {
    if (
      current !== null &&
      current.speakerKey === segment.speakerKey &&
      segment.start - current.end < gapSec &&
      current.segments.length < MAX_SEGMENTS_PER_TURN
    ) {
      current.segments.push(segment);
      current.end = Math.max(current.end, segment.end);
      current.lastId = segment.id;
      continue;
    }
    current = {
      key: segment.id,
      speakerKey: segment.speakerKey,
      start: segment.start,
      end: segment.end,
      firstId: segment.id,
      lastId: segment.id,
      segments: [segment],
    };
    turns.push(current);
  }
  return turns;
}

/**
 * Turns for `segments`, reusing the previous turn objects when the list only grew
 * (live updates), so memoized turn blocks before the last one do not re-render.
 */
export function extendTurns(
  previous: { segments: readonly SegmentView[]; turns: Turn[] } | null,
  segments: readonly SegmentView[],
): Turn[] {
  if (previous === null || previous.turns.length === 0) return buildTurns(segments);
  const prevLength = previous.segments.length;
  if (segments.length < prevLength) return buildTurns(segments);
  for (let i = 0; i < prevLength; i += 1) if (segments[i] !== previous.segments[i]) return buildTurns(segments);
  if (segments.length === prevLength) return previous.turns;
  // Every turn but the last was closed by the segment after it; only the last one can grow.
  const last = previous.turns[previous.turns.length - 1]!;
  return previous.turns.slice(0, -1).concat(buildTurns(segments.slice(prevLength - last.segments.length)));
}

/** The segment playing at `timeSec` (segments sorted by start), or null in a pause. */
export function findSegmentAt(segments: readonly SegmentView[], timeSec: number): number | null {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.start <= timeSec) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const segment = segments[found]!;
  return timeSec <= segment.end + 0.75 ? segment.id : null;
}

/** Append a page of segments (ids ascending); overlapping ids replace older copies. */
export function appendSegments(existing: readonly SegmentView[], incoming: readonly SegmentView[]): SegmentView[] {
  if (incoming.length === 0) return existing as SegmentView[];
  const lastId = existing.length > 0 ? existing[existing.length - 1]!.id : -1;
  if (incoming.every((segment) => segment.id > lastId)) return existing.concat(incoming);
  const byId = new Map<number, SegmentView>();
  for (const segment of existing) byId.set(segment.id, segment);
  for (const segment of incoming) byId.set(segment.id, segment);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface SpeakerStat {
  key: string;
  label: string;
  originalLabel: string;
  talkSec: number;
  segments: number;
}

/** Speaker stats: the server's list when it has one, else derived from the loaded segments. */
export function speakerStats(
  speakers: readonly SpeakerView[],
  segments: readonly SegmentView[],
  names: Readonly<Record<string, string>>,
): SpeakerStat[] {
  let stats: SpeakerStat[];
  if (speakers.length > 0) {
    stats = speakers.map((speaker) => ({
      key: speaker.key,
      label: names[speaker.key] ?? speaker.label,
      originalLabel: speaker.originalLabel,
      talkSec: speaker.talkSec,
      segments: speaker.segments,
    }));
  } else {
    const byKey = new Map<string, SpeakerStat>();
    for (const segment of segments) {
      let stat = byKey.get(segment.speakerKey);
      if (stat === undefined) {
        stat = {
          key: segment.speakerKey,
          label: names[segment.speakerKey] ?? segment.speaker,
          originalLabel: segment.speaker,
          talkSec: 0,
          segments: 0,
        };
        byKey.set(segment.speakerKey, stat);
      }
      stat.talkSec += Math.max(0, segment.end - segment.start);
      stat.segments += 1;
    }
    stats = [...byKey.values()];
  }
  return stats.sort((a, b) => b.talkSec - a.talkSec || a.label.localeCompare(b.label, "ru"));
}

/** Speaker keys in order of first appearance, then any remaining known speakers. */
export function speakerOrder(segments: readonly SegmentView[], speakers: readonly { key: string }[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const segment of segments) {
    if (!seen.has(segment.speakerKey)) {
      seen.add(segment.speakerKey);
      order.push(segment.speakerKey);
    }
  }
  for (const speaker of speakers) {
    if (!seen.has(speaker.key)) {
      seen.add(speaker.key);
      order.push(speaker.key);
    }
  }
  return order;
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** Split an FTS snippet into plain and matched parts at the \u0002…\u0003 markers. */
export function parseSnippet(snippet: string): TextPart[] {
  const parts: TextPart[] = [];
  let hit = false;
  let buffer = "";
  const flush = () => {
    if (buffer === "") return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.hit === hit) last.text += buffer;
    else parts.push({ text: buffer, hit });
    buffer = "";
  };
  for (const ch of snippet) {
    if (ch === SNIPPET_OPEN || ch === SNIPPET_CLOSE) {
      flush();
      hit = ch === SNIPPET_OPEN;
      continue;
    }
    buffer += ch;
  }
  flush();
  return parts;
}

/** Case-insensitive matcher for in-transcript search ("е" also finds "ё"); null for an empty query. */
export function searchPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[её]/gi, "[её]");
  return new RegExp(escaped, "giu");
}

export function splitHighlight(text: string, pattern: RegExp | null): TextPart[] {
  if (pattern === null) return [{ text, hit: false }];
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) {
    const index = match.index ?? 0;
    if (match[0] === "") break;
    if (index > last) parts.push({ text: text.slice(last, index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length > 0 ? parts : [{ text, hit: false }];
}

/** Ids of the segments whose text matches. */
export function findMatches(segments: readonly SegmentView[], pattern: RegExp | null): number[] {
  if (pattern === null) return [];
  const test = new RegExp(pattern.source, "iu");
  const ids: number[] = [];
  for (const segment of segments) if (test.test(segment.text)) ids.push(segment.id);
  return ids;
}
