// @vitest-environment jsdom
// The "Google Календарь" card against mocked RPC handlers: setup steps and the
// OAuth client form, the consent in a new tab and waiting for it, calendars,
// sync and disconnect; Google events in "Запланированные".
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { EnvReport } from "../shared/contract";
import type { CalendarStatus, GoogleStatus } from "../shared/rpc-contract";
import { formatDateTime } from "./format";
import { googleRedirectUri, hasGoogleConnection, redirectOriginAllowed } from "./google-card";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A promise settled from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handlers = Record<string, (input: never) => unknown>;

const NOW = Date.now();
const CALLBACK_PATH = "/api/v1/plugins/meetings/http/google/callback";
const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234567890-abcdef&state=s1";

const READY_ENV: EnvReport = {
  ready: true,
  items: [],
  setup: { phase: "idle", message: "", startedAt: null, finishedAt: null, logTail: "" },
  runtimeHash: "abc",
  hostDataDir: "/tmp/meetings",
  sudo: true,
  gigaam: { url: "http://127.0.0.1:38271", ready: true, detail: "" },
  chromePath: "/usr/bin/google-chrome-stable",
};

const NOT_CONFIGURED: GoogleStatus = {
  configured: false,
  clientId: "",
  callbackPath: CALLBACK_PATH,
  connected: false,
  email: null,
  calendars: [],
  lastSyncAt: null,
  lastError: null,
  upcomingCount: 0,
  connectedAt: null,
  lastConsent: null,
};

const CONNECTED: GoogleStatus = {
  configured: true,
  clientId: CLIENT_ID,
  callbackPath: CALLBACK_PATH,
  connected: true,
  email: "anna@example.com",
  calendars: [
    { id: "anna@example.com", summary: "Анна", primary: true, selected: true, color: "#9fe1e7" },
    { id: "work@group.calendar.google.com", summary: "Работа", primary: false, selected: false, color: null },
  ],
  lastSyncAt: NOW - 60_000,
  lastError: null,
  upcomingCount: 2,
  connectedAt: NOW - 3_600_000,
  lastConsent: null,
};

/** What google.status says once the token is revoked or expired: the row and its events are kept. */
const BROKEN: GoogleStatus = {
  ...CONNECTED,
  connected: false,
  calendars: [],
  lastError: "Доступ к Google отозван или истёк — подключите заново",
};

/** Client keys saved, no connection stored. */
const KEYS_ONLY: GoogleStatus = { ...NOT_CONFIGURED, configured: true, clientId: CLIENT_ID };

const SYNC_ERROR = "Google: Google Calendar API не включён в проекте Google Cloud";

const CALENDAR: CalendarStatus = {
  configured: true,
  autoJoin: false,
  feeds: 0,
  lastSyncAt: NOW - 60_000,
  lastError: null,
  upcoming: [
    {
      key: "gcal:anna@example.com:evt1",
      title: "Синк с Google",
      startsAt: NOW + 3_600_000,
      endsAt: NOW + 5_400_000,
      url: "https://zoom.us/j/81234567890",
      skipped: false,
      meetingId: null,
    },
    {
      key: "uid-ics@1",
      title: "Встреча из ICS",
      startsAt: NOW + 7_200_000,
      endsAt: null,
      url: "https://zoom.us/j/81234567891",
      skipped: false,
      meetingId: null,
    },
  ],
};

function handlers(overrides: Handlers): Handlers {
  return {
    "meetings.list": () => ({ meetings: [], nextBefore: null }),
    "env.status": () => ({ env: READY_ENV, error: null }),
    "zoom.status": () => ({
      useZoomAccount: false,
      profile: { exists: false, signedIn: false, updatedAt: null },
      session: null,
    }),
    "calendar.status": () => ({ ...CALENDAR, configured: false, upcoming: [] }),
    "bot.profile": () => ({ botName: "Notetaker", avatar: { hasAvatar: false, enabled: true, version: null } }),
    ...overrides,
  };
}

async function renderList(rpc: Handlers, settings?: Record<string, string | number | boolean>): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("../../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc as never, pluginId: "meetings", settings });
}

const callsTo = (slot: RenderedSlot, method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

async function googleSection(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Google Календарь" });
}

describe("google calendar card", () => {
  it("walks from setup through the consent to a connected account, calendars, sync and disconnect", async () => {
    let status: GoogleStatus = NOT_CONFIGURED;
    let calendar: CalendarStatus = { ...CALENDAR, configured: false, upcoming: [] };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = await renderList(
      handlers({
        "google.status": () => status,
        "calendar.status": () => calendar,
        "google.saveClient": (input: { clientId: string; clientSecret?: string }) => {
          status = { ...status, configured: true, clientId: input.clientId };
          return status;
        },
        "google.authStart": () => ({ authUrl: AUTH_URL, redirectUri: `http://localhost:3000${CALLBACK_PATH}` }),
        "calendar.setAutoJoin": (input: { autoJoin: boolean }) => {
          calendar = { ...calendar, autoJoin: input.autoJoin };
          return calendar;
        },
        "google.setCalendars": (input: { calendarIds: string[] }) => {
          status = {
            ...status,
            calendars: status.calendars.map((item) => ({ ...item, selected: input.calendarIds.includes(item.id) })),
          };
          return status;
        },
        "google.sync": () => {
          status = { ...status, lastSyncAt: NOW, upcomingCount: 3 };
          return status;
        },
        "google.disconnect": () => {
          status = { ...status, connected: false, email: null, calendars: [], upcomingCount: 0 };
          calendar = { ...calendar, upcoming: [] };
          return status;
        },
      }),
      { calendarLeadMinutes: 2 },
    );
    let section = await googleSection();

    // Not configured: a short pitch; the steps and the form open on demand.
    await within(section).findByText("Google Календарь не подключён");
    expect(within(section).queryByLabelText("Client ID")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Настроить подключение" }));
    const redirectUri = `http://localhost:3000${CALLBACK_PATH}`;
    expect(within(section).getByText(redirectUri)).toBeTruthy();
    expect(within(section).getByText(/Web application/)).toBeTruthy();
    expect(within(section).getByText(/Google отзывает доступ через 7 дней/)).toBeTruthy();
    expect(within(section).getByRole("link", { name: "Google Calendar API" }).getAttribute("href")).toBe(
      "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    );
    fireEvent.click(within(section).getByRole("button", { name: "Скопировать адрес перенаправления" }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: redirectUri }]));

    // The form checks the values before saving.
    const save = within(section).getByRole("button", { name: "Сохранить" });
    fireEvent.click(save);
    expect((await within(section).findByRole("alert")).textContent).toMatch(/^Вставьте Client ID/);
    fireEvent.change(within(section).getByLabelText("Client ID"), { target: { value: "GOCSPX-abcdefghijkl" } });
    fireEvent.click(save);
    expect((await within(section).findByRole("alert")).textContent).toMatch(/похоже на Client Secret/);
    fireEvent.change(within(section).getByLabelText("Client ID"), { target: { value: ` ${CLIENT_ID} ` } });
    fireEvent.click(save);
    expect((await within(section).findByRole("alert")).textContent).toBe("Вставьте Client Secret");
    expect(callsTo(slot, "google.saveClient")).toEqual([]);
    fireEvent.change(within(section).getByLabelText("Client Secret"), { target: { value: "GOCSPX-secret" } });
    fireEvent.click(save);

    // Configured, not connected: connect opens Google's page in a new tab and waits.
    const connect = await within(section).findByRole("button", { name: "Подключить Google Календарь" });
    expect(callsTo(slot, "google.saveClient")).toEqual([{ clientId: CLIENT_ID, clientSecret: "GOCSPX-secret" }]);
    expect(within(section).getByText(CLIENT_ID)).toBeTruthy();
    expect(within(section).getByText(redirectUri)).toBeTruthy();
    fireEvent.click(connect);
    await within(section).findByText("Ждём подтверждения в Google…");
    expect(callsTo(slot, "google.authStart")).toEqual([{ origin: "http://localhost:3000" }]);
    expect(open).toHaveBeenCalledWith(AUTH_URL, "_blank", "noopener,noreferrer");
    expect(within(section).getByRole("link", { name: "Открыть страницу Google" }).getAttribute("href")).toBe(AUTH_URL);
    expect(within(section).getByRole("button", { name: "Открыть вход заново" })).toBeTruthy();

    // The user allows access in that tab; the page notices through its google.status poll.
    const pollsBefore = callsTo(slot, "google.status").length;
    status = CONNECTED;
    calendar = CALENDAR;
    section = await googleSection();
    await within(section).findByText(/anna@example\.com/, {}, { timeout: 4000 });
    expect(callsTo(slot, "google.status").length).toBeGreaterThan(pollsBefore);
    expect(within(section).queryByText("Ждём подтверждения в Google…")).toBeNull();
    expect(within(section).getByText(/2\s+Zoom-встречи в ближайшие сутки/)).toBeTruthy();
    expect(within(section).getByText("основной")).toBeTruthy();

    // Auto-join (shared with ICS) is a toggle on the card.
    const autoJoin = within(section).getByRole("checkbox", { name: "Автоматически подключать бота к встречам из календаря" });
    expect(autoJoin.getAttribute("aria-checked")).toBe("false");
    expect(within(section).getByText(/бот к ним сам не подключается/)).toBeTruthy();
    fireEvent.click(autoJoin);
    await waitFor(() => expect(callsTo(slot, "calendar.setAutoJoin")).toEqual([{ autoJoin: true }]));
    await waitFor(() => expect(autoJoin.getAttribute("aria-checked")).toBe("true"));

    // Pick calendars.
    const work = within(section).getByRole("checkbox", { name: "Работа" });
    expect(within(section).getByRole("checkbox", { name: "Анна" }).getAttribute("aria-checked")).toBe("true");
    expect(work.getAttribute("aria-checked")).toBe("false");
    const calendarFetches = callsTo(slot, "calendar.status").length;
    fireEvent.click(work);
    await waitFor(() => expect(work.getAttribute("aria-checked")).toBe("true"));
    expect(callsTo(slot, "google.setCalendars")).toEqual([
      { calendarIds: ["anna@example.com", "work@group.calendar.google.com"] },
    ]);
    await waitFor(() => expect(callsTo(slot, "calendar.status").length).toBeGreaterThan(calendarFetches));
    fireEvent.click(within(section).getByRole("checkbox", { name: "Анна" }));
    await waitFor(() =>
      expect(callsTo(slot, "google.setCalendars").at(-1)).toEqual({ calendarIds: ["work@group.calendar.google.com"] }),
    );

    // Google events show up in "Запланированные", marked by their source.
    const scheduled = await screen.findByRole("region", { name: /Запланированные/ });
    const googleRow = (await within(scheduled).findByText("Синк с Google")).closest("li")!;
    expect(within(googleRow).getByText("Google")).toBeTruthy();
    const icsRow = within(scheduled).getByText("Встреча из ICS").closest("li")!;
    expect(within(icsRow).getByText("календарь")).toBeTruthy();

    // Sync.
    fireEvent.click(within(section).getByRole("button", { name: "Синхронизировать" }));
    await within(section).findByText(/3\s+Zoom-встречи в ближайшие сутки/);
    expect(callsTo(slot, "google.sync")).toEqual([null]);

    // Disconnect through the confirmation.
    fireEvent.click(within(section).getByRole("button", { name: "Отключить" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Отключить Google Календарь?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(callsTo(slot, "google.disconnect")).toEqual([null]));
    await within(section).findByRole("button", { name: "Подключить Google Календарь" });
    await waitFor(() => expect(screen.queryByText("Синк с Google")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("shows auto-join with the lead time, a failing sync with reconnect, and consent errors", async () => {
    let status: GoogleStatus = { ...CONNECTED, lastError: SYNC_ERROR };
    let failStart = true;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = await renderList(
      handlers({
        "google.status": () => status,
        "calendar.status": () => ({ ...CALENDAR, autoJoin: true }),
        "google.authStart": () => {
          if (failStart) throw new Error("Адрес http://example.com не подходит для OAuth");
          return { authUrl: AUTH_URL, redirectUri: `http://localhost:3000${CALLBACK_PATH}` };
        },
      }),
      { calendarLeadMinutes: 2 },
    );
    const section = await googleSection();
    await within(section).findByText(SYNC_ERROR);
    expect(
      within(section)
        .getByRole("checkbox", { name: "Автоматически подключать бота к встречам из календаря" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(section).getByText(/бот заходит за 2 мин до начала/)).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Подключить заново" }));
    expect((await within(section).findByRole("alert")).textContent).toBe(
      "Адрес http://example.com не подходит для OAuth",
    );
    expect(open).not.toHaveBeenCalled();

    failStart = false;
    fireEvent.click(within(section).getByRole("button", { name: "Подключить заново" }));
    await within(section).findByText("Ждём подтверждения в Google…");
    expect(open).toHaveBeenCalledTimes(1);
    // The callback publishes meetings.google: the fixed connection ends the wait.
    status = { ...CONNECTED, lastSyncAt: NOW, connectedAt: NOW, lastConsent: { at: NOW, ok: true, message: "ok" } };
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(within(section).queryByText("Ждём подтверждения в Google…")).toBeNull());
    expect(within(section).queryByText(SYNC_ERROR)).toBeNull();
    expect(within(section).queryByRole("button", { name: "Подключить заново" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers to disconnect a broken connection whose events are still scheduled; the dialog waits for the answer", async () => {
    let status: GoogleStatus = BROKEN;
    let calendar: CalendarStatus = CALENDAR;
    let disconnecting = deferred<GoogleStatus>();
    const slot = await renderList(
      handlers({
        "google.status": () => status,
        "calendar.status": () => calendar,
        "google.disconnect": () => disconnecting.promise,
      }),
    );
    const section = await googleSection();
    await within(section).findByText(BROKEN.lastError!);
    expect(within(section).getByRole("button", { name: "Подключить Google Календарь" })).toBeTruthy();
    expect(within(section).getByText(/2 встречи из Google в ближайшие сутки остаются в «Запланированных»/)).toBeTruthy();
    expect(await screen.findByText("Синк с Google")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Отключить" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Сохранённое подключение будет удалено/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(callsTo(slot, "google.disconnect")).toEqual([null]));

    // Escape while the request runs does not hide its outcome.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => {
      disconnecting.reject(new Error("Сеть недоступна"));
      await disconnecting.promise.catch(() => undefined);
    });
    dialog = screen.getByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Сеть недоступна");

    // Second try succeeds: the stored connection and its events are gone.
    disconnecting = deferred<GoogleStatus>();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(callsTo(slot, "google.disconnect")).toHaveLength(2));
    status = KEYS_ONLY;
    calendar = { ...CALENDAR, configured: false, upcoming: [] };
    await act(async () => {
      disconnecting.resolve(KEYS_ONLY);
      await disconnecting.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Синк с Google")).toBeNull());
    expect(within(section).queryByRole("button", { name: "Отключить" })).toBeNull();
    expect(within(section).queryByText(/остаются в «Запланированных»/)).toBeNull();
    expect(within(section).getByRole("button", { name: "Подключить Google Календарь" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("tells a stored connection from none by what google.status reports", () => {
    expect(hasGoogleConnection(NOT_CONFIGURED)).toBe(false);
    expect(hasGoogleConnection(KEYS_ONLY)).toBe(false);
    expect(hasGoogleConnection(CONNECTED)).toBe(true);
    expect(hasGoogleConnection(BROKEN)).toBe(true);
    expect(hasGoogleConnection({ ...KEYS_ONLY, lastError: "Client ID изменён — подключите Google Календарь заново" })).toBe(
      true,
    );
    expect(hasGoogleConnection({ ...NOT_CONFIGURED, lastError: BROKEN.lastError })).toBe(true);
  });

  it("applies a google.status answer that is newer than the shown one, even while a later call is in flight", async () => {
    const calls: Array<(status: GoogleStatus) => void> = [];
    const slot = await renderList(
      handlers({ "google.status": () => new Promise<GoogleStatus>((resolve) => calls.push(resolve)) }),
    );
    const section = await googleSection();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const answer = async (index: number, status: GoogleStatus) => {
      await act(async () => calls[index]!(status));
    };
    for (let index = 0; index < calls.length; index += 1) await answer(index, KEYS_ONLY);
    await within(section).findByRole("button", { name: "Подключить Google Календарь" });

    // Two refetches in flight (as with polls slower than the poll interval): the first answer applies.
    const base = calls.length;
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(calls).toHaveLength(base + 1));
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(calls).toHaveLength(base + 2));
    await answer(base, CONNECTED);
    await within(section).findByText(/anna@example\.com/);
    await answer(base + 1, { ...CONNECTED, upcomingCount: 5 });
    await within(section).findByText(/5\s+Zoom-встреч в ближайшие сутки/);

    // An older answer arriving after a newer one is dropped.
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(calls).toHaveLength(base + 3));
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(calls).toHaveLength(base + 4));
    await answer(base + 3, { ...CONNECTED, upcomingCount: 7 });
    await within(section).findByText(/7\s+Zoom-встреч в ближайшие сутки/);
    await answer(base + 2, { ...CONNECTED, upcomingCount: 1 });
    expect(within(section).getByText(/7\s+Zoom-встреч в ближайшие сутки/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("polls for the consent every 2 s for a minute, then every 10 s, rechecks on focus and gives up after 15 minutes", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = await renderList(
      handlers({
        "google.status": () => KEYS_ONLY,
        "google.authStart": () => ({ authUrl: AUTH_URL, redirectUri: `http://localhost:3000${CALLBACK_PATH}` }),
      }),
    );
    const section = await googleSection();
    const connect = await within(section).findByRole("button", { name: "Подключить Google Календарь" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    const polls = () => callsTo(slot, "google.status").length;
    fireEvent.click(connect);
    await advance(0);
    expect(within(section).getByText("Ждём подтверждения в Google…")).toBeTruthy();
    expect(within(section).getByText(/нажмите «Не ждать»/)).toBeTruthy();

    let before = polls();
    await advance(60_000);
    expect(polls() - before).toBeGreaterThanOrEqual(28);
    before = polls();
    await advance(60_000);
    expect(polls() - before).toBeGreaterThanOrEqual(5);
    expect(polls() - before).toBeLessThanOrEqual(7);

    // Coming back from Google's tab checks at once.
    before = polls();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(polls()).toBe(before + 1);

    await advance(15 * 60_000);
    expect(within(section).getByText(/Подтверждение от Google не пришло/)).toBeTruthy();
    before = polls();
    await advance(60_000);
    expect(polls()).toBe(before);
    vi.useRealTimers();
    slot.lifecycle.unmount();
  });

  it("keeps waiting for the consent when a sync finishes while the consent is being started", async () => {
    const earlier = NOW - 3 * 3_600_000;
    let status: GoogleStatus = { ...CONNECTED, lastSyncAt: earlier, lastError: SYNC_ERROR };
    const starting = deferred<{ authUrl: string; redirectUri: string }>();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = await renderList(
      handlers({ "google.status": () => status, "google.authStart": () => starting.promise }),
    );
    const section = await googleSection();
    await within(section).findByText(new RegExp(`Синхронизирован ${formatDateTime(earlier)}`));
    fireEvent.click(within(section).getByRole("button", { name: "Подключить заново" }));
    await waitFor(() => expect(callsTo(slot, "google.authStart")).toHaveLength(1));

    // A periodic sync fails again meanwhile: only lastSyncAt moves.
    status = { ...status, lastSyncAt: NOW };
    await slot.behavior.emitRealtime("meetings.google", {});
    await within(section).findByText(new RegExp(`Синхронизирован ${formatDateTime(NOW)}`));
    await act(async () => {
      starting.resolve({ authUrl: AUTH_URL, redirectUri: `http://localhost:3000${CALLBACK_PATH}` });
      await starting.promise;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(within(section).getByText("Ждём подтверждения в Google…")).toBeTruthy();

    // The callback stores the new token (a new connectedAt): the wait ends.
    status = { ...status, lastError: null, connectedAt: NOW };
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(within(section).queryByText("Ждём подтверждения в Google…")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("stops waiting and shows Google's answer when the consent is refused", async () => {
    let status: GoogleStatus = { ...CONNECTED, connected: false, email: null, calendars: [], connectedAt: null };
    vi.spyOn(window, "open").mockImplementation(() => null);
    const slot = await renderList(
      handlers({
        "google.status": () => status,
        "google.authStart": () => ({ authUrl: AUTH_URL, redirectUri: `http://localhost:3000${CALLBACK_PATH}` }),
      }),
    );
    const section = await googleSection();
    fireEvent.click(await within(section).findByRole("button", { name: "Подключить Google Календарь" }));
    await within(section).findByText("Ждём подтверждения в Google…");
    status = {
      ...status,
      lastConsent: { at: NOW, ok: false, message: "Доступ не предоставлен: на экране Google нажали «Отмена» или не разрешили доступ." },
    };
    await slot.behavior.emitRealtime("meetings.google", {});
    await waitFor(() => expect(within(section).queryByText("Ждём подтверждения в Google…")).toBeNull());
    expect((await within(section).findByRole("alert")).textContent).toMatch(/Доступ не предоставлен/);
    slot.lifecycle.unmount();
  });

  it("asks for the secret again when the Client ID changes and keeps password managers off the keys", async () => {
    let status: GoogleStatus = KEYS_ONLY;
    const slot = await renderList(
      handlers({
        "google.status": () => status,
        "google.saveClient": (input: { clientId: string; clientSecret?: string }) => {
          status = { ...status, clientId: input.clientId };
          return status;
        },
      }),
    );
    const section = await googleSection();
    fireEvent.click(await within(section).findByRole("button", { name: "Изменить ключи" }));
    const idInput = within(section).getByLabelText("Client ID");
    const secretInput = within(section).getByLabelText("Client Secret");
    for (const input of [idInput, secretInput]) {
      expect(input.getAttribute("autocomplete")).toBe("off");
      expect(input.hasAttribute("data-1p-ignore")).toBe(true);
      expect(input.getAttribute("data-lpignore")).toBe("true");
    }
    expect(secretInput.getAttribute("type")).toBe("password");
    expect(secretInput.getAttribute("placeholder")).toBe("Оставьте пустым, чтобы не менять");

    // Another client with the old secret would only fail after the consent.
    const NEW_ID = "9876543210-zyx.apps.googleusercontent.com";
    fireEvent.change(idInput, { target: { value: NEW_ID } });
    expect(secretInput.getAttribute("placeholder")).toBe("GOCSPX-…");
    fireEvent.click(within(section).getByRole("button", { name: "Сохранить" }));
    expect((await within(section).findByRole("alert")).textContent).toMatch(
      /при смене Client ID вставьте и его Client Secret/,
    );
    expect(callsTo(slot, "google.saveClient")).toEqual([]);
    fireEvent.change(secretInput, { target: { value: "GOCSPX-new-secret" } });
    fireEvent.click(within(section).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(callsTo(slot, "google.saveClient")).toEqual([{ clientId: NEW_ID, clientSecret: "GOCSPX-new-secret" }]),
    );

    // The same Client ID keeps the saved secret.
    fireEvent.click(await within(section).findByRole("button", { name: "Изменить ключи" }));
    fireEvent.click(within(section).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(callsTo(slot, "google.saveClient").at(-1)).toEqual({ clientId: NEW_ID }));
    slot.lifecycle.unmount();
  });

  it("builds the redirect URI from the page origin and flags origins Google refuses", () => {
    expect(googleRedirectUri("https://bb.example.com", CALLBACK_PATH)).toBe(`https://bb.example.com${CALLBACK_PATH}`);
    expect(googleRedirectUri("http://localhost:8787", "")).toBe(`http://localhost:8787${CALLBACK_PATH}`);
    expect(redirectOriginAllowed("https://bb.example.com")).toBe(true);
    expect(redirectOriginAllowed("http://localhost:8787")).toBe(true);
    expect(redirectOriginAllowed("http://127.0.0.1")).toBe(true);
    expect(redirectOriginAllowed("http://192.168.1.5:8787")).toBe(false);
    expect(redirectOriginAllowed("http://bb.local")).toBe(false);
  });
});
