// Runtime constants the page needs. The originals live in src/shared/
// rpc-contract.ts and runtime-files.ts, but importing runtime values from
// there would bundle zod and defineRpcContract into the frontend, so the few
// strings and sets are duplicated here (constants.test.ts keeps them in sync).
import type { MeetingStatus } from "../shared/rpc-contract";

/** The nav panel's `path` (routes /plugins/meetings/meetings/*). */
export const PANEL_PATH = "meetings";

// Realtime channels: CHANNEL_* in src/shared/rpc-contract.ts.
export const CHANNEL_MEETING_CHANGED = "meetings.changed";
export const CHANNEL_MEETING_SEGMENTS = "meetings.segments";
export const CHANNEL_ENV_CHANGED = "meetings.env";
export const CHANNEL_CALENDAR_CHANGED = "meetings.calendar";
export const CHANNEL_ZOOM_CHANGED = "meetings.zoom";

// FTS snippet markers: SNIPPET_OPEN / SNIPPET_CLOSE in src/shared/rpc-contract.ts.
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

/** MEETING_ID_PATTERN in src/shared/runtime-files.ts. */
export const MEETING_ID_PATTERN = /^mtg_[a-z0-9]{6,32}$/;

/** ACTIVE_STATUSES in src/shared/rpc-contract.ts: a bot or transcriber may still be working. */
export const ACTIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set<MeetingStatus>([
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "recording",
  "processing",
]);
/** LIVE_STATUSES in src/shared/rpc-contract.ts: the bot is (or is about to be) in the meeting. */
export const LIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set<MeetingStatus>([
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "recording",
]);
/** TERMINAL_STATUSES in src/shared/rpc-contract.ts. */
export const TERMINAL_STATUSES: ReadonlySet<MeetingStatus> = new Set<MeetingStatus>(["done", "failed", "cancelled"]);

/** A pause this long (seconds) starts a new speaker turn even for the same speaker. */
export const TURN_GAP_SEC = 2;

/** Page size for the "Прошедшие" list. */
export const PAST_PAGE_SIZE = 30;

const HTTP_BASE = "/api/v1/plugins/meetings/http";

export const DOWNLOAD_FORMATS = ["md", "txt", "srt", "vtt", "json", "audio"] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

/** `version` > 0 makes a new URL so the browser reloads a recording that has grown since it was opened. */
export function audioUrl(id: string, version = 0): string {
  return `${HTTP_BASE}/audio?id=${encodeURIComponent(id)}${version > 0 ? `&v=${version}` : ""}`;
}

export function screenshotUrl(id: string, version: number | null): string {
  return `${HTTP_BASE}/screenshot?id=${encodeURIComponent(id)}&v=${version ?? 0}`;
}

export function downloadUrl(id: string, format: DownloadFormat): string {
  return `${HTTP_BASE}/download?id=${encodeURIComponent(id)}&format=${format}`;
}
