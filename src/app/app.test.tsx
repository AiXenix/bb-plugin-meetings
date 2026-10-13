// @vitest-environment jsdom
// The Meetings page against mocked RPC handlers (the SDK's app test harness):
// list sections, join form, search, environment banner, Zoom card, detail
// page with transcript/speakers/summary, live view remote control, live
// transcript updates and the Zoom sign-in page.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { EnvReport } from "../shared/contract";
import type {
  CalendarStatus,
  LiveView,
  MeetingDetail,
  MeetingSummary,
  SegmentView,
  ZoomStatus,
} from "../shared/rpc-contract";

afterEach(cleanup);

const NOW = Date.now();
type Handlers = Record<string, (input: never) => unknown>;

function summary(id: string, overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id,
    title: "Планёрка",
    url: "https://zoom.us/j/81234567890?pwd=secret123",
    platform: "zoom",
    meetingNumber: "81234567890",
    botName: "Notetaker",
    source: "ui",
    status: "done",
    statusDetail: null,
    errorCode: null,
    errorMessage: null,
    endReason: "meeting_ended",
    scheduledAt: null,
    createdAt: NOW - 3_600_000,
    startedAt: NOW - 3_600_000,
    joinedAt: NOW - 3_590_000,
    recordingStartedAt: NOW - 3_590_000,
    endedAt: NOW - 1_800_000,
    durationSec: 1790,
    transcriptStatus: "done",
    transcriptProgress: null,
    transcriptError: null,
    participantsCount: null,
    activeSpeakers: [],
    speakers: [],
    segmentsCount: 0,
    hasAudio: true,
    screenshotVersion: null,
    hasSummary: false,
    requestedByThreadId: null,
    ...overrides,
  };
}

function detail(id: string, overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    ...summary(id),
    participants: [],
    summaryMd: null,
    speakerNames: {},
    maxDurationMinutes: 240,
    calendarEventKey: null,
    ...overrides,
  };
}

function seg(id: number, start: number, speaker: string, text: string): SegmentView {
  return { id, start, end: start + 1.5, speakerKey: `ui:${speaker}`, speaker, source: "ui", text };
}

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

const NO_ZOOM: ZoomStatus = {
  useZoomAccount: false,
  profile: { exists: false, signedIn: false, updatedAt: null },
  session: null,
};

const NO_CALENDAR: CalendarStatus = {
  configured: false,
  autoJoin: false,
  feeds: 0,
  lastSyncAt: null,
  lastError: null,
  upcoming: [],
};

function baseHandlers(overrides: Handlers = {}): Handlers {
  return {
    "meetings.list": () => ({ meetings: [], nextBefore: null }),
    "env.status": () => ({ env: READY_ENV, error: null }),
    "zoom.status": () => NO_ZOOM,
    "calendar.status": () => NO_CALENDAR,
    ...overrides,
  };
}

async function renderPage(subPath: string, rpc: Handlers): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("../../app"));
  const panel = app.navPanels[0]!;
  expect(panel).toMatchObject({ id: "meetings", title: "Встречи", path: "meetings", icon: "Mic" });
  return renderSlot(panel, { subPath }, { rpc: rpc as never, pluginId: "meetings" });
}

const callsTo = (slot: RenderedSlot, method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

describe("list page", () => {
  it("shows live, scheduled and past meetings, the environment banner and the Zoom card", async () => {
    const live = summary("mtg_live01", {
      title: "Ежедневный созвон",
      status: "recording",
      endReason: null,
      endedAt: null,
      participantsCount: 4,
      activeSpeakers: ["Анна"],
      screenshotVersion: 7,
      transcriptStatus: "live",
    });
    const processing = summary("mtg_proc01", {
      title: "Ретро спринта",
      status: "processing",
      transcriptStatus: "finalizing",
      transcriptProgress: 0.45,
    });
    const blocked = summary("mtg_fail01", {
      title: "Встреча с клиентом",
      status: "failed",
      errorCode: "bot_blocked",
      errorMessage: "We detected you may be a bot",
      hasAudio: false,
      durationSec: 0,
    });
    const done = summary("mtg_done01", {
      title: "Обзор квартала",
      speakers: [
        { key: "ui:Анна", label: "Анна", originalLabel: "Анна", source: "ui", talkSec: 600, segments: 40 },
        { key: "ui:Борис", label: "Борис", originalLabel: "Борис", source: "ui", talkSec: 300, segments: 20 },
      ],
    });
    const older = summary("mtg_old001", { title: "Старая встреча", createdAt: NOW - 90 * 86_400_000 });
    const scheduled = summary("mtg_sched1", {
      title: "Демо",
      status: "scheduled",
      scheduledAt: NOW + 3_600_000,
      startedAt: null,
      transcriptStatus: "none",
    });
    const env: EnvReport = {
      ...READY_ENV,
      ready: false,
      items: [
        {
          id: "xvfb",
          label: "Xvfb",
          ok: false,
          required: true,
          version: null,
          detail: "Виртуальный дисплей не найден",
          fix: "sudo apt-get install -y xvfb",
        },
      ],
      gigaam: { url: null, ready: false, detail: "Сервер не отвечает" },
    };
    const calendar: CalendarStatus = {
      configured: true,
      autoJoin: true,
      feeds: 1,
      lastSyncAt: NOW - 60_000,
      lastError: null,
      upcoming: [
        {
          key: "uid1@1",
          title: "Синк с партнёрами",
          startsAt: NOW + 7_200_000,
          endsAt: null,
          url: "https://zoom.us/j/1",
          skipped: false,
          meetingId: null,
        },
      ],
    };
    const rpc = baseHandlers({
      "meetings.list": (input: { filter: string; before: number | null }) => {
        if (input.filter === "active") return { meetings: [live, processing], nextBefore: null };
        if (input.filter === "upcoming") return { meetings: [scheduled], nextBefore: null };
        if (input.before === null) return { meetings: [blocked, done], nextBefore: done.createdAt };
        return { meetings: [older], nextBefore: null };
      },
      "env.status": () => ({ env, error: null }),
      "env.setup": () => ({
        env: { ...env, setup: { ...env.setup, phase: "running", message: "Installing Xvfb", startedAt: NOW } },
      }),
      "calendar.status": () => calendar,
      "calendar.setSkip": (input: { key: string; skip: boolean }) => ({
        ...calendar,
        upcoming: calendar.upcoming.map((event) =>
          event.key === input.key ? { ...event, skipped: input.skip } : event,
        ),
      }),
      "zoom.loginStart": () => ({
        ...NO_ZOOM,
        session: { id: "mtg_login01", phase: "starting", detail: "", error: null },
      }),
      "meetings.stop": () => ({ meeting: { ...live, status: "processing" } }),
    });
    const slot = await renderPage("", rpc);

    // Сейчас
    const card = await screen.findByRole("article", { name: "Ежедневный созвон" });
    expect(within(card).getByText("Идёт запись")).toBeTruthy();
    expect(within(card).getByText(/4\s+участника/)).toBeTruthy();
    expect(within(card).getByText("Анна")).toBeTruthy();
    expect(card.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/plugins/meetings/http/screenshot?id=mtg_live01&v=7",
    );
    fireEvent.click(within(card).getByRole("button", { name: "Остановить" }));
    await waitFor(() => expect(callsTo(slot, "meetings.stop")).toEqual([{ id: "mtg_live01" }]));

    // Запланированные: a scheduled meeting and a calendar event with a skip toggle
    expect(screen.getByRole("button", { name: "Отменить «Демо»" })).toBeTruthy();
    const skip = screen.getByRole("checkbox", { name: "Пропустить «Синк с партнёрами»" });
    fireEvent.click(skip);
    await waitFor(() => expect(callsTo(slot, "calendar.setSkip")).toEqual([{ key: "uid1@1", skip: true }]));
    await waitFor(() => expect(skip.getAttribute("aria-checked")).toBe("true"));

    // Прошедшие: processing progress, Russian error explanation, speakers
    expect(screen.getByText(/Расшифровка 45\s%/)).toBeTruthy();
    expect(screen.getByText(/Zoom не пустил бота как автоматического участника/)).toBeTruthy();
    expect(screen.getByText("Анна, Борис")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё" }));
    await screen.findByText("Старая встреча");
    expect(callsTo(slot, "meetings.list")).toContainEqual({ filter: "past", limit: 30, before: done.createdAt });
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
    fireEvent.click(screen.getByText("Обзор квартала"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "meetings",
      options: { subPath: "mtg_done01" },
    });

    // Environment banner and GigaAM warning
    expect(screen.getByText("Не хватает компонентов для записи встреч")).toBeTruthy();
    expect(screen.getByText("sudo apt-get install -y xvfb")).toBeTruthy();
    expect(screen.getByText("bb gigaam status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Установить компоненты" }));
    await screen.findByText(/Installing Xvfb/);
    expect(callsTo(slot, "env.setup")).toEqual([{ force: false }]);

    // Zoom account card
    expect(screen.getByText("Вход в Zoom не выполнен")).toBeTruthy();
    expect(screen.getByText("bb plugin config meetings set useZoomAccount true")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Войти в Zoom" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "meetings",
        options: { subPath: "zoom-login" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("validates the link locally, joins, and shows server errors inline", async () => {
    let fail = false;
    const rpc = baseHandlers({
      "meetings.join": (input: { url: string }) => {
        if (fail) throw new Error("Достигнут лимит одновременных записей");
        return { meeting: summary("mtg_new001", { url: input.url, status: "joining" }) };
      },
    });
    const slot = await renderPage("", rpc);
    const link = await screen.findByRole("textbox", { name: "Ссылка на Zoom-встречу" });
    const submit = screen.getByRole("button", { name: "Подключить бота" });

    fireEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toBe("Вставьте ссылку на Zoom-встречу");
    fireEvent.change(link, { target: { value: "https://meet.google.com/abc-defg-hij" } });
    fireEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Поддерживаются только ссылки Zoom/);
    expect(callsTo(slot, "meetings.join")).toEqual([]);

    fireEvent.change(link, { target: { value: "https://us02web.zoom.us/j/81234567890?pwd=abc" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Название (необязательно)" }), {
      target: { value: " Планёрка " },
    });
    fireEvent.click(submit);
    await screen.findByText("Открыть встречу");
    expect(callsTo(slot, "meetings.join")).toEqual([
      { url: "https://us02web.zoom.us/j/81234567890?pwd=abc", title: "Планёрка", scheduledAt: null },
    ]);
    expect((link as HTMLInputElement).value).toBe("");

    fail = true;
    fireEvent.change(link, { target: { value: "81234567890" } });
    fireEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toBe("Достигнут лимит одновременных записей");
    slot.lifecycle.unmount();
  });

  it("searches transcripts, highlights matches safely and opens the hit", async () => {
    const rpc = baseHandlers({
      "meetings.search": () => ({
        hits: [
          {
            meetingId: "mtg_done01",
            meetingTitle: "Обзор квартала",
            meetingDate: NOW - 86_400_000,
            segmentId: 12,
            start: 125,
            speaker: "Анна",
            snippet: "обсудили \u0002бюджет\u0003 <script>x</script>",
          },
        ],
      }),
    });
    const slot = await renderPage("", rpc);
    const input = await screen.findByRole("searchbox", { name: "Поиск по расшифровкам" });
    fireEvent.change(input, { target: { value: "бюджет" } });
    const mark = await screen.findByText("бюджет", { selector: "mark" });
    expect(callsTo(slot, "meetings.search")).toEqual([{ query: "бюджет", limit: 30 }]);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("[00:02:05]")).toBeTruthy();
    fireEvent.click(mark.closest("button")!);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "meetings",
      options: { subPath: "mtg_done01/t/12" },
    });
    slot.lifecycle.unmount();
  });

  it("refetches the list on realtime signals", async () => {
    let meetings: MeetingSummary[] = [];
    const rpc = baseHandlers({
      "meetings.list": (input: { filter: string }) => ({
        meetings: input.filter === "past" ? meetings : [],
        nextBefore: null,
      }),
    });
    const slot = await renderPage("", rpc);
    await screen.findByText(/Записей пока нет/);
    meetings = [summary("mtg_done02", { title: "Новая запись" })];
    await slot.behavior.emitRealtime("meetings.changed", { id: "mtg_done02" });
    await screen.findByText("Новая запись");
    slot.lifecycle.unmount();
  });
});

describe("detail page", () => {
  const speakers = [
    { key: "ui:Анна", label: "Анна", originalLabel: "Анна", source: "ui" as const, talkSec: 4.5, segments: 3 },
    { key: "ui:Борис", label: "Борис", originalLabel: "Борис", source: "ui" as const, talkSec: 1.5, segments: 1 },
  ];
  const segments = [
    seg(0, 0, "Анна", "Добрый день, начинаем."),
    seg(1, 1.6, "Анна", "Сначала бюджет."),
    seg(2, 4, "Борис", "Бюджет утверждён."),
    seg(3, 10, "Анна", "Отлично, спасибо."),
  ];

  it("renders header, summary, speakers and the transcript, focuses a deep-linked segment", async () => {
    const meeting = detail("mtg_done01", {
      title: "Обзор квартала",
      speakers,
      segmentsCount: 4,
      summaryMd: "## Итоги\n- **Решение**: запуск в ноябре\n- [ ] Анна: отчёт",
      errorCode: "browser_crashed",
      errorMessage: "Target closed",
    });
    const rpc = baseHandlers({
      "meetings.get": () => ({ meeting }),
      "meetings.segments": () => ({ segments, final: true, lastId: 3, total: 4 }),
      "meetings.renameSpeaker": () => ({ meeting }),
      "meetings.delete": () => ({ deleted: true }),
      "meetings.update": () => ({ meeting }),
    });
    const slot = await renderPage("mtg_done01/t/2", rpc);

    expect(await screen.findByRole("heading", { level: 1, name: "Обзор квартала" })).toBeTruthy();
    expect(screen.getByText("Готово")).toBeTruthy();
    expect(screen.getByText("https://zoom.us/j/81234567890?pwd=***")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret123");
    expect(screen.getByText("Браузер бота аварийно завершился")).toBeTruthy();
    expect(screen.getByText("Завершение: Встреча завершилась")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Повторить расшифровку/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Скачать/ })).toBeTruthy();
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(
      "/api/v1/plugins/meetings/http/audio?id=mtg_done01",
    );

    // Summary (safe markdown)
    expect(screen.getByText("Решение", { selector: "strong" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Не выполнено" })).toBeTruthy();

    // Transcript: turns (Анна 0–1, Борис 2, Анна 3 after a pause), deep link focus, final (no provisional banner)
    const region = await screen.findByRole("region", { name: "Текст расшифровки" });
    await within(region).findByText("Бюджет утверждён.");
    expect(region.querySelectorAll("[data-turn]").length).toBe(3);
    expect(region.querySelector('[data-seg="2"]')?.className).toContain("bg-surface-attention");
    expect(screen.queryByText(/Предварительная расшифровка/)).toBeNull();
    expect(within(region).getByRole("button", { name: "Воспроизвести с 00:00:10" })).toBeTruthy();

    // In-transcript search
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск в расшифровке" }), { target: { value: "бюджет" } });
    await screen.findByText("1 из 2");
    expect(within(region).getAllByText(/^Бюджет$/i, { selector: "mark" }).length).toBe(2);

    // Rename a speaker inline
    fireEvent.click(screen.getByRole("button", { name: "Переименовать «Анна»" }));
    const nameInput = screen.getByRole("textbox", { name: "Новое имя для «Анна»" });
    fireEvent.change(nameInput, { target: { value: "Анна Каренина" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() =>
      expect(callsTo(slot, "meetings.renameSpeaker")).toEqual([
        { id: "mtg_done01", speakerKey: "ui:Анна", name: "Анна Каренина" },
      ]),
    );

    // Edit the title inline
    fireEvent.click(screen.getByRole("button", { name: "Переименовать встречу" }));
    const titleInput = screen.getByRole("textbox", { name: "Название встречи" });
    fireEvent.change(titleInput, { target: { value: "Q3 обзор" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    await waitFor(() => expect(callsTo(slot, "meetings.update")).toEqual([{ id: "mtg_done01", title: "Q3 обзор" }]));

    // Delete through the confirmation dialog
    fireEvent.click(screen.getByRole("button", { name: /Удалить/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Удалить встречу?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(callsTo(slot, "meetings.delete")).toEqual([{ id: "mtg_done01" }]));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "meetings",
        options: { subPath: "", replace: true },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("drives the live view: polls, scales clicks to screenshot pixels, sends text, keys and scrolls", async () => {
    let meeting = detail("mtg_live01", {
      title: "Созвон",
      status: "waiting_room",
      endReason: null,
      endedAt: null,
      hasAudio: false,
      transcriptStatus: "none",
    });
    const view: LiveView = {
      screenshotVersion: 3,
      phase: "waiting_room",
      detail: 'In the waiting room: ask the host to admit "Notetaker"',
      controllable: true,
    };
    let queued = true;
    const rpc = baseHandlers({
      "meetings.get": () => ({ meeting }),
      "meetings.segments": () => ({ segments: [], final: false, lastId: -1, total: 0 }),
      "meetings.liveView": () => view,
      "meetings.control": () => ({ queued, seq: 1 }),
      "meetings.stop": () => ({ meeting }),
    });
    const slot = await renderPage("mtg_live01", rpc);
    expect(await screen.findByText("Бот в зале ожидания — впустите «Notetaker» во встречу")).toBeTruthy();
    const image = (await screen.findByRole("img", { name: "Экран бота" })) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/v1/plugins/meetings/http/screenshot?id=mtg_live01&v=3");
    // The bot's English detail is shown in Russian.
    expect(screen.getByText("В зале ожидания — Попросите организатора впустить «Notetaker»")).toBeTruthy();

    // Without "Управление" clicks are ignored.
    fireEvent.click(image);
    fireEvent.click(screen.getByRole("button", { name: "Управление" }));
    const controlled = screen.getByRole("img", { name: /клик по изображению повторится/ });
    controlled.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 640,
        height: 360,
        right: 650,
        bottom: 380,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.click(controlled, { clientX: 10 + 320, clientY: 20 + 90 });
    await waitFor(() =>
      expect(callsTo(slot, "meetings.control")).toEqual([{ id: "mtg_live01", action: "click", x: 640, y: 180 }]),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Текст для ввода в браузере бота" }), {
      target: { value: "ABCD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ввести" }));
    fireEvent.click(screen.getByRole("button", { name: "Нажать Escape" }));
    fireEvent.click(screen.getByRole("button", { name: "Прокрутить вниз" }));
    await waitFor(() =>
      expect(callsTo(slot, "meetings.control").slice(1)).toEqual([
        { id: "mtg_live01", action: "type", text: "ABCD" },
        { id: "mtg_live01", action: "key", key: "Escape" },
        { id: "mtg_live01", action: "scroll", dy: 400 },
      ]),
    );
    expect(callsTo(slot, "meetings.liveView").length).toBeGreaterThan(0);

    // The bot exited since the last poll: the command is not queued, so the text stays and an error shows.
    queued = false;
    const textbox = screen.getByRole("textbox", { name: "Текст для ввода в браузере бота" }) as HTMLInputElement;
    fireEvent.change(textbox, { target: { value: "пароль" } });
    fireEvent.click(screen.getByRole("button", { name: "Ввести" }));
    expect(await screen.findByText("Команда не отправлена: бот не запущен")).toBeTruthy();
    expect(textbox.value).toBe("пароль");

    fireEvent.click(screen.getByRole("button", { name: "Отключить бота" }));
    await waitFor(() => expect(callsTo(slot, "meetings.stop")).toEqual([{ id: "mtg_live01" }]));

    // Once the bot records, the open live view collapses (no screenshots every second for the whole meeting).
    meeting = { ...meeting, status: "recording", transcriptStatus: "live" };
    await slot.behavior.emitRealtime("meetings.changed", { id: "mtg_live01" });
    expect(await screen.findByText("Скрыт — снимки экрана не запрашиваются")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Экран бота/ })).toBeNull();
    // It stays open when the user opens it again.
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(await screen.findByRole("img", { name: /Экран бота/ })).toBeTruthy();
    await slot.behavior.emitRealtime("meetings.changed", { id: "mtg_live01" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("img", { name: /Экран бота/ })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reloads a growing recording to play a moment recorded after the page opened", async () => {
    const meeting = detail("mtg_live03", {
      title: "Длинный созвон",
      status: "recording",
      endReason: null,
      endedAt: null,
      durationSec: 20,
      transcriptStatus: "live",
      transcriptError: "GigaAM unavailable: connection refused",
      activeSpeakers: ["Анна", "Олег"],
      segmentsCount: 5,
    });
    const all = [...segments, seg(4, 15, "Олег", "Позже.")];
    const rpc = baseHandlers({
      "meetings.get": () => ({ meeting }),
      "meetings.segments": () => ({ segments: all, final: false, lastId: 4, total: 5 }),
    });
    const slot = await renderPage("mtg_live03", rpc);
    await screen.findByText("Позже.");
    // Several people speak at once; the transcriber waits for GigaAM and says so.
    expect(screen.getByText("Говорят:")).toBeTruthy();
    expect(screen.getByText("Расшифровка ждёт")).toBeTruthy();
    expect(screen.getByText("GigaAM unavailable: connection refused")).toBeTruthy();

    // The browser loaded the file 5.6 s into the recording and keeps that length.
    const audio = document.querySelector("audio")!;
    let loaded = 5.6;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => loaded });
    let plays = 0;
    audio.play = () => {
      plays += 1;
      return Promise.resolve();
    };
    fireEvent.loadedMetadata(audio);
    expect((screen.getByRole("slider", { name: "Позиция воспроизведения" }) as HTMLInputElement).max).toBe("20");

    // A moment within the loaded part plays right away.
    fireEvent.click(screen.getByRole("button", { name: "Воспроизвести с 00:00:04" }));
    expect(audio.currentTime).toBe(4);
    expect(audio.getAttribute("src")).toBe("/api/v1/plugins/meetings/http/audio?id=mtg_live03");
    expect(plays).toBe(1);

    // A later moment reloads the file under a new URL and resumes there once it has loaded.
    fireEvent.click(screen.getByRole("button", { name: "Воспроизвести с 00:00:15" }));
    await waitFor(() =>
      expect(audio.getAttribute("src")).toBe("/api/v1/plugins/meetings/http/audio?id=mtg_live03&v=1"),
    );
    expect(plays).toBe(1);
    loaded = 21;
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(15);
    expect(plays).toBe(2);
    slot.lifecycle.unmount();
  });

  it("appends live segments on meetings.segments signals and reloads when the transcript becomes final", async () => {
    let meeting = detail("mtg_live02", {
      title: "Живой созвон",
      status: "recording",
      endReason: null,
      endedAt: null,
      transcriptStatus: "live",
      segmentsCount: 2,
    });
    let final = false;
    let live = segments.slice(0, 2);
    const rpc = baseHandlers({
      "meetings.get": () => ({ meeting }),
      "meetings.segments": (input: { afterId: number }) => {
        const page = (final ? segments : live).filter((segment) => segment.id > input.afterId);
        return { segments: page, final, lastId: page.at(-1)?.id ?? input.afterId, total: live.length };
      },
      "meetings.liveView": () => ({ screenshotVersion: null, phase: "in_meeting", detail: "", controllable: true }),
    });
    const slot = await renderPage("mtg_live02", rpc);
    await screen.findByText("Сначала бюджет.");
    expect(screen.getByText(/Предварительная расшифровка/)).toBeTruthy();

    live = segments.slice(0, 3);
    await slot.behavior.emitRealtime("meetings.segments", { id: "mtg_live02", lastId: 2 });
    await screen.findByText("Бюджет утверждён.");
    expect(callsTo(slot, "meetings.segments")).toContainEqual({ id: "mtg_live02", afterId: 1, limit: 2000 });

    // Signals for other meetings are ignored.
    const before = callsTo(slot, "meetings.segments").length;
    await slot.behavior.emitRealtime("meetings.segments", { id: "mtg_other1", lastId: 9 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(callsTo(slot, "meetings.segments").length).toBe(before);

    // The meeting ends and the final transcript replaces the provisional one.
    final = true;
    meeting = { ...meeting, status: "done", transcriptStatus: "done", endReason: "meeting_ended", endedAt: NOW };
    await slot.behavior.emitRealtime("meetings.changed", { id: "mtg_live02" });
    await screen.findByText("Отлично, спасибо.");
    await waitFor(() => expect(screen.queryByText(/Предварительная расшифровка/)).toBeNull());
    slot.lifecycle.unmount();
  });
});

describe("failed meeting", () => {
  it("explains the error, offers Zoom sign-in and a retry, and hides empty panels", async () => {
    const meeting = detail("mtg_fail01", {
      title: "Звонок с клиентом",
      status: "failed",
      errorCode: "auth_required",
      errorMessage: "This meeting is for authorized attendees only",
      hasAudio: false,
      durationSec: 0,
      transcriptStatus: "none",
      endReason: "error",
    });
    const rpc = baseHandlers({
      "meetings.get": () => ({ meeting }),
      "meetings.segments": () => ({ segments: [], final: false, lastId: -1, total: 0 }),
      "meetings.join": () => ({ meeting: summary("mtg_retry1", { status: "joining" }) }),
      "zoom.loginStart": () => ({
        ...NO_ZOOM,
        session: { id: "mtg_login01", phase: "starting", detail: "", error: null },
      }),
    });
    const slot = await renderPage("mtg_fail01", rpc);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Встреча только для авторизованных пользователей Zoom")).toBeTruthy();
    expect(within(alert).getByText("This meeting is for authorized attendees only")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Саммари" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Спикеры/ })).toBeNull();
    expect(await screen.findByText("Записи нет — бот не попал во встречу.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Повторить расшифровку/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Подключить снова" }));
    await waitFor(() =>
      expect(callsTo(slot, "meetings.join")).toEqual([
        {
          url: meeting.url,
          title: "Звонок с клиентом",
          botName: "Notetaker",
          scheduledAt: null,
          maxDurationMinutes: 240,
        },
      ]),
    );
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "meetings",
        options: { subPath: "mtg_retry1" },
      }),
    );
    fireEvent.click(within(alert).getByRole("button", { name: "Войти в Zoom" }));
    await waitFor(() => expect(callsTo(slot, "zoom.loginStart")).toEqual([null]));
    slot.lifecycle.unmount();
  });
});

describe("retrying a meeting", () => {
  it("offers no rejoin for a failed import and schedules a cancelled future meeting again", async () => {
    const failedImport = detail("mtg_imp001", {
      title: "rec",
      source: "import",
      url: "file:///home/user/rec.mp4",
      status: "failed",
      errorCode: "unknown",
      errorMessage: "ffmpeg could not read the file",
      hasAudio: false,
      durationSec: 0,
      transcriptStatus: "none",
    });
    const startsAt = NOW + 86_400_000;
    const cancelled = detail("mtg_canc01", {
      title: "Завтрашний синк",
      status: "cancelled",
      scheduledAt: startsAt,
      startedAt: null,
      hasAudio: false,
      durationSec: 0,
      transcriptStatus: "none",
      maxDurationMinutes: 90,
    });
    const rpc = baseHandlers({
      "meetings.get": (input: { id: string }) => ({ meeting: input.id === failedImport.id ? failedImport : cancelled }),
      "meetings.segments": () => ({ segments: [], final: false, lastId: -1, total: 0 }),
      "meetings.join": () => ({ meeting: summary("mtg_again1", { status: "scheduled", scheduledAt: startsAt }) }),
    });
    const slot = await renderPage("mtg_imp001", rpc);
    expect(await screen.findByText("Не удалось прочитать звук из файла.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Скопировать путь к файлу записи" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Подключить снова|Запланировать снова/ })).toBeNull();
    slot.lifecycle.unmount();

    const again = await renderPage("mtg_canc01", rpc);
    fireEvent.click(await screen.findByRole("button", { name: "Запланировать снова" }));
    await waitFor(() =>
      expect(callsTo(again, "meetings.join")).toEqual([
        {
          url: cancelled.url,
          title: "Завтрашний синк",
          botName: "Notetaker",
          scheduledAt: startsAt,
          maxDurationMinutes: 90,
        },
      ]),
    );
    again.lifecycle.unmount();
  });
});

describe("zoom sign-in page", () => {
  it("shows the session's live view and finishes it", async () => {
    let status: ZoomStatus = {
      useZoomAccount: true,
      profile: { exists: true, signedIn: false, updatedAt: null },
      session: {
        id: "mtg_login01",
        phase: "joining",
        detail: 'Sign in to Zoom in the live view, then press "Done"',
        error: null,
      },
    };
    const rpc = baseHandlers({
      "zoom.status": () => status,
      // The server keeps the finished session (phase "ended") in the status for a while.
      "zoom.loginFinish": () => {
        status = {
          ...status,
          profile: { exists: true, signedIn: true, updatedAt: NOW },
          session: {
            id: "mtg_login01",
            phase: "ended",
            detail: "Signed in to Zoom; session closed by the user",
            error: null,
          },
        };
        return status;
      },
      "meetings.liveView": () => ({ screenshotVersion: 1, phase: "joining", detail: "", controllable: true }),
    });
    const slot = await renderPage("zoom-login", rpc);
    // Sign-in phases and the bot's details in Russian (not "Подключение к встрече").
    expect(
      await screen.findByText("Ждём входа в Zoom — Войдите в Zoom через снимок экрана ниже и нажмите «Готово»"),
    ).toBeTruthy();
    const image = await screen.findByRole("img", { name: /Экран бота/ });
    expect(image.getAttribute("src")).toBe("/api/v1/plugins/meetings/http/screenshot?id=mtg_login01&v=1");
    // Control mode is on by default here.
    expect(screen.getByRole("button", { name: "Управление" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    await screen.findByText("Вход в Zoom выполнен");
    expect(callsTo(slot, "zoom.loginFinish")).toEqual([null]);
    // The finished session's live view is gone, so its dead bot is no longer polled.
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();
    expect(screen.queryByRole("img", { name: /Экран бота/ })).toBeNull();
    const polls = callsTo(slot, "meetings.liveView").length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(callsTo(slot, "meetings.liveView").length).toBe(polls);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "К встречам" }));
    });
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "meetings",
      options: { subPath: "", replace: false },
    });
    slot.lifecycle.unmount();
  });

  it("shows a failed session's outcome and starts a new one, on the page and on the list card", async () => {
    const failed: ZoomStatus = {
      useZoomAccount: true,
      profile: { exists: true, signedIn: false, updatedAt: null },
      session: {
        id: "mtg_login01",
        phase: "failed",
        detail: "Sign-in session timed out",
        error: "Nobody signed in to Zoom within 15 minutes",
      },
    };
    const rpc = baseHandlers({
      "zoom.status": () => failed,
      "zoom.loginStart": () => ({
        ...failed,
        session: { id: "mtg_login02", phase: "starting", detail: "Запуск браузера", error: null },
      }),
      "meetings.liveView": () => ({ screenshotVersion: null, phase: "starting", detail: "", controllable: false }),
    });
    const slot = await renderPage("zoom-login", rpc);
    expect(await screen.findByText("Вход в Zoom не выполнен")).toBeTruthy();
    expect(screen.getByText("Время сеанса входа истекло")).toBeTruthy();
    expect(screen.getByText("Nobody signed in to Zoom within 15 minutes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();
    expect(callsTo(slot, "meetings.liveView")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Начать вход заново" }));
    await waitFor(() => expect(callsTo(slot, "zoom.loginStart")).toEqual([null]));
    expect(await screen.findByRole("button", { name: "Готово" })).toBeTruthy();
    slot.lifecycle.unmount();

    const list = await renderPage("", rpc);
    expect(await screen.findByText("Вход не выполнен: Время сеанса входа истекло")).toBeTruthy();
    expect(screen.queryByText(/Идёт сеанс входа/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Открыть сеанс входа" })).toBeNull();
    expect(screen.getByRole("button", { name: "Войти в Zoom" })).toBeTruthy();
    list.lifecycle.unmount();
  });
});
