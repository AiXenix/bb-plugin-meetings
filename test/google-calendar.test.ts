import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  GoogleApiError,
  describeGoogleError,
  eventMeetingUrl,
  eventOccurrence,
  googleFeedId,
  stripHtml,
  type GoogleEvent,
} from "../src/server/google-calendar.js";
import { resolveSelection } from "../src/server/google-service.js";
import { botConfigSchema } from "../src/shared/runtime-files.js";
import type { CalendarStatus, GoogleStatus } from "../src/shared/rpc-contract.js";
import { FakeGoogle, hostCalls, load, until } from "./server-fixtures.js";

const NOW = Date.UTC(2026, 9, 13, 7, 0, 0);
const PRIMARY = "anna@example.com";
const TEAM = "team@group.calendar.google.com";
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function event(id: string, startMin: number, lengthMin: number, extra: Partial<GoogleEvent> = {}): GoogleEvent {
  return { id, status: "confirmed", summary: id, start: { dateTime: at(startMin) }, end: { dateTime: at(startMin + lengthMin) }, ...extra };
}

describe("Google events → occurrences", () => {
  it("skips cancelled, non-default, declined and all-day events", () => {
    const base = event("e1", 60, 30, { location: "https://zoom.us/j/81234567001" });
    expect(eventOccurrence(PRIMARY, base)).toEqual({
      key: "gcal:anna@example.com:e1",
      uid: "e1",
      title: "e1",
      startsAt: NOW + 3600_000,
      endsAt: NOW + 5400_000,
      url: "https://zoom.us/j/81234567001",
      status: "confirmed",
    });
    expect(eventOccurrence(PRIMARY, { ...base, status: "cancelled" })).toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, eventType: "focusTime" })).toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, eventType: "outOfOffice" })).toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, eventType: "default" })).not.toBeNull();
    expect(
      eventOccurrence(PRIMARY, { ...base, attendees: [{ self: true, responseStatus: "declined" }, { responseStatus: "accepted" }] }),
    ).toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, attendees: [{ responseStatus: "declined" }, { self: true, responseStatus: "needsAction" }] })).not.toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, start: { date: "2026-10-13" }, end: { date: "2026-10-14" } })).toBeNull();
    expect(eventOccurrence(PRIMARY, { ...base, status: "tentative", summary: undefined, iCalUID: "abc@google.com" })).toMatchObject({
      status: "tentative",
      title: "(без названия)",
      uid: "abc@google.com",
    });
  });

  it("takes the Zoom link from conferenceData, then location, then the HTML description", () => {
    const conference: GoogleEvent = {
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1-646-558-8656,,81234567890#" },
          { entryPointType: "more", uri: "https://zoom.us/j/81234567999" },
          { entryPointType: "video", uri: "https://us02web.zoom.us/j/81234567890?pwd=Conf1" },
        ],
      },
      location: "https://zoom.us/j/81234567111",
    };
    expect(eventMeetingUrl(conference)).toBe("https://us02web.zoom.us/j/81234567890?pwd=Conf1");
    expect(eventMeetingUrl({ location: "Переговорка 3, https://zoom.us/j/81234567111" })).toBe("https://zoom.us/j/81234567111");
    const description =
      'Присоединиться: <a href="https://us02web.zoom.us/j/81234567222?pwd=Ab1&amp;from=addon">ссылка Zoom</a><br>Код: 1234';
    expect(eventMeetingUrl({ location: "Офис", description })).toBe("https://us02web.zoom.us/j/81234567222?pwd=Ab1&from=addon");
    expect(eventMeetingUrl({ description: "Без ссылки <b>вообще</b>" })).toBeNull();
    expect(stripHtml("a&nbsp;b<br/>c&#33; &#x41; &lt;tag&gt;")).toBe("a b\nc! A <tag>");
  });

  it("names feeds by a hash of the calendar id and resolves the primary calendar", () => {
    expect(googleFeedId(PRIMARY)).toBe(`gcal:${createHash("sha256").update(PRIMARY).digest("hex").slice(0, 12)}`);
    const calendars = [
      { id: PRIMARY, summary: PRIMARY, primary: true, color: null },
      { id: TEAM, summary: "Команда", primary: false, color: null },
    ];
    expect(resolveSelection(["primary"], calendars)).toEqual([PRIMARY]);
    expect(resolveSelection(["primary", PRIMARY, TEAM, "gone@group.calendar.google.com"], calendars)).toEqual([PRIMARY, TEAM]);
    expect(resolveSelection(["primary"], [])).toEqual(["primary"]);
  });

  it("explains Google errors in Russian", () => {
    expect(describeGoogleError(new GoogleApiError(403, "accessNotConfigured", "Calendar API has not been used in project 1"))).toContain(
      "Google Calendar API не включён",
    );
    expect(describeGoogleError(new GoogleApiError(429, "rateLimitExceeded", "Rate Limit Exceeded"))).toContain("ограничил число запросов");
    expect(describeGoogleError(new GoogleApiError(503, "backendError", "Backend Error"))).toBe("Google временно недоступен (HTTP 503)");
    expect(describeGoogleError(new GoogleApiError(404, "notFound", "Not Found"))).toContain("Календарь не найден");
  });
});

describe("Google Calendar sync through the plugin", () => {
  let google: FakeGoogle | null = null;
  afterEach(async () => {
    await google?.stop();
    google = null;
  });

  async function connected(settings: Record<string, string | number | boolean> = {}, fetchText?: (url: string) => Promise<string>) {
    google = await new FakeGoogle().start();
    const fake = google;
    let clock = NOW;
    const loaded = await load({
      now: () => clock,
      googleEndpoints: fake.endpoints,
      fetchText,
      settings: { googleClientId: fake.clientId, googleClientSecret: fake.clientSecret, calendarAutoJoin: true, ...settings },
    });
    const { harness, service } = loaded;
    const start = (await harness.behavior.callRpc("google.authStart", { origin: "https://bb.example" })) as { authUrl: string };
    const { code, state } = fake.approve(start.authUrl);
    const page = await harness.behavior.fetchHttp("GET", `/google/callback?code=${code}&state=${state}`);
    expect(page.status).toBe(200);
    await until(() => fake.calls("/calendar/v3/users/me/calendarList").length > 0);
    await service.calendar.idle();
    const rpc = harness.behavior.callRpc.bind(harness.behavior);
    return {
      ...loaded,
      google: fake,
      advance: (ms: number) => (clock += ms),
      status: async () => (await rpc("google.status", null)) as GoogleStatus,
      calendar: async () => (await rpc("calendar.status", null)) as CalendarStatus,
      sync: async () => (await rpc("google.sync", null)) as GoogleStatus,
      meetings: async () =>
        ((await rpc("meetings.list", { filter: "all" })) as {
          meetings: Array<{ id: string; title: string; status: string; statusDetail: string | null; scheduledAt: number | null; source: string }>;
        }).meetings,
      detail: async (id: string) =>
        ((await rpc("meetings.get", { id })) as { meeting: { calendarEventKey: string | null; maxDurationMinutes: number; status: string } }).meeting,
    };
  }

  function primaryEvents(): GoogleEvent[] {
    return [
      event("standup", 120, 30, {
        summary: "Стендап",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://us02web.zoom.us/j/81234567001?pwd=Stand1" }] },
      }),
      event("declined", 180, 60, {
        summary: "Отклонённая",
        location: "https://zoom.us/j/81234567002",
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
      { id: "vacation", status: "confirmed", summary: "Отпуск", start: { date: "2026-10-13" }, end: { date: "2026-10-14" }, location: "https://zoom.us/j/81234567003" },
      event("cancelled", 200, 30, { status: "cancelled", summary: "Отменённая", location: "https://zoom.us/j/81234567004" }),
      event("focus", 240, 60, { eventType: "focusTime", summary: "Фокус", location: "https://zoom.us/j/81234567005" }),
      event("demo", 300, 60, {
        summary: "Демо",
        description: '<p>Ссылка: <a href="https://zoom.us/j/81234567006?pwd=Demo&amp;x=1">Zoom</a></p>',
      }),
      event("lunch", 330, 60, { summary: "Обед" }),
      event("tomorrow", 26 * 60, 60, { summary: "Послезавтра", location: "https://zoom.us/j/81234567007" }),
    ];
  }

  it("schedules Zoom events of the watched calendar with lead times, gcal keys and upcoming entries", async () => {
    const loaded = await connected({ calendarLeadMinutes: 2 });
    loaded.google.events.set(PRIMARY, primaryEvents());
    await loaded.sync();
    const { meetings, calendar, status, google: fake, detail } = loaded;

    const scheduled = (await meetings()).filter((m) => m.status === "scheduled").sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
    expect(scheduled.map((m) => [m.title, m.source, m.scheduledAt])).toEqual([
      ["Стендап", "calendar", NOW + 118 * 60_000],
      ["Демо", "calendar", NOW + 298 * 60_000],
    ]);
    expect((await detail(scheduled[0]!.id)).calendarEventKey).toBe("gcal:anna@example.com:standup");

    const upcoming = (await calendar()).upcoming;
    expect(upcoming.map((e) => [e.key, e.title, e.url])).toEqual([
      ["gcal:anna@example.com:standup", "Стендап", "https://us02web.zoom.us/j/81234567001?pwd=Stand1"],
      ["gcal:anna@example.com:demo", "Демо", "https://zoom.us/j/81234567006?pwd=Demo&x=1"],
      ["gcal:anna@example.com:lunch", "Обед", null],
    ]);
    expect((await calendar()).configured).toBe(true);
    expect((await status()).upcomingCount).toBe(2);

    const request = fake.calls(`/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`).at(-1);
    expect(request?.query).toEqual({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(NOW - 10 * 60_000).toISOString(),
      timeMax: new Date(NOW + 24 * 3600_000 + 1).toISOString(),
      maxResults: "250",
    });
    expect(fake.calls("/calendar/v3/users/me/calendarList").at(-1)?.query).toMatchObject({ maxResults: "250" });

    // The agent API and the CLI see both the events and the connection.
    const api = await loaded.harness.behavior.runCli(["api", "--request", '{"action":"calendar"}', "--json"]);
    const body = JSON.parse(api.stdout) as { upcoming: Array<{ source: string; url: string | null }>; google: Record<string, unknown> };
    expect(body.upcoming[0]).toMatchObject({ source: "google", url: "https://us02web.zoom.us/j/81234567001?pwd=***" });
    expect(body.google).toMatchObject({ connected: true, email: PRIMARY, watchedCalendars: [PRIMARY], upcomingCount: 2 });
    const cli = await loaded.harness.behavior.runCli(["google", "status"]);
    expect(cli.stdout).toContain(`Google Calendar: connected as ${PRIMARY}`);
    expect(cli.stdout).toContain(`Watched calendars: ${PRIMARY} (primary) [1 of 2]`);
    expect(cli.stdout).toContain("Upcoming Zoom meetings in the next 24 h: 2");
  });

  it("keeps known events and bots when Google fails, and drops removed events once it works again", async () => {
    const loaded = await connected();
    const { google: fake, meetings, calendar, sync, advance } = loaded;
    fake.events.set(PRIMARY, primaryEvents());
    await sync();
    expect((await meetings()).filter((m) => m.status === "scheduled")).toHaveLength(2);

    fake.failCalendar = { status: 503, reason: "backendError" };
    const failed = await sync();
    expect(failed.lastError).toBe("Google: Google временно недоступен (HTTP 503); Google «anna@example.com»: Google временно недоступен (HTTP 503)");
    expect((await meetings()).filter((m) => m.status === "scheduled")).toHaveLength(2);
    expect((await calendar()).upcoming).toHaveLength(3);
    expect((await calendar()).lastError).toBeNull();

    fake.failCalendar = { status: 403, reason: "accessNotConfigured" };
    expect((await sync()).lastError).toContain("Google Calendar API не включён в проекте Google Cloud");
    expect((await meetings()).filter((m) => m.status === "scheduled")).toHaveLength(2);

    fake.failCalendar = null;
    fake.events.set(PRIMARY, primaryEvents().filter((e) => e.id !== "demo"));
    advance(60_000);
    expect((await sync()).lastError).toBeNull();
    const demo = (await meetings()).find((m) => m.title === "Демо");
    expect(demo).toMatchObject({ status: "cancelled", statusDetail: "Событие удалено из календаря или перенесено" });
    expect((await meetings()).find((m) => m.title === "Стендап")?.status).toBe("scheduled");
  });

  it("watches the chosen calendars: deselected ones lose their bots, new ones are fetched", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, harness } = loaded;
    fake.events.set(PRIMARY, primaryEvents());
    fake.events.set(TEAM, [event("retro", 90, 60, { summary: "Ретро", location: "https://zoom.us/j/81234567010" })]);
    await sync();
    expect((await meetings()).map((m) => m.title).sort()).toEqual(["Демо", "Стендап"]);

    const status = (await harness.behavior.callRpc("google.setCalendars", { calendarIds: [TEAM, "unknown@example.com"] })) as GoogleStatus;
    expect(status.calendars.map((c) => [c.id, c.selected])).toEqual([
      [PRIMARY, false],
      [TEAM, true],
    ]);
    const byTitle = async (title: string) => (await meetings()).find((m) => m.title === title);
    expect(await byTitle("Стендап")).toMatchObject({ status: "cancelled", statusDetail: "Календарь Google больше не отслеживается" });
    await until(() => fake.calls(`/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`).length > 0);
    await loaded.service.calendar.idle();
    expect(await byTitle("Ретро")).toMatchObject({ status: "scheduled" });
    expect((await loaded.calendar()).upcoming.map((e) => e.key)).toEqual(["gcal:team@group.calendar.google.com:retro"]);
  });

  it("schedules one bot for a meeting that is in two watched calendars", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, harness } = loaded;
    const shared = { summary: "Общая встреча", location: "https://zoom.us/j/81234567020?pwd=Both" };
    fake.events.set(PRIMARY, [event("mine", 60, 30, shared)]);
    fake.events.set(TEAM, [event("theirs", 60, 30, shared)]);
    await harness.behavior.callRpc("google.setCalendars", { calendarIds: [PRIMARY, TEAM] });
    await loaded.service.calendar.idle();
    await sync();
    expect((await meetings()).filter((m) => m.status === "scheduled").map((m) => m.title)).toEqual(["Общая встреча"]);
    expect((await loaded.calendar()).upcoming).toHaveLength(2);
  });

  it("keeps a meeting in two watched calendars cancelled, skipped or stopped across syncs", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, harness, calendar, advance, service } = loaded;
    const rpc = harness.behavior.callRpc.bind(harness.behavior);
    const shared = { summary: "Общая встреча", location: "https://zoom.us/j/81234567020?pwd=Both" };
    fake.events.set(PRIMARY, [event("mine", 60, 30, shared), event("later", 180, 30, { ...shared, summary: "Вторая" })]);
    fake.events.set(TEAM, [event("theirs", 60, 30, shared), event("later-team", 180, 30, { ...shared, summary: "Вторая" })]);
    await rpc("google.setCalendars", { calendarIds: [PRIMARY, TEAM] });
    await service.calendar.idle();
    await sync();
    const scheduled = async () => (await meetings()).filter((m) => m.status === "scheduled");
    expect((await scheduled()).map((m) => m.title).sort()).toEqual(["Вторая", "Общая встреча"]);

    // Cancelling the bot skips the meeting in both calendars: the twin does not get a new one.
    const first = (await scheduled()).find((m) => m.title === "Общая встреча")!;
    await rpc("meetings.cancel", { id: first.id });
    advance(60_000);
    await sync();
    expect((await scheduled()).map((m) => m.title)).toEqual(["Вторая"]);
    // The twin is shown skipped too, and un-skipping it brings exactly one bot back.
    const shown = (await calendar()).upcoming.filter((e) => e.title === "Общая встреча");
    expect(shown.map((e) => e.skipped)).toEqual([true, true]);
    const twinKey = shown.find((e) => e.key.includes(TEAM))!.key;
    await rpc("calendar.setSkip", { key: twinKey, skip: false });
    expect((await scheduled()).map((m) => m.title).sort()).toEqual(["Вторая", "Общая встреча"]);
    advance(60_000);
    await sync();
    expect((await scheduled()).map((m) => m.title).sort()).toEqual(["Вторая", "Общая встреча"]);

    // Skipping the occurrence that does not own the bot skips the bot.
    const second = (await scheduled()).find((m) => m.title === "Вторая")!;
    const upcoming = (await calendar()).upcoming.filter((e) => e.title === "Вторая");
    expect(upcoming.map((e) => e.meetingId)).toEqual([second.id, second.id]);
    const ownKey = (await detail(second.id)).calendarEventKey;
    const otherKey = upcoming.find((e) => e.key !== ownKey)!.key;
    await rpc("calendar.setSkip", { key: otherKey, skip: true });
    expect((await meetings()).find((m) => m.id === second.id)).toMatchObject({ status: "cancelled", statusDetail: "Пропущено" });
    advance(60_000);
    await sync();
    expect((await scheduled()).map((m) => m.title)).toEqual(["Общая встреча"]);

    // Stopping the bot at the start (before it recorded) is not undone either.
    const third = (await scheduled())[0]!;
    advance(third.scheduledAt! - (NOW + 3 * 60_000));
    await service.tick();
    expect((await meetings()).find((m) => m.id === third.id)?.status).toBe("starting");
    await rpc("meetings.stop", { id: third.id });
    expect((await meetings()).find((m) => m.id === third.id)).toMatchObject({ status: "cancelled", statusDetail: "Остановлено до начала записи" });
    advance(3 * 60_000);
    await sync();
    expect(await scheduled()).toEqual([]);

    async function detail(id: string) {
      return ((await rpc("meetings.get", { id })) as { meeting: { calendarEventKey: string | null } }).meeting;
    }
  });

  it("does not send another bot after the user stopped one before it recorded", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, harness, advance, service } = loaded;
    fake.events.set(PRIMARY, [event("solo", 10, 30, { summary: "Одна", location: "https://zoom.us/j/81234567021" })]);
    await sync();
    advance(10 * 60_000);
    await service.tick();
    const [bot] = await meetings();
    await harness.behavior.callRpc("meetings.stop", { id: bot!.id });
    advance(3 * 60_000);
    await sync();
    expect((await meetings()).map((m) => [m.id, m.status])).toEqual([[bot!.id, "cancelled"]]);
  });

  it("gives back-to-back events in one personal room a bot each, capped by its own event", async () => {
    const loaded = await connected({ maxDurationMinutes: 240 });
    const { google: fake, meetings, sync, detail } = loaded;
    const room = "https://zoom.us/j/81234567777";
    fake.events.set(PRIMARY, [event("sync", 60, 15, { summary: "Sync", location: room }), event("big", 75, 90, { summary: "Big", location: room })]);
    await sync();
    const bots = (await meetings()).filter((m) => m.status === "scheduled");
    expect(bots.map((m) => m.title).sort()).toEqual(["Big", "Sync"]);
    const caps = Object.fromEntries(await Promise.all(bots.map(async (m) => [m.title, (await detail(m.id)).maxDurationMinutes] as const)));
    expect(caps).toEqual({ Sync: 75, Big: 150 });
  });

  it("joins an event once when an ICS feed of the same calendar is still configured", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:shared-1@google.com",
      `DTSTART:${new Date(NOW + 3600_000).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      `DTEND:${new Date(NOW + 5400_000).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      "SUMMARY:Планёрка",
      "DESCRIPTION:Ссылка: https://zoom.us/j/81234567040?pwd=Ics",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const loaded = await connected({ calendarIcsUrls: "https://calendar.google.com/calendar/ical/x/private-y/basic.ics" }, async () => ics);
    const { google: fake, meetings, sync, harness, advance } = loaded;
    // Google lists the same event (same iCalUID) with the link from conferenceData; it was moved by 5 min there already.
    fake.events.set(PRIMARY, [
      event("ev1", 65, 25, {
        summary: "Планёрка",
        iCalUID: "shared-1@google.com",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://us02web.zoom.us/j/81234567040?pwd=Ics" }] },
      }),
    ]);
    await harness.behavior.callRpc("calendar.sync", null);
    await sync();
    const scheduled = async () => (await meetings()).filter((m) => m.status === "scheduled");
    expect(await scheduled()).toHaveLength(1);
    await harness.behavior.callRpc("meetings.cancel", { id: (await scheduled())[0]!.id });
    advance(60_000);
    await sync();
    expect(await scheduled()).toEqual([]);
  });

  it("keeps a calendar selection made while calendarList is loading", async () => {
    const loaded = await connected();
    const { google: fake, harness, status, service } = loaded;
    // calendarList is slow: the sync is still waiting for it when the user picks another calendar.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.gate = async (path) => {
      if (path.endsWith("/calendarList")) await held;
    };
    const lists = fake.calls("/calendar/v3/users/me/calendarList").length;
    const running = service.calendar.sync();
    await until(() => fake.calls("/calendar/v3/users/me/calendarList").length > lists);
    await harness.behavior.callRpc("google.setCalendars", { calendarIds: [TEAM] });
    release();
    await running;
    await service.calendar.idle();
    await until(() => fake.calls(`/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`).length > 0);
    await service.calendar.idle();
    expect((await status()).calendars.map((c) => [c.id, c.selected])).toEqual([
      [PRIMARY, false],
      [TEAM, true],
    ]);
  });

  it("follows every page of calendarList and events.list; an unfinished listing keeps the known events", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, status } = loaded;
    fake.pageSize = 1;
    fake.calendars = [...fake.calendars, { id: "hidden@group.calendar.google.com", summary: "Скрытый", hidden: true, accessRole: "reader" }];
    const filler = Array.from({ length: 4 }, (_, i) => event(`filler${i}`, 30 + i, 10, { summary: `Без ссылки ${i}` }));
    fake.events.set(PRIMARY, [...filler, event("late", 600, 30, { summary: "Поздняя", location: "https://zoom.us/j/81234567099" })]);
    fake.events.set("hidden@group.calendar.google.com", [event("h1", 120, 30, { summary: "Из скрытого", location: "https://zoom.us/j/81234567098" })]);
    await sync();
    // Hidden in Google's own list: not offered in the picker (as in Google Calendar), but one watched stays watched.
    expect((await status()).calendars.map((c) => c.id)).toEqual([PRIMARY, TEAM]);
    await loaded.harness.behavior.callRpc("google.setCalendars", { calendarIds: [PRIMARY, "hidden@group.calendar.google.com"] });
    await loaded.service.calendar.idle();
    await sync();
    expect((await meetings()).filter((m) => m.status === "scheduled").map((m) => m.title).sort()).toEqual(["Из скрытого", "Поздняя"]);
    // A calendar hidden in Google's own list stays watched (and shown in the picker while watched).
    expect(fake.calls("/calendar/v3/users/me/calendarList").at(-1)?.query).toMatchObject({ showHidden: "true" });
    expect((await status()).calendars.map((c) => [c.id, c.selected])).toEqual([
      [PRIMARY, true],
      [TEAM, false],
      ["hidden@group.calendar.google.com", true],
    ]);

    // Google keeps handing out pages: the listing is not taken as complete, nothing is cancelled.
    fake.events.set(PRIMARY, [...Array.from({ length: 12 }, (_, i) => event(`more${i}`, 30 + i, 10)), event("late", 600, 30, { summary: "Поздняя", location: "https://zoom.us/j/81234567099" })]);
    loaded.advance(60_000);
    const after = await sync();
    expect(after.lastError).toContain("неполный список событий");
    expect((await meetings()).filter((m) => m.status === "scheduled").map((m) => m.title).sort()).toEqual(["Из скрытого", "Поздняя"]);

    // Not watched any more, the hidden calendar leaves the picker.
    await loaded.harness.behavior.callRpc("google.setCalendars", { calendarIds: [PRIMARY] });
    expect((await status()).calendars.map((c) => c.id)).toEqual([PRIMARY, TEAM]);
  });

  it("asks Google's token endpoint once per sync when it fails, keeping the known bots", async () => {
    const loaded = await connected();
    const { google: fake, meetings, sync, harness, advance, service } = loaded;
    fake.events.set(PRIMARY, primaryEvents());
    fake.events.set(TEAM, [event("retro", 90, 60, { summary: "Ретро", location: "https://zoom.us/j/81234567010" })]);
    await harness.behavior.callRpc("google.setCalendars", { calendarIds: [PRIMARY, TEAM] });
    await service.calendar.idle();
    await sync();
    expect((await meetings()).filter((m) => m.status === "scheduled")).toHaveLength(3);
    const refreshes = () => fake.calls("/token").filter((call) => call.form.grant_type === "refresh_token").length;
    const before = refreshes();
    const secret = fake.clientSecret;
    fake.clientSecret = "GOCSPX-rotated-on-google";
    advance(2 * 3600_000);
    const failed = await sync();
    expect(refreshes() - before).toBe(1);
    expect(failed.lastError).toContain("Google не принял Client ID или Client Secret");
    expect((await meetings()).filter((m) => m.status === "scheduled")).toHaveLength(3);

    // The token is fine up front but Google rejects it mid-sync and the refresh fails: one refresh, not one per calendar.
    fake.clientSecret = secret;
    advance(60_000);
    expect((await sync()).lastError).toBeNull();
    const bots = (await meetings()).filter((m) => m.status === "scheduled").map((m) => m.id);
    fake.rejectAccessTokens = true;
    fake.clientSecret = "GOCSPX-rotated-again";
    const midway = refreshes();
    advance(60_000);
    expect((await sync()).lastError).toContain("Google не принял Client ID или Client Secret");
    expect(refreshes() - midway).toBe(1);
    expect((await meetings()).filter((m) => m.status === "scheduled").map((m) => m.id)).toEqual(bots);
  });

  it("caps a calendar bot's max duration at the event length + calendarOvertimeMinutes", async () => {
    const loaded = await connected({ maxDurationMinutes: 240 });
    const { google: fake, meetings, sync, detail, service, harness, advance } = loaded;
    fake.events.set(PRIMARY, [
      event("short", 10, 30, { summary: "Короткая", location: "https://zoom.us/j/81234567030" }),
      event("long", 60, 300, { summary: "Длинная", location: "https://zoom.us/j/81234567031" }),
    ]);
    await sync();
    const byTitle = async (title: string) => (await meetings()).find((m) => m.title === title)!;
    expect((await detail((await byTitle("Короткая")).id)).maxDurationMinutes).toBe(90);
    expect((await detail((await byTitle("Длинная")).id)).maxDurationMinutes).toBe(240);
    await harness.behavior.setSettings({ calendarOvertimeMinutes: 15 });
    expect((await detail((await byTitle("Короткая")).id)).maxDurationMinutes).toBe(45);
    await harness.behavior.setSettings({ calendarOvertimeMinutes: 0 });
    expect((await detail((await byTitle("Короткая")).id)).maxDurationMinutes).toBe(240);
    await harness.behavior.setSettings({ calendarOvertimeMinutes: 60 });

    advance(10 * 60_000);
    await service.tick();
    const [start] = hostCalls(harness, "meeting.start");
    const config = botConfigSchema.parse((start?.input as { config: unknown }).config);
    expect(config).toMatchObject({ botName: "Notetaker", maxDurationSec: 90 * 60, avatar: true, avatarVideo: null });
    const started = await byTitle("Короткая");
    expect(started.status).toBe("starting");
    // The cap the bot runs with stays on the meeting.
    await harness.behavior.setSettings({ calendarOvertimeMinutes: 0 });
    expect((await detail(started.id)).maxDurationMinutes).toBe(90);
  });
});
