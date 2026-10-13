// Calendar auto-join (docs/dev/DESIGN.md §10): fetch ICS feeds, expand the
// next 24 h of occurrences (RRULE, EXDATE, moved/cancelled overrides, TZID),
// find Zoom links, upsert calendar_events and schedule meetings.
import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { extractMeetingUrls, parseMeetingUrl } from "../shared/meeting-url.js";
import type { CalendarEventRow, MeetingRow, Repository } from "./db.js";

export const ICS_FETCH_TIMEOUT_MS = 20_000;
export const ICS_MAX_BYTES = 5 * 1024 * 1024;
/** Occurrences that started up to this long ago are still joined. */
export const CALENDAR_PAST_MS = 10 * 60_000;
export const CALENDAR_AHEAD_MS = 24 * 3600_000;
/** Hard cap on recurrence iterations per series (daily events over decades stay well below). */
const MAX_RECURRENCE_STEPS = 50_000;

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarOccurrence {
  /** uid + original occurrence start (UTC ISO); stable for moved occurrences. */
  readonly key: string;
  readonly uid: string;
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number | null;
  readonly url: string | null;
  readonly status: CalendarEventStatus;
}

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/** Stable, non-secret id for a feed URL (the URL itself is a secret). */
export function feedId(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex").slice(0, 12);
}

/** Host of a feed URL, safe for logs and error messages. */
export function feedLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "calendar";
  }
}

/** Case-insensitive substring, or /regex/flags. Empty = everything. */
export function matchesFilter(title: string, filter: string): boolean {
  const trimmed = filter.trim();
  if (trimmed === "") return true;
  const regex = /^\/(.*)\/([a-z]*)$/i.exec(trimmed);
  if (regex !== null) {
    try {
      const flags = (regex[2] ?? "").includes("i") ? regex[2] : `${regex[2] ?? ""}i`;
      return new RegExp(regex[1] ?? "", flags).test(title);
    } catch {
      return false;
    }
  }
  return title.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
}

// ---------- fetch ----------

/**
 * Fetch one feed. Error messages name the feed by host only: the URL (path,
 * query, user:password) is a secret and fetch's own messages quote it.
 */
export async function fetchIcs(url: string, signal?: AbortSignal): Promise<string> {
  const signals = [AbortSignal.timeout(ICS_FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])];
  const label = feedLabel(url);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`${label}: invalid feed URL`);
  }
  const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1", "user-agent": "bb-plugin-meetings" };
  if (target.username !== "" || target.password !== "") {
    // fetch refuses URLs with credentials: send them as HTTP Basic auth instead (Nextcloud, Radicale…).
    const user = decodeUserinfo(target.username);
    const password = decodeUserinfo(target.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
    target.username = "";
    target.password = "";
  }
  let response: Response;
  try {
    response = await fetch(target, { signal: AbortSignal.any(signals), headers, redirect: "follow" });
  } catch (error) {
    throw new Error(`${label}: ${fetchFailure(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > ICS_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label}: the feed is larger than 5 MB`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ICS_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label}: the feed is larger than 5 MB`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Why fetch failed, without its message (it quotes the URL). */
function fetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timed out after 20 s";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(cause.code) ? cause.code : null;
  if (code === "ERR_INVALID_URL") return "invalid feed URL";
  return code === null ? "network error" : `network error (${code})`;
}

/** Feed errors are shown in the UI, the CLI and logs: never with a URL in them. */
function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
}

// ---------- parse ----------

/** Outlook writes Windows zone names; the common ones mapped to IANA. */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  "Russian Standard Time": "Europe/Moscow",
  "Russia Time Zone 3": "Europe/Samara",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central European Standard Time": "Europe/Warsaw",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "FLE Standard Time": "Europe/Kiev",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  UTC: "UTC",
};

function ianaZone(tzid: string | null): string | null {
  if (tzid === null || tzid === "") return null;
  const cleaned = tzid.replace(/^\/+/, "").replace(/^"|"$/g, "");
  const candidate = WINDOWS_ZONES[cleaned] ?? cleaned;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Wall-clock time in an IANA zone → epoch ms (DST-correct). */
export function zonedTimeToEpoch(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

/**
 * ical.js resolves TZIDs through the VTIMEZONEs in the file. A TZID without a
 * VTIMEZONE turns into a floating time; resolve it with Intl when the TZID is
 * an IANA (or common Windows) name, otherwise take the server's local zone.
 */
function toEpoch(time: ICAL.Time, tzidHint: string | null): number {
  const tzid = time.zone?.tzid;
  if (tzid !== undefined && tzid !== "floating") return time.toUnixTime() * 1000;
  const zone = ianaZone(tzidHint);
  const wall = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
  if (zone !== null) return zonedTimeToEpoch(wall, zone);
  return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second).getTime();
}

function tzidOf(component: ICAL.Component, property: string): string | null {
  const value = component.getFirstProperty(property)?.getParameter("tzid");
  return typeof value === "string" ? value : null;
}

function textValues(component: ICAL.Component, property: string): string[] {
  const out: string[] = [];
  for (const prop of component.getAllProperties(property)) {
    for (const value of prop.getValues()) {
      if (typeof value === "string") out.push(value);
      else if (value !== null && value !== undefined) out.push(String(value));
    }
  }
  return out;
}

/** The first joinable Zoom link, by field priority. */
function findMeetingUrl(components: readonly ICAL.Component[]): string | null {
  const fields = ["conference", "x-google-conference", "url", "location", "description", "x-alt-desc"];
  for (const component of components) {
    for (const field of fields) {
      for (const text of textValues(component, field)) {
        const [first] = extractMeetingUrls(text);
        if (first !== undefined) return first;
      }
    }
  }
  return null;
}

function statusOf(component: ICAL.Component): CalendarEventStatus {
  const value = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (value === "CANCELLED") return "cancelled";
  if (value === "TENTATIVE") return "tentative";
  return "confirmed";
}

function occurrenceKey(uid: string, originalStart: number): string {
  return `${uid}#${new Date(originalStart).toISOString()}`;
}

function rootComponents(text: string): ICAL.Component[] {
  const parsed: unknown = ICAL.parse(text);
  // ICAL.parse returns one component, or an array when the text has several.
  const list = Array.isArray(parsed) && Array.isArray(parsed[0]) ? (parsed as unknown[]) : [parsed];
  return list.map((jcal) => new ICAL.Component(jcal as never));
}

/**
 * Occurrences starting inside `window` with their Zoom links. Recurring
 * series honour EXDATE and per-occurrence overrides (moved or cancelled).
 */
export function parseIcs(text: string, window: TimeWindow): CalendarOccurrence[] {
  const occurrences = new Map<string, CalendarOccurrence>();
  for (const root of rootComponents(text)) {
    for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
      try {
        ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone));
      } catch {
        // a broken VTIMEZONE only affects its own events
      }
    }
    const vevents = root.getAllSubcomponents("vevent");
    const exceptionsByUid = new Map<string, ICAL.Component[]>();
    const masters: ICAL.Component[] = [];
    for (const vevent of vevents) {
      if (vevent.hasProperty("recurrence-id")) {
        const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
        const list = exceptionsByUid.get(uid) ?? [];
        list.push(vevent);
        exceptionsByUid.set(uid, list);
      } else {
        masters.push(vevent);
      }
    }

    const add = (occurrence: CalendarOccurrence) => {
      if (occurrence.startsAt >= window.from && occurrence.startsAt <= window.to) occurrences.set(occurrence.key, occurrence);
    };

    const mastersByUid = new Map<string, ICAL.Component>();
    for (const vevent of masters) {
      try {
        const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
        if (uid === "" || !vevent.hasProperty("dtstart")) continue;
        mastersByUid.set(uid, vevent);
        const event = new ICAL.Event(vevent, { strictExceptions: true, exceptions: exceptionsByUid.get(uid) ?? [] });
        if (event.startDate.isDate) continue; // all-day events have no meeting to join
        const tzid = tzidOf(vevent, "dtstart");
        const title = event.summary || "(без названия)";
        const url = findMeetingUrl([vevent]);
        const status = statusOf(vevent);
        if (!event.isRecurring()) {
          const startsAt = toEpoch(event.startDate, tzid);
          add({
            key: occurrenceKey(uid, startsAt),
            uid,
            title,
            startsAt,
            endsAt: event.endDate ? toEpoch(event.endDate, tzidOf(vevent, "dtend") ?? tzid) : null,
            url,
            status,
          });
          continue;
        }
        const durationMs = event.duration ? event.duration.toSeconds() * 1000 : 0;
        const exceptions = event.exceptions as unknown as Record<string, ICAL.Event>;
        const iterator = event.iterator();
        for (let step = 0; step < MAX_RECURRENCE_STEPS; step += 1) {
          const next = iterator.next();
          if (!next) break;
          const originalStart = toEpoch(next, tzid);
          if (originalStart > window.to + CALENDAR_AHEAD_MS) break;
          if (originalStart < window.from - 7 * 24 * 3600_000) continue; // far past: skip the details lookup
          const utcId = next.convertToZone(ICAL.Timezone.utcTimezone).toString();
          if (next.toString() in exceptions || utcId in exceptions) continue; // overrides are added below
          const details = event.getOccurrenceDetails(next);
          const startsAt = toEpoch(details.startDate, tzid);
          add({
            key: occurrenceKey(uid, originalStart),
            uid,
            title,
            startsAt,
            endsAt: details.endDate ? toEpoch(details.endDate, tzid) : startsAt + durationMs,
            url,
            status,
          });
        }
      } catch {
        // skip one malformed event, keep the rest of the feed
      }
    }

    for (const [uid, components] of exceptionsByUid) {
      const master = mastersByUid.get(uid) ?? null;
      for (const vevent of components) {
        try {
          const exception = new ICAL.Event(vevent, { exceptions: [] });
          if (exception.startDate.isDate) continue;
          const tzid = tzidOf(vevent, "dtstart");
          const originalStart = toEpoch(exception.recurrenceId, tzidOf(vevent, "recurrence-id") ?? tzid);
          const startsAt = toEpoch(exception.startDate, tzid);
          const masterStatus = master === null ? "confirmed" : statusOf(master);
          const ownStatus = statusOf(vevent);
          add({
            key: occurrenceKey(uid, originalStart),
            uid,
            title: exception.summary || (master === null ? "" : String(master.getFirstPropertyValue("summary") ?? "")) || "(без названия)",
            startsAt,
            endsAt: exception.endDate ? toEpoch(exception.endDate, tzidOf(vevent, "dtend") ?? tzid) : null,
            url: findMeetingUrl(master === null ? [vevent] : [vevent, master]),
            status: ownStatus === "cancelled" || masterStatus === "cancelled" ? "cancelled" : ownStatus,
          });
        } catch {
          // skip one malformed override
        }
      }
    }
  }
  return [...occurrences.values()].sort((a, b) => a.startsAt - b.startsAt || a.key.localeCompare(b.key));
}

// ---------- sync ----------

export interface CalendarSyncOptions {
  readonly repo: Repository;
  readonly now: number;
  readonly feeds: readonly string[];
  readonly autoJoin: boolean;
  readonly leadMinutes: number;
  readonly filter: string;
  readonly signal?: AbortSignal;
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
  /** Create a scheduled meeting (source "calendar") for an occurrence. */
  scheduleMeeting(event: CalendarEventRow, scheduledAt: number): MeetingRow;
  /** Update a still-scheduled meeting when its occurrence moved, was renamed or got another link. */
  rescheduleMeeting(meeting: MeetingRow, scheduledAt: number, title: string, url: string): void;
  /** Cancel a still-scheduled meeting (occurrence cancelled, removed or skipped). */
  cancelMeeting(meeting: MeetingRow, reason: string): void;
}

export interface CalendarSyncResult {
  readonly events: number;
  readonly created: string[];
  readonly cancelled: string[];
  readonly errors: string[];
}

export function syncWindow(now: number): TimeWindow {
  return { from: now - CALENDAR_PAST_MS, to: now + CALENDAR_AHEAD_MS };
}

export async function syncCalendars(options: CalendarSyncOptions): Promise<CalendarSyncResult> {
  const { repo, now } = options;
  const window = syncWindow(now);
  const created: string[] = [];
  const cancelled: string[] = [];
  const errors: string[] = [];
  let events = 0;
  const seen = new Set<string>();
  const syncedFeeds = new Set<string>();

  for (const url of options.feeds) {
    const feed = feedId(url);
    let occurrences: CalendarOccurrence[];
    try {
      occurrences = parseIcs(await options.fetchText(url, options.signal), window);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const text = redactUrls(errorText(error));
      errors.push(text.startsWith(feedLabel(url)) ? text : `${feedLabel(url)}: ${text}`);
      continue;
    }
    syncedFeeds.add(feed);
    for (const occurrence of occurrences) {
      events += 1;
      seen.add(occurrence.key);
      const row = repo.upsertCalendarEvent({
        key: occurrence.key,
        uid: occurrence.uid,
        feed,
        title: occurrence.title,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        url: occurrence.url,
        status: occurrence.status,
        updatedAt: now,
      });
      const outcome = applyAutoJoin(row, options);
      if (outcome?.created) created.push(outcome.created);
      if (outcome?.cancelled) cancelled.push(outcome.cancelled);
    }
  }

  // Occurrences that disappeared from a feed that synced fine: deleted or moved out of the window.
  for (const row of repo.calendarEventsBetween(window.from, window.to)) {
    if (!syncedFeeds.has(row.feed) || seen.has(row.key) || row.updatedAt >= now) continue;
    repo.setCalendarEventFields(row.key, { status: "cancelled" });
    const meeting = linkedMeeting(repo, row);
    if (meeting !== null && meeting.status === "scheduled") {
      options.cancelMeeting(meeting, "Событие удалено из календаря или перенесено");
      cancelled.push(meeting.id);
    }
  }
  repo.pruneCalendarEvents(now - 2 * 24 * 3600_000);
  return { events, created, cancelled, errors };
}

/** The link as a meeting stores it (normalized), or null. */
function joinableUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return parseMeetingUrl(url).url;
  } catch {
    return null;
  }
}

function linkedMeeting(repo: Repository, row: CalendarEventRow): MeetingRow | null {
  if (row.meetingId !== null) {
    const meeting = repo.getMeeting(row.meetingId);
    if (meeting !== null) return meeting;
  }
  return repo.meetingByCalendarKey(row.key);
}

/** Create, move or cancel the scheduled meeting for one occurrence. */
export function applyAutoJoin(
  row: CalendarEventRow,
  options: Pick<CalendarSyncOptions, "repo" | "now" | "autoJoin" | "leadMinutes" | "filter" | "scheduleMeeting" | "rescheduleMeeting" | "cancelMeeting">,
): { created?: string; cancelled?: string } | null {
  const { repo, now } = options;
  const meeting = linkedMeeting(repo, row);
  const wanted =
    row.status !== "cancelled" && !row.skipped && row.url !== null && matchesFilter(row.title, options.filter);
  const scheduledAt = Math.max(0, row.startsAt - options.leadMinutes * 60_000);

  // A cancelled bot (skipped, filtered out, event cancelled) is replaced when the occurrence is wanted again.
  if (meeting !== null && meeting.status !== "cancelled") {
    if (row.meetingId !== meeting.id) repo.setCalendarEventFields(row.key, { meetingId: meeting.id });
    if (meeting.status !== "scheduled") return null;
    if (!wanted || !options.autoJoin) {
      const reason =
        row.status === "cancelled"
          ? "Событие отменено в календаре"
          : row.skipped
            ? "Пропущено"
            : !options.autoJoin
              ? "Автоподключение к встречам из календаря выключено"
              : row.url === null
                ? "У события больше нет ссылки Zoom"
                : "Не подходит под фильтр календаря";
      options.cancelMeeting(meeting, reason);
      return { cancelled: meeting.id };
    }
    const url = joinableUrl(row.url) ?? meeting.url;
    if (meeting.scheduledAt !== scheduledAt || meeting.title !== row.title || meeting.url !== url) {
      options.rescheduleMeeting(meeting, scheduledAt, row.title, url);
    }
    return null;
  }
  if (!options.autoJoin || !wanted) return null;
  if (row.startsAt < now - CALENDAR_PAST_MS) return null;
  const createdMeeting = options.scheduleMeeting(row, scheduledAt);
  repo.setCalendarEventFields(row.key, { meetingId: createdMeeting.id });
  return { created: createdMeeting.id };
}
