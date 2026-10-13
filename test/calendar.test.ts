import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseMeetingUrl } from "../src/shared/meeting-url.js";
import {
  feedId,
  fetchIcs,
  matchesFilter,
  parseIcs,
  syncCalendars,
  zonedTimeToEpoch,
  type CalendarSyncOptions,
} from "../src/server/calendar.js";
import { MIGRATIONS, Repository, newMeetingId, type MeetingRow } from "../src/server/db.js";
import { hostCalls, load } from "./server-fixtures.js";

/** 2026-10-13 07:00 Moscow time (UTC+3). */
const NOW = Date.UTC(2026, 9, 13, 4, 0, 0);
const UID = "weekly-sync-123@google.com";
const ZOOM_WEEKLY = "https://us02web.zoom.us/j/81234567890?pwd=WeeklyPass1";

function crlf(lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/** A Google-Calendar-style feed: VTIMEZONE, folded lines, a weekly series with EXDATE and overrides. */
function googleFeed(options: { demoStart?: string } = {}): string {
  return crlf([
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Работа",
    "X-WR-TIMEZONE:Europe/Moscow",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Moscow",
    "X-LIC-LOCATION:Europe/Moscow",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0300",
    "TZOFFSETTO:+0300",
    "TZNAME:MSK",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
    // Weekly series Tue/Wed/Thu/Fri 10:00 MSK with an EXDATE and three overrides.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20260901T100000",
    "DTEND;TZID=Europe/Moscow:20260901T103000",
    "RRULE:FREQ=WEEKLY;BYDAY=TU,WE,TH,FR",
    "EXDATE;TZID=Europe/Moscow:20261014T100000",
    "DTSTAMP:20261012T120000Z",
    `UID:${UID}`,
    "CREATED:20260820T090000Z",
    "DESCRIPTION:Подключиться к конференции Zoom\\n" + ZOOM_WEEKLY.slice(0, 30),
    ` ${ZOOM_WEEKLY.slice(30)}\\n\\nИдентификатор конференции: 812 3456 7890`,
    "LOCATION:",
    "SEQUENCE:3",
    "STATUS:CONFIRMED",
    "SUMMARY:Weekly sync",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    // Today's occurrence moved from 10:00 to 12:30.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261013T123000",
    "DTEND;TZID=Europe/Moscow:20261013T130000",
    "DTSTAMP:20261012T120000Z",
    `UID:${UID}`,
    "RECURRENCE-ID;TZID=Europe/Moscow:20261013T100000",
    "SEQUENCE:4",
    "STATUS:CONFIRMED",
    "SUMMARY:Weekly sync (перенос)",
    "END:VEVENT",
    // Thursday's occurrence cancelled.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261015T100000",
    "DTEND;TZID=Europe/Moscow:20261015T103000",
    "DTSTAMP:20261012T120000Z",
    `UID:${UID}`,
    "RECURRENCE-ID;TZID=Europe/Moscow:20261015T100000",
    "STATUS:CANCELLED",
    "SUMMARY:Weekly sync",
    "END:VEVENT",
    // Next Tuesday's occurrence pulled into this week.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261015T150000",
    "DTEND;TZID=Europe/Moscow:20261015T153000",
    "DTSTAMP:20261012T120000Z",
    `UID:${UID}`,
    "RECURRENCE-ID;TZID=Europe/Moscow:20261020T100000",
    "STATUS:CONFIRMED",
    "SUMMARY:Weekly sync (раньше)",
    "END:VEVENT",
    // Single event, link in LOCATION.
    "BEGIN:VEVENT",
    `DTSTART;TZID=Europe/Moscow:${options.demoStart ?? "20261013T140000"}`,
    "DURATION:PT1H",
    "UID:demo-1@google.com",
    "LOCATION:https://zoom.us/j/91234567890?pwd=Demo42",
    "SUMMARY:Демо клиенту",
    "END:VEVENT",
    // Cancelled single event.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261013T160000",
    "DTEND;TZID=Europe/Moscow:20261013T170000",
    "UID:cancelled-1@google.com",
    "DESCRIPTION:https://zoom.us/j/71234567890",
    "STATUS:CANCELLED",
    "SUMMARY:Отменённая встреча",
    "END:VEVENT",
    // No link at all.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261013T130000",
    "DTEND;TZID=Europe/Moscow:20261013T140000",
    "UID:lunch@google.com",
    "SUMMARY:Обед",
    "END:VEVENT",
    // All-day event.
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261014",
    "DTEND;VALUE=DATE:20261015",
    "UID:vacation@google.com",
    "DESCRIPTION:https://zoom.us/j/61234567890",
    "SUMMARY:Отпуск",
    "END:VEVENT",
    // UTC time, RFC 7986 CONFERENCE property.
    "BEGIN:VEVENT",
    "DTSTART:20261013T150000Z",
    "DTEND:20261013T160000Z",
    "UID:us-sync@example.com",
    "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://zoom.us/j/99887766554?pwd=zz9",
    "SUMMARY:Sync with US",
    "END:VEVENT",
    // TZID without a VTIMEZONE: resolved through Intl.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Asia/Yekaterinburg:20261014T080000",
    "DTEND;TZID=Asia/Yekaterinburg:20261014T090000",
    "UID:ekb@example.com",
    "DESCRIPTION:Ссылка: https://zoom.us/j/51234567890.",
    "SUMMARY:Екатеринбург",
    "END:VEVENT",
    // Yesterday: outside the window.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20261012T100000",
    "DTEND;TZID=Europe/Moscow:20261012T110000",
    "UID:past@google.com",
    "LOCATION:https://zoom.us/j/41234567890",
    "SUMMARY:Вчера",
    "END:VEVENT",
    // A series that ended already.
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Moscow:20260101T110000",
    "DTEND;TZID=Europe/Moscow:20260101T120000",
    "RRULE:FREQ=DAILY;UNTIL=20261001T080000Z",
    "UID:old-series@google.com",
    "LOCATION:https://zoom.us/j/31234567890",
    "SUMMARY:Старая серия",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("parseIcs", () => {
  it("expands a Google feed: RRULE, EXDATE, moved and cancelled overrides, TZIDs", () => {
    const occurrences = parseIcs(googleFeed(), { from: NOW - 10 * 60_000, to: NOW + 4 * 24 * 3600_000 });
    expect(occurrences.map((o) => [o.title, iso(o.startsAt), o.status, o.url, o.key])).toEqual([
      ["Weekly sync (перенос)", "2026-10-13T09:30:00.000Z", "confirmed", ZOOM_WEEKLY, `${UID}#2026-10-13T07:00:00.000Z`],
      ["Демо клиенту", "2026-10-13T11:00:00.000Z", "confirmed", "https://zoom.us/j/91234567890?pwd=Demo42", "demo-1@google.com#2026-10-13T11:00:00.000Z"],
      ["Отменённая встреча", "2026-10-13T13:00:00.000Z", "cancelled", "https://zoom.us/j/71234567890", "cancelled-1@google.com#2026-10-13T13:00:00.000Z"],
      ["Обед", "2026-10-13T10:00:00.000Z", "confirmed", null, "lunch@google.com#2026-10-13T10:00:00.000Z"],
      ["Sync with US", "2026-10-13T15:00:00.000Z", "confirmed", "https://zoom.us/j/99887766554?pwd=zz9", "us-sync@example.com#2026-10-13T15:00:00.000Z"],
      ["Екатеринбург", "2026-10-14T03:00:00.000Z", "confirmed", "https://zoom.us/j/51234567890", "ekb@example.com#2026-10-14T03:00:00.000Z"],
      ["Weekly sync", "2026-10-15T07:00:00.000Z", "cancelled", ZOOM_WEEKLY, `${UID}#2026-10-15T07:00:00.000Z`],
      ["Weekly sync (раньше)", "2026-10-15T12:00:00.000Z", "confirmed", ZOOM_WEEKLY, `${UID}#2026-10-20T07:00:00.000Z`],
      ["Weekly sync", "2026-10-16T07:00:00.000Z", "confirmed", ZOOM_WEEKLY, `${UID}#2026-10-16T07:00:00.000Z`],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
    const demo = occurrences.find((o) => o.uid === "demo-1@google.com");
    expect(demo?.endsAt).toBe(Date.UTC(2026, 9, 13, 12, 0, 0));
  });

  it("does not attach overrides to other series", () => {
    const other = googleFeed().replace(
      "END:VCALENDAR",
      crlf([
        "BEGIN:VEVENT",
        "DTSTART:20261013T200000Z",
        "DTEND:20261013T203000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "UID:another@example.com",
        "URL:https://zoom.us/j/21234567890",
        "SUMMARY:Вечерний созвон",
        "END:VEVENT",
        "END:VCALENDAR",
      ]).trimEnd(),
    );
    const titles = parseIcs(other, { from: NOW, to: NOW + 24 * 3600_000 }).filter((o) => o.uid === "another@example.com");
    expect(titles.map((o) => [o.title, iso(o.startsAt)])).toEqual([["Вечерний созвон", "2026-10-13T20:00:00.000Z"]]);
  });

  it("rejects garbage", () => {
    expect(() => parseIcs("not a calendar", { from: 0, to: 1 })).toThrow();
  });

  it("converts wall time in a zone across DST", () => {
    expect(iso(zonedTimeToEpoch({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 }, "Europe/Berlin"))).toBe(
      "2026-07-01T10:00:00.000Z",
    );
    expect(iso(zonedTimeToEpoch({ year: 2026, month: 12, day: 1, hour: 12, minute: 0, second: 0 }, "Europe/Berlin"))).toBe(
      "2026-12-01T11:00:00.000Z",
    );
  });
});

describe("matchesFilter", () => {
  it("matches substrings case-insensitively and /regex/", () => {
    expect(matchesFilter("Weekly SYNC", "sync")).toBe(true);
    expect(matchesFilter("Демо клиенту", "ДЕМО")).toBe(true);
    expect(matchesFilter("Демо клиенту", "sync")).toBe(false);
    expect(matchesFilter("Weekly sync", "/^weekly/")).toBe(true);
    expect(matchesFilter("Daily", "/^weekly/")).toBe(false);
    expect(matchesFilter("x", "")).toBe(true);
    expect(matchesFilter("x", "/(/")).toBe(false);
  });
});

function memoryRepo(): Repository {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new Repository(db);
}

function syncOptions(repo: Repository, feed: string, overrides: Partial<CalendarSyncOptions> = {}): CalendarSyncOptions {
  return {
    repo,
    now: NOW,
    feeds: ["https://calendar.google.com/calendar/ical/me%40example.com/private-secret/basic.ics"],
    autoJoin: true,
    leadMinutes: 1,
    filter: "",
    fetchText: async () => feed,
    scheduleMeeting: (event, scheduledAt) =>
      repo.insertMeeting({
        id: newMeetingId(NOW),
        title: event.title,
        url: event.url ?? "",
        platform: "zoom",
        meetingNumber: null,
        botName: "Notetaker",
        source: "calendar",
        status: "scheduled",
        scheduledAt,
        createdAt: NOW,
        options: {},
        requestedByThreadId: null,
        notify: false,
        calendarKey: event.key,
      }),
    rescheduleMeeting: (meeting: MeetingRow, scheduledAt: number, title: string, url: string) => {
      repo.updateMeeting(meeting.id, { scheduledAt, title, url });
    },
    cancelMeeting: (meeting: MeetingRow, reason: string) => {
      repo.updateMeeting(meeting.id, { status: "cancelled", statusDetail: reason });
    },
    ...overrides,
  };
}

describe("syncCalendars", () => {
  it("schedules joinable occurrences of the next 24 h once, lead minutes early", async () => {
    const repo = memoryRepo();
    const result = await syncCalendars(syncOptions(repo, googleFeed()));
    expect(result.errors).toEqual([]);
    const scheduled = repo.meetingsWithStatus(["scheduled"]).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
    expect(scheduled.map((m) => [m.title, iso(m.scheduledAt ?? 0)])).toEqual([
      ["Weekly sync (перенос)", "2026-10-13T09:29:00.000Z"],
      ["Демо клиенту", "2026-10-13T10:59:00.000Z"],
      ["Sync with US", "2026-10-13T14:59:00.000Z"],
      ["Екатеринбург", "2026-10-14T02:59:00.000Z"],
    ]);
    const again = await syncCalendars(syncOptions(repo, googleFeed()));
    expect(again.created).toEqual([]);
    expect(repo.meetingsWithStatus(["scheduled"])).toHaveLength(4);
    const event = repo.calendarEvent("demo-1@google.com#2026-10-13T11:00:00.000Z");
    expect(event?.meetingId).toBe(scheduled[1]?.id);
    expect(event?.feed).toBe(feedId("https://calendar.google.com/calendar/ical/me%40example.com/private-secret/basic.ics"));
  });

  it("cancels the meeting of a moved single event and schedules the new time", async () => {
    const repo = memoryRepo();
    await syncCalendars(syncOptions(repo, googleFeed()));
    const result = await syncCalendars(syncOptions(repo, googleFeed({ demoStart: "20261013T143000" }), { now: NOW + 60_000 }));
    expect(result.created).toHaveLength(1);
    expect(result.cancelled).toHaveLength(1);
    const demos = repo.listMeetings({ statuses: null, before: null, limit: 50 }).filter((m) => m.title === "Демо клиенту");
    expect(demos.map((m) => [m.status, iso(m.scheduledAt ?? 0)]).sort()).toEqual([
      ["cancelled", "2026-10-13T10:59:00.000Z"],
      ["scheduled", "2026-10-13T11:29:00.000Z"],
    ]);
  });

  it("honours the filter and auto-join switch, and keeps going when a feed fails", async () => {
    const repo = memoryRepo();
    await syncCalendars(syncOptions(repo, googleFeed(), { filter: "/sync/i" }));
    expect(repo.meetingsWithStatus(["scheduled"]).map((m) => m.title).sort()).toEqual(["Sync with US", "Weekly sync (перенос)"]);

    const off = memoryRepo();
    const result = await syncCalendars(
      syncOptions(off, googleFeed(), {
        autoJoin: false,
        feeds: ["https://broken.example/cal.ics", "https://calendar.google.com/x.ics"],
        fetchText: async (url) => {
          if (url.includes("broken")) throw new Error("HTTP 404");
          return googleFeed();
        },
      }),
    );
    expect(result.errors).toEqual(["broken.example: HTTP 404"]);
    expect(result.events).toBeGreaterThan(0);
    expect(off.meetingsWithStatus(["scheduled"])).toEqual([]);
  });
});

describe("calendar through the plugin", () => {
  const settings = {
    calendarIcsUrls: "webcal://calendar.google.com/calendar/ical/me/private-secret/basic.ics",
    calendarAutoJoin: true,
  };

  it("syncs over RPC, lists upcoming events and schedules calendar meetings", async () => {
    const fetched: string[] = [];
    const { harness } = await load({
      settings,
      now: () => NOW,
      fetchText: async (url) => {
        fetched.push(url);
        return googleFeed();
      },
    });
    const status = (await harness.behavior.callRpc("calendar.sync", null)) as {
      configured: boolean;
      feeds: number;
      lastError: string | null;
      upcoming: Array<{ key: string; title: string; meetingId: string | null; skipped: boolean }>;
    };
    expect(fetched).toEqual(["https://calendar.google.com/calendar/ical/me/private-secret/basic.ics"]);
    expect(status).toMatchObject({ configured: true, feeds: 1, lastError: null });
    expect(status.upcoming.map((e) => e.title)).toEqual([
      "Weekly sync (перенос)",
      "Обед",
      "Демо клиенту",
      "Sync with US",
      "Екатеринбург",
    ]);
    const list = (await harness.behavior.callRpc("meetings.list", { filter: "upcoming" })) as {
      meetings: Array<{ id: string; source: string; botName: string; title: string }>;
    };
    expect(list.meetings).toHaveLength(4);
    expect(list.meetings.every((m) => m.source === "calendar" && m.botName === "Notetaker")).toBe(true);

    // Skipping cancels the scheduled bot; un-skipping schedules a new one.
    const demo = status.upcoming.find((e) => e.title === "Демо клиенту")!;
    const skipped = (await harness.behavior.callRpc("calendar.setSkip", { key: demo.key, skip: true })) as typeof status;
    expect(skipped.upcoming.find((e) => e.key === demo.key)?.skipped).toBe(true);
    const cancelled = (await harness.behavior.callRpc("meetings.get", { id: demo.meetingId })) as { meeting: { status: string } };
    expect(cancelled.meeting.status).toBe("cancelled");
    const unskipped = (await harness.behavior.callRpc("calendar.setSkip", { key: demo.key, skip: false })) as typeof status;
    const again = unskipped.upcoming.find((e) => e.key === demo.key)!;
    expect(again.skipped).toBe(false);
    expect(again.meetingId).not.toBe(demo.meetingId);
    expect(hostCalls(harness, "meeting.start")).toEqual([]);

    const cli = await harness.behavior.runCli(["calendar"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Calendars: 1, auto-join on");
    expect(cli.stdout).toContain("Демо клиенту [bot: mtg_");
    expect(cli.stdout).toContain("Обед [no Zoom link]");
  });

  it("moves a scheduled bot to the occurrence's new Zoom link", async () => {
    let feed = googleFeed();
    const { harness } = await load({ settings, now: () => NOW, fetchText: async () => feed });
    await harness.behavior.callRpc("calendar.sync", null);
    const upcoming = async () =>
      ((await harness.behavior.callRpc("meetings.list", { filter: "upcoming" })) as { meetings: Array<{ id: string; title: string }> }).meetings;
    const demo = (await upcoming()).find((m) => m.title === "Демо клиенту")!;
    const newLink = "https://zoom.us/j/81111111111?pwd=New2";
    feed = feed.replace("https://zoom.us/j/91234567890?pwd=Demo42", newLink);
    await harness.behavior.callRpc("calendar.sync", null);
    const moved = (await harness.behavior.callRpc("meetings.get", { id: demo.id })) as { meeting: { status: string; url: string; meetingNumber: string } };
    expect(moved.meeting).toMatchObject({ status: "scheduled", url: parseMeetingUrl(newLink).url, meetingNumber: "81111111111" });
    expect((await upcoming()).filter((m) => m.title === "Демо клиенту")).toHaveLength(1);
  });

  it("applies auto-join, filter and feed changes to scheduled bots right away", async () => {
    let fetches = 0;
    const { harness } = await load({
      settings,
      now: () => NOW,
      fetchText: async () => {
        fetches += 1;
        return googleFeed();
      },
    });
    await harness.behavior.callRpc("calendar.sync", null);
    const upcoming = async () =>
      ((await harness.behavior.callRpc("meetings.list", { filter: "upcoming" })) as { meetings: Array<{ id: string; title: string }> }).meetings;
    const first = await upcoming();
    expect(first).toHaveLength(4);

    await harness.behavior.setSettings({ calendarAutoJoin: false });
    expect(await upcoming()).toEqual([]);
    const off = (await harness.behavior.callRpc("meetings.get", { id: first[0]!.id })) as { meeting: { status: string; statusDetail: string } };
    expect(off.meeting).toMatchObject({ status: "cancelled", statusDetail: "Автоподключение к встречам из календаря выключено" });

    await harness.behavior.setSettings({ calendarAutoJoin: true });
    expect(await upcoming()).toHaveLength(4);
    await harness.behavior.setSettings({ calendarFilter: "/sync/i" });
    expect((await upcoming()).map((m) => m.title).sort()).toEqual(["Sync with US", "Weekly sync (перенос)"]);

    // The feed is removed: its bots go, and nothing is fetched.
    await harness.behavior.setSettings({ calendarIcsUrls: null });
    expect(await upcoming()).toEqual([]);
    expect(fetches).toBe(1);
    expect(hostCalls(harness, "meeting.start")).toEqual([]);
  });

  it("reports feed errors without the secret URL", async () => {
    const { harness } = await load({
      settings,
      now: () => NOW,
      fetchText: async () => {
        throw new Error("calendar.google.com: HTTP 401");
      },
    });
    const status = (await harness.behavior.callRpc("calendar.sync", null)) as { lastError: string };
    expect(status.lastError).toBe("calendar.google.com: HTTP 401");
    expect(status.lastError).not.toContain("private-secret");

    const quoting = await load({
      settings,
      now: () => NOW,
      fetchText: async (url) => {
        throw new Error(`Failed to parse URL from ${url}`);
      },
    });
    const leaked = (await quoting.harness.behavior.callRpc("calendar.sync", null)) as { lastError: string };
    expect(leaked.lastError).toBe("calendar.google.com: Failed to parse URL from <url>");
  });
});

describe("fetchIcs", () => {
  it("sends credentials from the URL as Basic auth and never quotes the feed URL in errors", async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.setHeader("content-type", "text/calendar");
      response.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const text = await fetchIcs(`http://alice:app%20pass@127.0.0.1:${port}/remote.php/dav/calendars/alice/personal?export`);
      expect(text).toContain("BEGIN:VCALENDAR");
      expect(seen).toEqual([`Basic ${Buffer.from("alice:app pass").toString("base64")}`]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    const refused = await fetchIcs(`http://alice:secret-pw@127.0.0.1:${port}/private-token.ics`).then(
      () => "fetched",
      (error: Error) => error.message,
    );
    expect(refused).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port}: network error`));
    expect(refused).not.toMatch(/secret|private-token|alice/);
    const invalid = await fetchIcs("https://nextcloud.example.com:99999/secret/path?token=abc").then(
      () => "fetched",
      (error: Error) => error.message,
    );
    expect(invalid).toBe("calendar: invalid feed URL");
  });
});
