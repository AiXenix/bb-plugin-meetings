// Transcript renderers (md, txt, srt, vtt, json) over stored segments with
// the user's speaker renames applied. Pure: used by downloads, the CLI and tools.
import type { SpeakerSource } from "../shared/runtime-files.js";

export const TRANSCRIPT_FORMATS = ["md", "txt", "srt", "vtt", "json"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** Same speaker key and a gap under this many seconds → one turn. */
export const TURN_GAP_SEC = 2;

export interface FormatSegment {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly speakerKey: string;
  readonly speaker: string;
  readonly source: SpeakerSource;
  readonly text: string;
}

export interface FormatMeeting {
  readonly id: string;
  readonly title: string;
  /** Already masked for agent-visible output. */
  readonly url: string | null;
  /** Epoch ms of audio sample 0 (or the best known start). */
  readonly startedAt: number | null;
  readonly durationSec: number;
  readonly final: boolean;
  readonly summaryMd?: string | null;
}

export interface FormatOptions {
  /** IANA zone for wall-clock dates; default = the server's local zone. */
  readonly timeZone?: string;
  /** Include the header (title, date, speakers). Default true. */
  readonly header?: boolean;
}

export interface Turn {
  readonly speakerKey: string;
  readonly speaker: string;
  readonly start: number;
  readonly end: number;
  readonly firstId: number;
  readonly lastId: number;
  readonly text: string;
}

export function speakerLabel(segment: Pick<FormatSegment, "speakerKey" | "speaker">, names: Readonly<Record<string, string>>): string {
  const renamed = names[segment.speakerKey];
  return renamed !== undefined && renamed !== "" ? renamed : segment.speaker;
}

/** Apply renames to every segment. */
export function withNames<T extends FormatSegment>(segments: readonly T[], names: Readonly<Record<string, string>>): T[] {
  return segments.map((segment) => ({ ...segment, speaker: speakerLabel(segment, names) }));
}

/** Merge consecutive segments of the same speaker with gaps < TURN_GAP_SEC. Expects renamed segments. */
export function groupTurns(segments: readonly FormatSegment[], gapSec = TURN_GAP_SEC): Turn[] {
  const turns: Turn[] = [];
  let current: { speakerKey: string; speaker: string; start: number; end: number; firstId: number; lastId: number; parts: string[] } | null = null;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text === "") continue;
    if (current !== null && current.speakerKey === segment.speakerKey && segment.start - current.end < gapSec) {
      current.parts.push(text);
      current.end = Math.max(current.end, segment.end);
      current.lastId = segment.id;
      continue;
    }
    if (current !== null) turns.push(finishTurn(current));
    current = {
      speakerKey: segment.speakerKey,
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      firstId: segment.id,
      lastId: segment.id,
      parts: [text],
    };
  }
  if (current !== null) turns.push(finishTurn(current));
  return turns;
}

function finishTurn(turn: { speakerKey: string; speaker: string; start: number; end: number; firstId: number; lastId: number; parts: string[] }): Turn {
  return {
    speakerKey: turn.speakerKey,
    speaker: turn.speaker,
    start: turn.start,
    end: turn.end,
    firstId: turn.firstId,
    lastId: turn.lastId,
    text: turn.parts.join(" "),
  };
}

/** 3725.4 → "01:02:05" (hours always shown). */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 125 → "2 мин 5 с"; 3725 → "1 ч 2 мин". */
export function humanDuration(seconds: number, lang: "ru" | "en" = "ru"): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const units = lang === "ru" ? { h: "ч", m: "мин", s: "с" } : { h: "h", m: "min", s: "s" };
  if (h > 0) return `${h} ${units.h}${m > 0 ? ` ${m} ${units.m}` : ""}`;
  if (m > 0) return `${m} ${units.m}${s > 0 ? ` ${s} ${units.s}` : ""}`;
  return `${s} ${units.s}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function cueTime(seconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}${separator}${pad(ms, 3)}`;
}

export function formatDateTime(epochMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}

function speakerSummary(segments: readonly FormatSegment[]): Array<{ speaker: string; talkSec: number }> {
  const byName = new Map<string, number>();
  for (const s of segments) byName.set(s.speaker, (byName.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start));
  return [...byName.entries()].map(([speaker, talkSec]) => ({ speaker, talkSec })).sort((a, b) => b.talkSec - a.talkSec);
}

function headerLines(meeting: FormatMeeting, segments: readonly FormatSegment[], options: FormatOptions): string[] {
  const lines: string[] = [];
  if (meeting.startedAt !== null) lines.push(`Дата: ${formatDateTime(meeting.startedAt, options.timeZone)}`);
  if (meeting.durationSec > 0) lines.push(`Длительность: ${humanDuration(meeting.durationSec)}`);
  const speakers = speakerSummary(segments);
  if (speakers.length > 0) lines.push(`Участники: ${speakers.map((s) => s.speaker).join(", ")}`);
  if (meeting.url !== null && meeting.url !== "") lines.push(`Ссылка: ${meeting.url}`);
  if (!meeting.final) lines.push("Транскрипт предварительный: встреча ещё записывается или распознаётся.");
  return lines;
}

/** Markdown: title, metadata, optional summary, then one paragraph per speaker turn. */
export function renderMarkdown(meeting: FormatMeeting, renamed: readonly FormatSegment[], options: FormatOptions = {}): string {
  const out: string[] = [];
  if (options.header !== false) {
    out.push(`# ${meeting.title}`, "");
    for (const line of headerLines(meeting, renamed, options)) out.push(`- ${line}`);
    out.push("");
    if (meeting.summaryMd) out.push("## Резюме", "", meeting.summaryMd.trim(), "");
    out.push("## Транскрипт", "");
  }
  for (const turn of groupTurns(renamed)) {
    out.push(`**[${clock(turn.start)}] ${escapeMarkdown(turn.speaker)}:** ${turn.text}`, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`[\]])/g, "\\$1");
}

/** Plain text: "[00:01:02] Анна: …" per turn. */
export function renderText(meeting: FormatMeeting, renamed: readonly FormatSegment[], options: FormatOptions = {}): string {
  const out: string[] = [];
  if (options.header !== false) {
    out.push(meeting.title, ...headerLines(meeting, renamed, options), "");
  }
  for (const turn of groupTurns(renamed)) out.push(`[${clock(turn.start)}] ${turn.speaker}: ${turn.text}`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** SubRip: one cue per segment, speaker as a prefix. */
export function renderSrt(renamed: readonly FormatSegment[]): string {
  const cues = renamed
    .filter((s) => s.text.trim() !== "")
    .map((s, index) => `${index + 1}\n${cueTime(s.start, ",")} --> ${cueTime(Math.max(s.end, s.start + 0.1), ",")}\n${s.speaker}: ${s.text.trim()}\n`);
  return cues.join("\n");
}

/** WebVTT with voice spans (<v Name>). */
export function renderVtt(renamed: readonly FormatSegment[]): string {
  const cues = renamed
    .filter((s) => s.text.trim() !== "")
    .map(
      (s) =>
        `${s.id}\n${cueTime(s.start, ".")} --> ${cueTime(Math.max(s.end, s.start + 0.1), ".")}\n<v ${vttEscape(s.speaker)}>${vttEscape(s.text.trim())}\n`,
    );
  return `WEBVTT\n\n${cues.join("\n")}`;
}

function vttEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");
}

export function renderJson(meeting: FormatMeeting, renamed: readonly FormatSegment[]): string {
  const speakers = new Map<string, { key: string; label: string; talkSec: number; segments: number }>();
  for (const s of renamed) {
    const entry = speakers.get(s.speakerKey) ?? { key: s.speakerKey, label: s.speaker, talkSec: 0, segments: 0 };
    entry.talkSec += Math.max(0, s.end - s.start);
    entry.segments += 1;
    speakers.set(s.speakerKey, entry);
  }
  return `${JSON.stringify(
    {
      id: meeting.id,
      title: meeting.title,
      url: meeting.url,
      startedAt: meeting.startedAt,
      durationSec: meeting.durationSec,
      final: meeting.final,
      summaryMd: meeting.summaryMd ?? null,
      speakers: [...speakers.values()].map((s) => ({ ...s, talkSec: Math.round(s.talkSec * 10) / 10 })),
      segments: renamed.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        speakerKey: s.speakerKey,
        speaker: s.speaker,
        source: s.source,
        text: s.text,
      })),
    },
    null,
    2,
  )}\n`;
}

export function renderTranscript(
  format: TranscriptFormat,
  meeting: FormatMeeting,
  segments: readonly FormatSegment[],
  names: Readonly<Record<string, string>>,
  options: FormatOptions = {},
): string {
  const renamed = withNames(segments, names);
  switch (format) {
    case "md":
      return renderMarkdown(meeting, renamed, options);
    case "txt":
      return renderText(meeting, renamed, options);
    case "srt":
      return renderSrt(renamed);
    case "vtt":
      return renderVtt(renamed);
    case "json":
      return renderJson(meeting, renamed);
  }
}

export const FORMAT_CONTENT_TYPES: Readonly<Record<TranscriptFormat, string>> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** A file name for downloads: "<title> YYYY-MM-DD.<ext>" without path or control characters. */
export function downloadFileName(title: string, startedAt: number | null, ext: string, timeZone?: string): string {
  const base = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "meeting";
  let date = "";
  if (startedAt !== null) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(startedAt),
    );
    date = ` ${parts}`;
  }
  return `${base}${date}.${ext}`;
}

/** Content-Disposition with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\%]/g, "_")
    .replace(/_+/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
