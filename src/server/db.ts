// SQLite registry (docs/dev/DESIGN.md §7): meetings, their segments with a
// manually maintained FTS5 index, and calendar occurrences. Migrations are
// append-only: never edit or reorder a statement once it has shipped.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type {
  MeetingSource,
  MeetingStatus,
  SpeakerView,
  TranscriptStatus,
} from "../shared/rpc-contract.js";
import type {
  BotErrorCode,
  EndReason,
  Platform,
  Segment,
  SpeakerSource,
} from "../shared/runtime-files.js";

type Db = Database.Database;

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,
    meeting_number TEXT,
    bot_name TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    status_detail TEXT,
    error_code TEXT,
    error_message TEXT,
    end_reason TEXT,
    host_id TEXT,
    scheduled_at INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    joined_at INTEGER,
    recording_started_at INTEGER,
    ended_at INTEGER,
    duration_sec REAL NOT NULL DEFAULT 0,
    transcript_status TEXT NOT NULL DEFAULT 'none',
    transcript_progress REAL,
    transcript_error TEXT,
    transcript_final INTEGER NOT NULL DEFAULT 0,
    transcriber_failures INTEGER NOT NULL DEFAULT 0,
    participants_count INTEGER,
    participants_json TEXT NOT NULL DEFAULT '[]',
    active_speakers_json TEXT NOT NULL DEFAULT '[]',
    speakers_json TEXT NOT NULL DEFAULT '[]',
    segments_count INTEGER NOT NULL DEFAULT 0,
    has_audio INTEGER NOT NULL DEFAULT 0,
    screenshot_mtime REAL,
    summary_md TEXT,
    speaker_names_json TEXT NOT NULL DEFAULT '{}',
    options_json TEXT NOT NULL DEFAULT '{}',
    requested_by_thread_id TEXT,
    notify INTEGER NOT NULL DEFAULT 1,
    notified_at INTEGER,
    calendar_key TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX meetings_status ON meetings(status)`,
  `CREATE INDEX meetings_created ON meetings(created_at)`,
  `CREATE INDEX meetings_calendar_key ON meetings(calendar_key)`,
  `CREATE TABLE segments (
    meeting_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    start REAL NOT NULL,
    "end" REAL NOT NULL,
    speaker_key TEXT NOT NULL,
    speaker TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    final INTEGER NOT NULL DEFAULT 0,
    UNIQUE (meeting_id, id)
  )`,
  // rowid = segments.rowid; rows are inserted/deleted together with segments.
  `CREATE VIRTUAL TABLE segments_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE TABLE calendar_events (
    key TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    feed TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER,
    url TEXT,
    status TEXT NOT NULL,
    skipped INTEGER NOT NULL DEFAULT 0,
    meeting_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX calendar_events_starts ON calendar_events(starts_at)`,
];

export function openDatabase(bb: BbPluginApi): Db {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  return db;
}

/** "mtg_" + base36 time + 4 random [a-z0-9]. */
export function newMeetingId(now = Date.now()): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(4);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `mtg_${now.toString(36)}${suffix}`;
}

/** Per-meeting overrides of the global settings. */
export interface MeetingOptions {
  maxDurationMinutes?: number;
  /** import: the source file on the host. */
  sourcePath?: string;
  /** startedAt of the last failed transcriber run already counted in transcriberFailures. */
  lastFailedTranscriberStart?: number;
  /** Fingerprint of the transcriber state and when the server saw it change (stall detection). */
  transcriberMark?: string;
  transcriberMarkAt?: number;
  /** When the server first saw the bot dead with a non-terminal state (crash confirmation). */
  botDeadSince?: number;
}

export interface StoredSpeaker {
  key: string;
  label: string;
  source: SpeakerSource;
  talkSec: number;
  segments: number;
}

export interface MeetingRow {
  id: string;
  title: string;
  url: string;
  platform: Platform;
  meetingNumber: string | null;
  botName: string;
  source: MeetingSource;
  status: MeetingStatus;
  statusDetail: string | null;
  errorCode: BotErrorCode | null;
  errorMessage: string | null;
  endReason: EndReason | null;
  hostId: string | null;
  scheduledAt: number | null;
  createdAt: number;
  startedAt: number | null;
  joinedAt: number | null;
  recordingStartedAt: number | null;
  endedAt: number | null;
  durationSec: number;
  transcriptStatus: TranscriptStatus;
  transcriptProgress: number | null;
  transcriptError: string | null;
  transcriptFinal: boolean;
  /** Failed transcriber runs (distinct transcriber.json startedAt with phase failed). */
  transcriberFailures: number;
  participantsCount: number | null;
  participants: string[];
  activeSpeakers: string[];
  speakers: StoredSpeaker[];
  segmentsCount: number;
  hasAudio: boolean;
  screenshotMtime: number | null;
  summaryMd: string | null;
  speakerNames: Record<string, string>;
  options: MeetingOptions;
  requestedByThreadId: string | null;
  notify: boolean;
  notifiedAt: number | null;
  calendarKey: string | null;
  updatedAt: number;
}

interface RawMeetingRow {
  id: string;
  title: string;
  url: string;
  platform: string;
  meeting_number: string | null;
  bot_name: string;
  source: string;
  status: string;
  status_detail: string | null;
  error_code: string | null;
  error_message: string | null;
  end_reason: string | null;
  host_id: string | null;
  scheduled_at: number | null;
  created_at: number;
  started_at: number | null;
  joined_at: number | null;
  recording_started_at: number | null;
  ended_at: number | null;
  duration_sec: number;
  transcript_status: string;
  transcript_progress: number | null;
  transcript_error: string | null;
  transcript_final: number;
  transcriber_failures: number;
  participants_count: number | null;
  participants_json: string;
  active_speakers_json: string;
  speakers_json: string;
  segments_count: number;
  has_audio: number;
  screenshot_mtime: number | null;
  summary_md: string | null;
  speaker_names_json: string;
  options_json: string;
  requested_by_thread_id: string | null;
  notify: number;
  notified_at: number | null;
  calendar_key: string | null;
  updated_at: number;
}

/** camelCase field → column. Only these fields can be written through updateMeeting. */
const COLUMNS = {
  title: "title",
  url: "url",
  platform: "platform",
  meetingNumber: "meeting_number",
  botName: "bot_name",
  source: "source",
  status: "status",
  statusDetail: "status_detail",
  errorCode: "error_code",
  errorMessage: "error_message",
  endReason: "end_reason",
  hostId: "host_id",
  scheduledAt: "scheduled_at",
  createdAt: "created_at",
  startedAt: "started_at",
  joinedAt: "joined_at",
  recordingStartedAt: "recording_started_at",
  endedAt: "ended_at",
  durationSec: "duration_sec",
  transcriptStatus: "transcript_status",
  transcriptProgress: "transcript_progress",
  transcriptError: "transcript_error",
  transcriptFinal: "transcript_final",
  transcriberFailures: "transcriber_failures",
  participantsCount: "participants_count",
  participants: "participants_json",
  activeSpeakers: "active_speakers_json",
  speakers: "speakers_json",
  segmentsCount: "segments_count",
  hasAudio: "has_audio",
  screenshotMtime: "screenshot_mtime",
  summaryMd: "summary_md",
  speakerNames: "speaker_names_json",
  options: "options_json",
  requestedByThreadId: "requested_by_thread_id",
  notify: "notify",
  notifiedAt: "notified_at",
  calendarKey: "calendar_key",
  updatedAt: "updated_at",
} as const satisfies Record<Exclude<keyof MeetingRow, "id">, string>;

export type MeetingPatch = Partial<Omit<MeetingRow, "id">>;

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function fromRaw(raw: RawMeetingRow): MeetingRow {
  return {
    id: raw.id,
    title: raw.title,
    url: raw.url,
    platform: raw.platform as Platform,
    meetingNumber: raw.meeting_number,
    botName: raw.bot_name,
    source: raw.source as MeetingSource,
    status: raw.status as MeetingStatus,
    statusDetail: raw.status_detail,
    errorCode: raw.error_code as BotErrorCode | null,
    errorMessage: raw.error_message,
    endReason: raw.end_reason as EndReason | null,
    hostId: raw.host_id,
    scheduledAt: raw.scheduled_at,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    joinedAt: raw.joined_at,
    // Older imports stored 0 (the host's "no recording start"): not a date.
    recordingStartedAt: raw.recording_started_at !== null && raw.recording_started_at > 0 ? raw.recording_started_at : null,
    endedAt: raw.ended_at,
    durationSec: raw.duration_sec,
    transcriptStatus: raw.transcript_status as TranscriptStatus,
    transcriptProgress: raw.transcript_progress,
    transcriptError: raw.transcript_error,
    transcriptFinal: raw.transcript_final === 1,
    transcriberFailures: raw.transcriber_failures,
    participantsCount: raw.participants_count,
    participants: parseJson<string[]>(raw.participants_json, []),
    activeSpeakers: parseJson<string[]>(raw.active_speakers_json, []),
    speakers: parseJson<StoredSpeaker[]>(raw.speakers_json, []),
    segmentsCount: raw.segments_count,
    hasAudio: raw.has_audio === 1,
    screenshotMtime: raw.screenshot_mtime,
    summaryMd: raw.summary_md,
    speakerNames: parseJson<Record<string, string>>(raw.speaker_names_json, {}),
    options: parseJson<MeetingOptions>(raw.options_json, {}),
    requestedByThreadId: raw.requested_by_thread_id,
    notify: raw.notify === 1,
    notifiedAt: raw.notified_at,
    calendarKey: raw.calendar_key,
    updatedAt: raw.updated_at,
  };
}

function toColumnValue(key: keyof typeof COLUMNS, value: unknown): unknown {
  switch (key) {
    case "participants":
    case "activeSpeakers":
    case "speakers":
    case "speakerNames":
    case "options":
      return JSON.stringify(value);
    case "transcriptFinal":
    case "hasAudio":
    case "notify":
      return value ? 1 : 0;
    default:
      return value === undefined ? null : value;
  }
}

export interface NewMeeting {
  id: string;
  title: string;
  url: string;
  platform: Platform;
  meetingNumber: string | null;
  botName: string;
  source: MeetingSource;
  status: MeetingStatus;
  statusDetail?: string | null;
  scheduledAt: number | null;
  createdAt: number;
  options: MeetingOptions;
  requestedByThreadId: string | null;
  notify: boolean;
  calendarKey: string | null;
}

export interface SegmentRow {
  id: number;
  start: number;
  end: number;
  speakerKey: string;
  speaker: string;
  source: SpeakerSource;
  text: string;
  final: boolean;
}

interface RawSegmentRow {
  id: number;
  start: number;
  end: number;
  speaker_key: string;
  speaker: string;
  source: string;
  text: string;
  final: number;
}

function segmentFromRaw(raw: RawSegmentRow): SegmentRow {
  return {
    id: raw.id,
    start: raw.start,
    end: raw.end,
    speakerKey: raw.speaker_key,
    speaker: raw.speaker,
    source: raw.source as SpeakerSource,
    text: raw.text,
    final: raw.final === 1,
  };
}

export interface CalendarEventRow {
  key: string;
  uid: string;
  feed: string;
  title: string;
  startsAt: number;
  endsAt: number | null;
  url: string | null;
  status: string;
  skipped: boolean;
  meetingId: string | null;
  updatedAt: number;
}

interface RawCalendarRow {
  key: string;
  uid: string;
  feed: string;
  title: string;
  starts_at: number;
  ends_at: number | null;
  url: string | null;
  status: string;
  skipped: number;
  meeting_id: string | null;
  updated_at: number;
}

function calendarFromRaw(raw: RawCalendarRow): CalendarEventRow {
  return {
    key: raw.key,
    uid: raw.uid,
    feed: raw.feed,
    title: raw.title,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    url: raw.url,
    status: raw.status,
    skipped: raw.skipped === 1,
    meetingId: raw.meeting_id,
    updatedAt: raw.updated_at,
  };
}

export interface SearchRow {
  meetingId: string;
  meetingTitle: string;
  meetingDate: number;
  segmentId: number;
  start: number;
  speakerKey: string;
  speaker: string;
  speakerNamesJson: string;
  snippet: string;
}

/** FTS index text: ё folds to е so both spellings match (unicode61 keeps ё distinct). */
export function ftsText(text: string): string {
  return text.replace(/ё/g, "е").replace(/Ё/g, "Е");
}

/**
 * An FTS5 MATCH expression for free text: every term quoted (so operators and
 * punctuation are literal) and prefix-matched, all terms required.
 */
export function ftsQuery(input: string): string | null {
  const terms = ftsText(input)
    .split(/\s+/)
    .map((term) => term.replace(/["\u0000-\u001f]/g, "").trim())
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" ");
}

export class Repository {
  constructor(private readonly db: Db) {}

  // ---------- meetings ----------

  insertMeeting(meeting: NewMeeting): MeetingRow {
    this.db
      .prepare(
        `INSERT INTO meetings (id, title, url, platform, meeting_number, bot_name, source, status, status_detail,
           scheduled_at, created_at, options_json, requested_by_thread_id, notify, calendar_key, updated_at)
         VALUES (@id, @title, @url, @platform, @meetingNumber, @botName, @source, @status, @statusDetail,
           @scheduledAt, @createdAt, @options, @requestedByThreadId, @notify, @calendarKey, @createdAt)`,
      )
      .run({
        ...meeting,
        statusDetail: meeting.statusDetail ?? null,
        options: JSON.stringify(meeting.options),
        notify: meeting.notify ? 1 : 0,
      });
    return this.requireMeeting(meeting.id);
  }

  getMeeting(id: string): MeetingRow | null {
    const raw = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as RawMeetingRow | undefined;
    return raw === undefined ? null : fromRaw(raw);
  }

  requireMeeting(id: string): MeetingRow {
    const row = this.getMeeting(id);
    if (row === null) throw new Error(`Meeting ${id} is not in the registry`);
    return row;
  }

  /** Write the given fields; returns the updated row. `updatedAt` is set unless given. */
  updateMeeting(id: string, patch: MeetingPatch, now = Date.now()): MeetingRow {
    const entries = Object.entries({ updatedAt: now, ...patch }).filter(
      ([key, value]) => key in COLUMNS && value !== undefined,
    ) as Array<[keyof typeof COLUMNS, unknown]>;
    const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
    const values = entries.map(([key, value]) => toColumnValue(key, value));
    this.db.prepare(`UPDATE meetings SET ${sets} WHERE id = ?`).run(...values, id);
    return this.requireMeeting(id);
  }

  /**
   * Newest first, paged by a `created_at` cursor. A full page is extended by the
   * rest of the meetings created in the same millisecond as its last one (calendar
   * sync creates several at once), so `created_at < last` on the next page skips none.
   */
  listMeetings(options: { statuses: readonly MeetingStatus[] | null; before: number | null; limit: number }): MeetingRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.statuses !== null) {
      where.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    if (options.before !== null) {
      where.push("created_at < ?");
      params.push(options.before);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM meetings ${filter} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, options.limit) as RawMeetingRow[];
    const last = rows.at(-1);
    if (rows.length === options.limit && last !== undefined) {
      const ties = this.db
        .prepare(`SELECT * FROM meetings ${filter ? `${filter} AND` : "WHERE"} created_at = ? AND id < ? ORDER BY id DESC`)
        .all(...params, last.created_at, last.id) as RawMeetingRow[];
      rows.push(...ties);
    }
    return rows.map(fromRaw);
  }

  meetingsWithStatus(statuses: readonly MeetingStatus[]): MeetingRow[] {
    if (statuses.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT * FROM meetings WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at`)
        .all(...statuses) as RawMeetingRow[]
    ).map(fromRaw);
  }

  /** Meetings of one Zoom meeting (number, else link) in the given statuses. */
  meetingsOf(platform: string, meetingNumber: string | null, url: string, statuses: readonly MeetingStatus[]): MeetingRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const raws = (meetingNumber !== null
      ? this.db.prepare(`SELECT * FROM meetings WHERE platform = ? AND meeting_number = ? AND status IN (${marks})`).all(platform, meetingNumber, ...statuses)
      : this.db.prepare(`SELECT * FROM meetings WHERE platform = ? AND meeting_number IS NULL AND url = ? AND status IN (${marks})`).all(platform, url, ...statuses)) as RawMeetingRow[];
    return raws.map(fromRaw);
  }

  countWithStatus(statuses: readonly MeetingStatus[]): number {
    if (statuses.length === 0) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM meetings WHERE status IN (${statuses.map(() => "?").join(", ")})`)
      .get(...statuses) as { n: number };
    return row.n;
  }

  meetingByCalendarKey(key: string): MeetingRow | null {
    const raw = this.db
      .prepare("SELECT * FROM meetings WHERE calendar_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(key) as RawMeetingRow | undefined;
    return raw === undefined ? null : fromRaw(raw);
  }

  /** Claim the one-time notification; true when this caller won it. */
  claimNotification(id: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE meetings SET notified_at = ? WHERE id = ? AND notified_at IS NULL").run(now, id)
      .changes === 1;
  }

  deleteMeeting(id: string): boolean {
    return this.db.transaction(() => {
      this.deleteSegments(id);
      this.db.prepare("UPDATE calendar_events SET meeting_id = NULL WHERE meeting_id = ?").run(id);
      return this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id).changes === 1;
    })();
  }

  // ---------- segments ----------

  /** Insert or replace segments by (meeting, id), keeping the FTS index in step. */
  upsertSegments(meetingId: string, segments: readonly Segment[], final: boolean): void {
    const find = this.db.prepare("SELECT rowid FROM segments WHERE meeting_id = ? AND id = ?");
    const update = this.db.prepare(
      `UPDATE segments SET start = ?, "end" = ?, speaker_key = ?, speaker = ?, source = ?, text = ?, final = ? WHERE rowid = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO segments (meeting_id, id, start, "end", speaker_key, speaker, source, text, final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ftsDelete = this.db.prepare("DELETE FROM segments_fts WHERE rowid = ?");
    const ftsInsert = this.db.prepare("INSERT INTO segments_fts (rowid, text) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const s of segments) {
        const existing = find.get(meetingId, s.id) as { rowid: number } | undefined;
        let rowid: number | bigint;
        if (existing !== undefined) {
          rowid = existing.rowid;
          update.run(s.start, s.end, s.speakerKey, s.speaker, s.source, s.text, final ? 1 : 0, rowid);
          ftsDelete.run(rowid);
        } else {
          rowid = insert.run(meetingId, s.id, s.start, s.end, s.speakerKey, s.speaker, s.source, s.text, final ? 1 : 0)
            .lastInsertRowid;
        }
        ftsInsert.run(rowid, ftsText(s.text));
      }
    })();
  }

  /** Drop all segments of a meeting and insert these. */
  replaceSegments(meetingId: string, segments: readonly Segment[], final: boolean): void {
    this.db.transaction(() => {
      this.deleteSegments(meetingId);
      this.upsertSegments(meetingId, segments, final);
    })();
  }

  deleteSegments(meetingId: string, fromId = 0): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM segments_fts WHERE rowid IN (SELECT rowid FROM segments WHERE meeting_id = ? AND id >= ?)")
        .run(meetingId, fromId);
      this.db.prepare("DELETE FROM segments WHERE meeting_id = ? AND id >= ?").run(meetingId, fromId);
    })();
  }

  segments(meetingId: string, afterId: number, limit: number): SegmentRow[] {
    return (
      this.db
        .prepare(
          `SELECT id, start, "end", speaker_key, speaker, source, text, final FROM segments
           WHERE meeting_id = ? AND id > ? ORDER BY id LIMIT ?`,
        )
        .all(meetingId, afterId, limit) as RawSegmentRow[]
    ).map(segmentFromRaw);
  }

  allSegments(meetingId: string): SegmentRow[] {
    return this.segments(meetingId, -1, Number.MAX_SAFE_INTEGER);
  }

  segmentStats(meetingId: string): { count: number; maxId: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(MAX(id), -1) AS maxId FROM segments WHERE meeting_id = ?")
      .get(meetingId) as { count: number; maxId: number };
    return row;
  }

  search(match: string, limit: number, open: string, close: string): SearchRow[] {
    return this.db
      .prepare(
        `SELECT s.meeting_id AS meetingId, m.title AS meetingTitle,
           COALESCE(NULLIF(m.recording_started_at, 0), m.started_at, m.created_at) AS meetingDate,
           s.id AS segmentId, s.start AS start, s.speaker_key AS speakerKey, s.speaker AS speaker,
           m.speaker_names_json AS speakerNamesJson,
           snippet(segments_fts, 0, ?, ?, '…', 16) AS snippet
         FROM segments_fts
         JOIN segments s ON s.rowid = segments_fts.rowid
         JOIN meetings m ON m.id = s.meeting_id
         WHERE segments_fts MATCH ?
         ORDER BY bm25(segments_fts), meetingDate DESC
         LIMIT ?`,
      )
      .all(open, close, match, limit) as SearchRow[];
  }

  // ---------- calendar ----------

  calendarEvent(key: string): CalendarEventRow | null {
    const raw = this.db.prepare("SELECT * FROM calendar_events WHERE key = ?").get(key) as RawCalendarRow | undefined;
    return raw === undefined ? null : calendarFromRaw(raw);
  }

  /** Insert or refresh an occurrence; keeps `skipped` and `meeting_id`. */
  upsertCalendarEvent(event: Omit<CalendarEventRow, "skipped" | "meetingId">): CalendarEventRow {
    this.db
      .prepare(
        `INSERT INTO calendar_events (key, uid, feed, title, starts_at, ends_at, url, status, skipped, meeting_id, updated_at)
         VALUES (@key, @uid, @feed, @title, @startsAt, @endsAt, @url, @status, 0, NULL, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET uid = excluded.uid, feed = excluded.feed, title = excluded.title,
           starts_at = excluded.starts_at, ends_at = excluded.ends_at, url = excluded.url,
           status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(event);
    return this.calendarEvent(event.key)!;
  }

  setCalendarEventFields(key: string, fields: { skipped?: boolean; meetingId?: string | null; status?: string }): void {
    if (fields.skipped !== undefined) {
      this.db.prepare("UPDATE calendar_events SET skipped = ? WHERE key = ?").run(fields.skipped ? 1 : 0, key);
    }
    if (fields.meetingId !== undefined) {
      this.db.prepare("UPDATE calendar_events SET meeting_id = ? WHERE key = ?").run(fields.meetingId, key);
    }
    if (fields.status !== undefined) {
      this.db.prepare("UPDATE calendar_events SET status = ? WHERE key = ?").run(fields.status, key);
    }
  }

  calendarEventsBetween(from: number, to: number): CalendarEventRow[] {
    return (
      this.db
        .prepare("SELECT * FROM calendar_events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at, key")
        .all(from, to) as RawCalendarRow[]
    ).map(calendarFromRaw);
  }

  pruneCalendarEvents(before: number): void {
    this.db.prepare("DELETE FROM calendar_events WHERE starts_at < ?").run(before);
  }
}

/** Speaker list computed from segments (talk time, majority source), labels as the transcriber wrote them. */
export function speakersFromSegments(segments: ReadonlyArray<Pick<Segment, "speakerKey" | "speaker" | "source" | "start" | "end">>): StoredSpeaker[] {
  const byKey = new Map<string, { label: string; talkSec: number; segments: number; sources: Map<SpeakerSource, number> }>();
  for (const s of segments) {
    let entry = byKey.get(s.speakerKey);
    if (entry === undefined) {
      entry = { label: s.speaker, talkSec: 0, segments: 0, sources: new Map() };
      byKey.set(s.speakerKey, entry);
    }
    const duration = Math.max(0, s.end - s.start);
    entry.talkSec += duration;
    entry.segments += 1;
    entry.sources.set(s.source, (entry.sources.get(s.source) ?? 0) + duration + 1e-6);
  }
  return [...byKey.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      source: [...entry.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
      talkSec: Math.round(entry.talkSec * 10) / 10,
      segments: entry.segments,
    }))
    .sort((a, b) => b.talkSec - a.talkSec);
}

/** Speakers with the user's renames applied. */
export function speakerViews(speakers: readonly StoredSpeaker[], names: Readonly<Record<string, string>>): SpeakerView[] {
  return speakers.map((speaker) => ({
    key: speaker.key,
    label: names[speaker.key] ?? speaker.label,
    originalLabel: speaker.label,
    source: speaker.source,
    talkSec: speaker.talkSec,
    segments: speaker.segments,
  }));
}
