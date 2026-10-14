// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MeetingAnalysis, SummaryTemplate } from "../shared/analysis";

afterEach(cleanup);
type Handlers = Record<string, (input: never) => unknown>;
const SETTINGS = { autoTranscribe: true, liveTranscription: true, autoSummarize: true, summaryMode: "agent", summaryTemplateId: "executive", avatarStyle: "initials", avatarColor: "#0ea5e9", avatarText: "AI", maxDurationMinutes: 240, maxConcurrentBots: 2, waitingTimeoutMinutes: 20, aloneTimeoutMinutes: 2, silenceTimeoutMinutes: 30, screenshotIntervalSec: 10, diarization: "ui+acoustic", speakerLagMs: 700, notifyThread: true };
const templates: SummaryTemplate[] = ["executive", "sales", "interview", "technical", "weekly"].map((id, index) => ({ id, label: ["Итоги", "Продажи", "Интервью", "Технический разбор", "Планёрка"][index], description: "Проверенный шаблон", prompt: `Полные правила ${id}`, badge: "Готовый", builtIn: true, editable: false, updatedAt: null }));
const MEETING_ID = "mtg_feature01";
const meeting = { id: MEETING_ID, title: "Обсуждение сроков", url: "https://meet.google.com/abc-defg-hij", platform: "meet", meetingNumber: null, botName: "Notetaker", source: "ui", status: "done", statusDetail: null, errorCode: null, errorMessage: null, endReason: "meeting_ended", scheduledAt: null, createdAt: Date.now(), startedAt: Date.now(), joinedAt: Date.now(), recordingStartedAt: Date.now(), endedAt: Date.now(), durationSec: 60, transcriptStatus: "done", transcriptProgress: null, transcriptError: null, participantsCount: 2, activeSpeakers: [], speakers: [], segmentsCount: 1, hasAudio: false, screenshotVersion: null, hasSummary: false, requestedByThreadId: null, participants: [], summaryMd: null, speakerNames: {}, maxDurationMinutes: 240, calendarEventKey: null };
const ANALYSIS: MeetingAnalysis = { meetingId: MEETING_ID, summaryMd: "Срок согласован", insights: { template: "executive", templateApplied: true, templateSnapshot: { id: "executive", label: "Итоги", prompt: "Сохранённые правила", systemPrompt: "Только факты", updatedAt: null }, generatedAt: "2026-10-14T20:00:00.000Z", tldr: "Релиз согласован на пятницу", decisions: ["Выпустить релиз в пятницу"], risks: ["Нужна проверка доступа"], keyTopics: ["Сроки"], sentiment: { overall: "constructive", label: "Конструктивный", score: 70 }, chapters: [{ startSec: 0, endSec: 60, title: "План релиза", summary: "Обсудили срок и проверку" }], actionItems: [{ id: "task-1", task: "Проверить доступ", assignee: "Анна", due: "Четверг", timecodeSec: 12, done: false, priority: "high" }], followUpDraft: "Коллеги, релиз согласован на пятницу.", speakerMetrics: [{ speaker: "Анна", talkTimeSec: 30, sharePercent: 50, wordCount: 40, wordsPerMin: 80, segmentCount: 1, questionsAsked: 1 }], context: { totalSegments: 1, includedSegments: 1, truncated: false } } };

function handlers(overrides: Handlers = {}): Handlers {
  return {
    "meetings.list": () => ({ meetings: [], nextBefore: null }),
    "env.status": () => ({ env: null, error: null }),
    "calendar.status": () => ({ configured: false, autoJoin: false, feeds: 0, lastSyncAt: null, lastError: null, upcoming: [] }),
    "google.status": () => ({ configured: false, connected: false, calendars: [], clientId: "", lastError: null }),
    "notetaker.settings": () => ({ settings: SETTINGS }),
    "templates.list": () => ({ templates }),
    "meetings.get": () => ({ meeting }),
    "meetings.segments": () => ({ segments: [{ id: 0, start: 0, end: 60, speakerKey: "ui:Анна", speaker: "Анна", source: "ui", text: "Релиз в пятницу. Доступ проверю в четверг." }], final: true, lastId: 0, total: 1 }),
    "meetings.analysis": () => ({ analysis: ANALYSIS, mode: "agent", templateId: "executive", templates, prompt: null }),
    ...overrides,
  };
}
async function page(subPath: string, rpc: Handlers): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("../../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, { pluginId: "meetings", rpc: rpc as never });
}
const calls = (slot: RenderedSlot, method: string) => slot.inspection.rpcCalls.filter(call => call.method === method).map(call => call.input);
function expand(label: string) {
  const details = screen.getByText(label).closest("details")!;
  act(() => { details.open = true; fireEvent(details, new Event("toggle")); });
}
async function settingsTab(label: string) { expand("Настройки бота, разбора и интеграций"); fireEvent.click(await screen.findByRole("tab", { name: label })); }

describe("expanded meeting features", () => {
  it("keeps settings collapsed until requested and saves only the changed recording setting", async () => {
    const slot = await page("", handlers({ "notetaker.settings": (input: { patch?: Record<string, unknown> }) => ({ settings: { ...SETTINGS, ...input.patch } }) }));
    expect(calls(slot, "notetaker.settings")).toEqual([]);
    await settingsTab("Запись");
    const toggle = await screen.findByRole("checkbox", { name: "Расшифровывать автоматически" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки" }));
    await screen.findByText("Сохранено");
    expect(calls(slot, "notetaker.settings")).toEqual([{}, { patch: { autoTranscribe: false } }]);
    slot.lifecycle.unmount();
  });

  it("copies a built-in template into an editable custom template and sets it as default", async () => {
    let catalog = [...templates];
    const slot = await page("", handlers({
      "templates.list": () => ({ templates: catalog }),
      "templates.save": (input: { label: string; description: string; prompt: string }) => { const template = { ...input, id: "custom-1", badge: "Свой", builtIn: false, editable: true, updatedAt: Date.now() }; catalog = [...catalog, template]; return { template }; },
      "notetaker.settings": (input: { patch?: Record<string, unknown> }) => ({ settings: { ...SETTINGS, ...input.patch } }),
    }));
    await settingsTab("Шаблоны");
    await screen.findByRole("button", { name: "Создать копию" });
    fireEvent.click(screen.getByRole("button", { name: "Создать копию" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название шаблона" }), { target: { value: "Наш процесс" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Полный текст правил" }), { target: { value: "Укажи решения и владельцев задач" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }));
    await screen.findByRole("button", { name: "Изменить" });
    expect(calls(slot, "templates.save")).toEqual([{ label: "Наш процесс", description: "Проверенный шаблон", prompt: "Укажи решения и владельцев задач", copyFrom: "executive" }]);
    fireEvent.click(screen.getByRole("button", { name: "По умолчанию" }));
    await waitFor(() => expect(calls(slot, "notetaker.settings")).toContainEqual({ patch: { summaryTemplateId: "custom-1" } }));
    slot.lifecycle.unmount();
  });

  it("persists a completed action item and exposes saved chapters, speaker metrics and follow-up", async () => {
    const updated: MeetingAnalysis = { ...ANALYSIS, insights: { ...ANALYSIS.insights, actionItems: [{ ...ANALYSIS.insights.actionItems[0], done: true }] } };
    const slot = await page(MEETING_ID, handlers({ "meetings.actionItem": () => ({ analysis: updated }) }));
    await screen.findByText("Релиз согласован на пятницу");
    fireEvent.click(screen.getByRole("tab", { name: "Задачи 0/1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Выполнено: Проверить доступ" }));
    await screen.findByRole("tab", { name: "Задачи 1/1" });
    expect(calls(slot, "meetings.actionItem")).toEqual([{ id: MEETING_ID, itemId: "task-1", done: true }]);
    fireEvent.click(screen.getByRole("tab", { name: "Главы" })); await screen.findByText("План релиза");
    fireEvent.click(screen.getByRole("tab", { name: "Участники" })); await screen.findByText(/40 слов.*80 слов\/мин/);
    fireEvent.click(screen.getByRole("tab", { name: "Следующее письмо" })); await screen.findByText("Коллеги, релиз согласован на пятницу.");
    slot.lifecycle.unmount();
  });

  it("shows an agent request without presenting it as a generated analysis", async () => {
    let saved: MeetingAnalysis | null = null;
    const slot = await page(MEETING_ID, handlers({ "meetings.analysis": () => ({ analysis: saved, mode: "agent", templateId: "executive", templates, prompt: null }), "meetings.analyze": () => ({ analysis: null, needsAgent: true, prompt: "Прочитай всю встречу и сохрани результат" }) }));
    const button = await screen.findByRole("button", { name: "Разобрать встречу" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Разбор выполняет агент BB/);
    expect(calls(slot, "meetings.analyze")).toEqual([{ id: MEETING_ID, templateId: "executive" }]);
    expect(screen.queryByRole("tab", { name: "Итоги" })).toBeNull();
    expect(calls(slot, "meetings.saveInsights")).toEqual([]);
    saved = ANALYSIS;
    await slot.behavior.emitRealtime("meetings.changed", { id: MEETING_ID });
    await screen.findByText("Релиз согласован на пятницу");
    expect(screen.queryByRole("button", { name: "Скопировать запрос агенту" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("answers across meetings and opens the exact cited transcript segment", async () => {
    const slot = await page("", handlers({ "meetings.ask": () => ({ answer: "Релиз запланирован на пятницу.", citations: [{ meetingId: MEETING_ID, meetingTitle: "План релиза", segmentId: 7, timecodeSec: 12, speaker: "Анна", quote: "Релиз в пятницу" }], needsAgent: false, prompt: null }) }));
    expand("Вопрос по всем встречам");
    fireEvent.change(screen.getByRole("textbox", { name: "Вопрос по всем встречам" }), { target: { value: "Когда релиз?" } });
    fireEvent.click(screen.getByRole("button", { name: "Задать вопрос" }));
    await screen.findByText("Релиз запланирован на пятницу.");
    fireEvent.click(screen.getByRole("button", { name: /План релиза.*Релиз в пятницу/ }));
    expect(calls(slot, "meetings.ask")).toEqual([{ question: "Когда релиз?" }]);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "meetings", options: { subPath: `${MEETING_ID}/t/7` } });
    slot.lifecycle.unmount();
  });

  it.each(["meet", "telemost"] as const)("opens and completes the generic %s login screen", async platform => {
    const account = { platform, enabled: false, profile: { exists: true, signedIn: false, updatedAt: null }, session: { id: "mtg_login01", phase: "joining", detail: "Войдите через браузер", error: null } };
    const slot = await page(`account-login/${platform}`, handlers({ "accounts.status": () => ({ accounts: [account] }), "accounts.loginFinish": () => ({ account: { ...account, profile: { ...account.profile, signedIn: true }, session: null } }), "meetings.liveView": () => ({ screenshotVersion: null, phase: "joining", detail: "", controllable: true }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Готово" }));
    await screen.findByText(platform === "meet" ? "Вход в Google Meet выполнен" : "Вход в Яндекс Телемост выполнен");
    expect(calls(slot, "accounts.loginFinish")).toEqual([{ platform }]);
    slot.lifecycle.unmount();
  });

  it("passes explicit Jitsi, template, audio-only and no-chat overrides to join", async () => {
    const slot = await page("", handlers({ "meetings.join": () => ({ meeting: { ...meeting, status: "joining" } }) }));
    expand("Параметры этой встречи");
    await screen.findByRole("option", { name: "Продажи" });
    fireEvent.change(screen.getByRole("textbox", { name: "Ссылка на встречу" }), { target: { value: "https://video.example.test/team" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Платформа" }), { target: { value: "jitsi" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Шаблон разбора" }), { target: { value: "sales" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Расшифровка" }), { target: { value: "false" } });
    fireEvent.change(screen.getByRole("combobox", { name: "ИИ-разбор" }), { target: { value: "false" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Сообщение в чат" }), { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключить бота" }));
    await screen.findByText("Открыть встречу");
    expect(calls(slot, "meetings.join")).toEqual([{ url: "https://video.example.test/team", title: null, scheduledAt: null, platform: "jitsi", templateId: "sales", autoTranscribe: false, autoSummarize: false, chatAnnouncement: "" }]);
    slot.lifecycle.unmount();
  });

  it("offers portable stdio and keeps HTTP token controls in the HTTP section", async () => {
    const slot = await page("", handlers({ "agent.tokenStatus": () => ({ configured: false, createdAt: null }), "agent.meta": () => ({ mcpPath: "/session/mcp", apiPath: "/session/api", personalMcpPath: "/personal/mcp", personalApiPath: "/personal/api", webhookHeader: "x-meetings-signature", webhookAlgorithm: "HMAC" }), "agent.tokenCreate": () => ({ token: "fixture-token-only", createdAt: Date.now() }) }));
    await settingsTab("Интеграции");
    await screen.findByText("MCP · stdio");
    fireEvent.click(screen.getByText("HTTP MCP и JSON API"));
    expect(screen.getByText(/Токен плагина сам по себе не открывает доступ/)).toBeTruthy();
    await screen.findByText(/\/personal\/mcp$/);
    fireEvent.click(screen.getByRole("button", { name: "Создать токен" }));
    const token = await screen.findByRole("textbox", { name: "Новый токен агента" });
    expect((token as HTMLInputElement).value).toBe("fixture-token-only");
    expect(calls(slot, "agent.tokenCreate")).toEqual([{}]);
    fireEvent.click(screen.getByRole("button", { name: "Скрыть токен" }));
    expect(screen.queryByRole("textbox", { name: "Новый токен агента" })).toBeNull();
    slot.lifecycle.unmount();
  });
});
