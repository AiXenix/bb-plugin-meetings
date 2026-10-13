// Google Calendar API v3 as a calendar source (docs/dev/DESIGN.md §13):
// calendarList for the picker, events.list with singleEvents over the sync
// window, and the mapping of an event to a CalendarOccurrence (cancelled,
// non-default, declined and all-day events are skipped; the Zoom link comes
// from conferenceData, then location, then the HTML description).
import { createHash } from "node:crypto";
import { extractMeetingUrls } from "../shared/meeting-url.js";
import type { CalendarOccurrence, CalendarSource, TimeWindow } from "./calendar.js";
import type { GoogleCalendarInfo } from "./db.js";
import { GOOGLE_TIMEOUT_MS, GoogleOAuthError, networkFailure } from "./google-auth.js";

/** Feed ids and occurrence keys of Google calendars start with this. */
export const GOOGLE_FEED_PREFIX = "gcal:";
/** calendarList and events.list page size (Google's maximum is 250). */
const PAGE_SIZE = 250;
/**
 * Pages per calendarList and per events.list (a 24 h window needs one). Google
 * may answer short or even empty pages while more follow; a listing still
 * unfinished after this many is a failure, never taken as complete.
 */
const MAX_PAGES = 10;

/** `gcal:<sha12(calendarId)>`: the calendar id (often an email) stays out of the feed column. */
export function googleFeedId(calendarId: string): string {
  return `${GOOGLE_FEED_PREFIX}${createHash("sha256").update(calendarId).digest("hex").slice(0, 12)}`;
}

/** singleEvents gives every recurrence instance its own event id. */
export function googleEventKey(calendarId: string, eventId: string): string {
  return `${GOOGLE_FEED_PREFIX}${calendarId}:${eventId}`;
}

export function isGoogleFeed(feed: string): boolean {
  return feed.startsWith(GOOGLE_FEED_PREFIX);
}

/** A Calendar API error: HTTP status and Google's reason ("rateLimitExceeded", "SERVICE_DISABLED", …). */
export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";

  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** The refresh token was revoked or expired: the user has to connect again. */
export class GoogleAuthBrokenError extends Error {
  override readonly name = "GoogleAuthBrokenError";
}

/** GET a Calendar API path (relative to the API base) with a valid access token; resolves to the JSON body. */
export type GoogleGet = (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;

/** One authorized GET; the caller retries a 401 with a fresh token. */
export async function calendarApiGet(base: string, path: string, query: Record<string, string>, accessToken: string, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(`${base.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const timeout = AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) throw apiError(response.status, body);
  if (body === null || typeof body !== "object") {
    throw new GoogleApiError(response.status, null, `Google Calendar API вернул ответ не в формате JSON (HTTP ${response.status})`);
  }
  return body;
}

function apiError(status: number, body: unknown): GoogleApiError {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return new GoogleApiError(status, null, `HTTP ${status}`);
  const record = error as { message?: unknown; status?: unknown; errors?: unknown; details?: unknown };
  const reasons: string[] = [];
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) if (typeof (item as { reason?: unknown })?.reason === "string") reasons.push((item as { reason: string }).reason);
  }
  if (Array.isArray(record.details)) {
    for (const item of record.details) if (typeof (item as { reason?: unknown })?.reason === "string") reasons.push((item as { reason: string }).reason);
  }
  if (typeof record.status === "string") reasons.push(record.status);
  const message = typeof record.message === "string" ? record.message : `HTTP ${status}`;
  return new GoogleApiError(status, reasons[0] ?? null, message);
}

/** A sync or token failure in Russian, for the UI (google.status.lastError), the CLI and logs. */
export function describeGoogleError(error: unknown): string {
  if (error instanceof GoogleAuthBrokenError) return error.message;
  if (error instanceof GoogleOAuthError) return error.message;
  if (error instanceof GoogleApiError) {
    const reason = error.reason ?? "";
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used in project|is disabled/i.test(error.message)) {
      return "Google Calendar API не включён в проекте Google Cloud — включите его и повторите синхронизацию";
    }
    if (/insufficientPermissions|SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(reason) && error.status === 403) {
      return "Нет разрешения читать календарь — подключите Google заново и разрешите просмотр календарей";
    }
    if (error.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(reason)) {
      return "Google ограничил число запросов — повторим при следующей синхронизации";
    }
    if (error.status === 404) return "Календарь не найден или к нему больше нет доступа";
    if (error.status === 401) return "Google не принял токен доступа";
    if (error.status >= 500) return `Google временно недоступен (HTTP ${error.status})`;
    return `HTTP ${error.status}: ${error.message.slice(0, 200)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------- calendarList ----------

interface RawCalendarListEntry {
  id?: unknown;
  summary?: unknown;
  summaryOverride?: unknown;
  primary?: unknown;
  hidden?: unknown;
  backgroundColor?: unknown;
}

/** Google gave nextPageToken after MAX_PAGES pages: the listing is not complete. */
export class GoogleListTruncatedError extends Error {
  override readonly name = "GoogleListTruncatedError";
}

/** Every page of a list call (items), following nextPageToken; throws when it does not end within MAX_PAGES. */
async function listAll<T>(get: GoogleGet, path: string, query: Record<string, string>, what: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await get(path, pageToken === null ? query : { ...query, pageToken }, signal)) as { items?: unknown; nextPageToken?: unknown };
    if (Array.isArray(body.items)) items.push(...(body.items as T[]));
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : null;
    if (pageToken === null) return items;
  }
  throw new GoogleListTruncatedError(`Google отдал неполный список ${what} — повторим при следующей синхронизации`);
}

/**
 * Every calendar the user can read events of, the primary one first. Also the
 * ones hidden in Google Calendar's list (a watched calendar stays watched when
 * the user hides it there); `hidden` keeps them out of the picker.
 */
export async function listCalendars(get: GoogleGet, signal?: AbortSignal): Promise<GoogleCalendarInfo[]> {
  const items = await listAll<RawCalendarListEntry>(
    get,
    "/users/me/calendarList",
    { maxResults: String(PAGE_SIZE), minAccessRole: "reader", showHidden: "true" },
    "календарей",
    signal,
  );
  const calendars: GoogleCalendarInfo[] = [];
  for (const item of items) {
    if (typeof item?.id !== "string" || item.id === "") continue;
    if (calendars.some((calendar) => calendar.id === item.id)) continue;
    const summary =
      (typeof item.summaryOverride === "string" && item.summaryOverride.trim()) ||
      (typeof item.summary === "string" && item.summary.trim()) ||
      item.id;
    calendars.push({
      id: item.id.slice(0, 300),
      summary: summary.slice(0, 200),
      primary: item.primary === true,
      color: typeof item.backgroundColor === "string" && /^#[0-9a-f]{3,8}$/i.test(item.backgroundColor) ? item.backgroundColor : null,
      ...(item.hidden === true ? { hidden: true } : {}),
    });
  }
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary));
}

// ---------- events ----------

export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  eventType?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }> };
}

/** Event instances (singleEvents) that overlap the window, in pages of 250; throws when the listing is not complete. */
export async function listEvents(get: GoogleGet, calendarId: string, window: TimeWindow, signal?: AbortSignal): Promise<GoogleEvent[]> {
  return listAll<GoogleEvent>(
    get,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      singleEvents: "true",
      orderBy: "startTime",
      // timeMin bounds the event end, timeMax the start (exclusive).
      timeMin: new Date(window.from).toISOString(),
      timeMax: new Date(window.to + 1).toISOString(),
      maxResults: String(PAGE_SIZE),
    },
    "событий",
    signal,
  );
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return safeCodePoint(Number.parseInt(name.slice(2), 16), whole);
    if (name.startsWith("#")) return safeCodePoint(Number.parseInt(name.slice(1), 10), whole);
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

/** Google descriptions are HTML: plain text plus every link target (anchors may show other text). */
export function stripHtml(html: string): string {
  const hrefs = [...html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => match[1] ?? match[2] ?? "");
  const text = html
    .replace(/<(?:br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities([text, ...hrefs].join("\n"));
}

function firstMeetingUrl(texts: ReadonlyArray<string | undefined>): string | null {
  for (const text of texts) {
    if (text === undefined || text === "") continue;
    const [first] = extractMeetingUrls(text);
    if (first !== undefined) return first;
  }
  return null;
}

/** The Zoom link of an event: conference entry points (video first), then location, then description. */
export function eventMeetingUrl(event: GoogleEvent): string | null {
  const entryPoints = Array.isArray(event.conferenceData?.entryPoints) ? event.conferenceData.entryPoints : [];
  const ordered = [...entryPoints].sort((a, b) => Number(b?.entryPointType === "video") - Number(a?.entryPointType === "video"));
  return firstMeetingUrl([
    ...ordered.map((entry) => (typeof entry?.uri === "string" ? entry.uri : undefined)),
    typeof event.location === "string" ? event.location : undefined,
    typeof event.description === "string" ? stripHtml(event.description) : undefined,
  ]);
}

/** The occurrence for one event instance, or null when it is not a meeting to join. */
export function eventOccurrence(calendarId: string, event: GoogleEvent): CalendarOccurrence | null {
  if (typeof event.id !== "string" || event.id === "") return null;
  if (event.status === "cancelled") return null;
  if (event.eventType !== undefined && event.eventType !== "default") return null; // focusTime, outOfOffice, workingLocation, birthday…
  if (Array.isArray(event.attendees) && event.attendees.some((a) => a?.self === true && a.responseStatus === "declined")) return null;
  const startText = event.start?.dateTime;
  if (typeof startText !== "string") return null; // all-day: start.date only
  const startsAt = Date.parse(startText);
  if (!Number.isFinite(startsAt)) return null;
  const endText = event.end?.dateTime;
  const endsAt = typeof endText === "string" && Number.isFinite(Date.parse(endText)) ? Date.parse(endText) : null;
  return {
    key: googleEventKey(calendarId, event.id),
    uid: (typeof event.iCalUID === "string" && event.iCalUID) || event.id,
    title: (typeof event.summary === "string" && event.summary.trim().slice(0, 500)) || "(без названия)",
    startsAt,
    endsAt: endsAt !== null && endsAt >= startsAt ? endsAt : null,
    url: eventMeetingUrl(event),
    status: event.status === "tentative" ? "tentative" : "confirmed",
  };
}

/** One selected Google calendar as a source for syncCalendars. */
export function googleCalendarSource(args: { calendarId: string; label: string; get: GoogleGet }): CalendarSource {
  return {
    feed: googleFeedId(args.calendarId),
    load: async (window, signal) => {
      const events = await listEvents(args.get, args.calendarId, window, signal);
      const occurrences = new Map<string, CalendarOccurrence>();
      for (const event of events) {
        const occurrence = eventOccurrence(args.calendarId, event);
        if (occurrence !== null && occurrence.startsAt >= window.from && occurrence.startsAt <= window.to) {
          occurrences.set(occurrence.key, occurrence);
        }
      }
      return [...occurrences.values()].sort((a, b) => a.startsAt - b.startsAt || a.key.localeCompare(b.key));
    },
    describeError: (error) => `Google «${args.label}»: ${describeGoogleError(error)}`,
  };
}
