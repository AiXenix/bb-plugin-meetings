import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { askResultSchema, meetingAnalysisSchema, type AnalysisDocument } from "../src/shared/analysis.js";
import { AI_CONTEXT_MAX_BYTES, AI_RESPONSE_MAX_BYTES, ANALYSIS_STORAGE_MAX_BYTES, buildAnalysisPrompt, computeSpeakerMetrics, createAnalysisService, makeAnalysisDocument } from "../src/server/analysis.js";
import { createSummaryTemplateStore, SUMMARY_TEMPLATES, snapshotTemplate } from "../src/server/summary-templates.js";

function storage() {
  const rows = new Map<string, unknown>();
  const bb = {
    storage: { kv: {
      async get<T>(key: string): Promise<T | undefined> { const value = rows.get(key); return value === undefined ? undefined : structuredClone(value) as T; },
      async set(key: string, value: unknown) {
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(256 * 1024);
        rows.set(key, structuredClone(value));
      },
      async delete(key: string) { rows.delete(key); },
      async list(prefix = "") { return [...rows.keys()].filter((key) => key.startsWith(prefix)); },
    } },
  } as Pick<BbPluginApi, "storage">;
  return { bb, rows };
}

const document: AnalysisDocument = {
  meetingId: "mtg_analysis01", title: "План выпуска", segments: [
    { id: 0, startSec: 0, endSec: 10, speaker: "Анна", text: "Выпускаем новую версию завтра. Есть вопросы?" },
    { id: 1, startSec: 30, endSec: 40, speaker: "Олег", text: "Я проверю сборку завтра и отправлю отчёт." },
    { id: 2, startSec: 60, endSec: 70, speaker: "Анна", text: "Согласовали выпуск. Риск: задержка согласования." },
  ],
};
const insightInput = () => ({
  tldr: "Согласовали выпуск новой версии завтра.",
  decisions: ["[00:00] Выпустить новую версию завтра"],
  risks: ["[01:00] Задержка согласования"],
  keyTopics: ["Релиз"],
  sentiment: { overall: "constructive", label: "Рабочее обсуждение", score: 75 },
  chapters: [{ startSec: 0, endSec: 70, title: "Выпуск", summary: "Подготовка новой версии" }],
  actionItems: [{ task: "Проверить сборку и отправить отчёт", assignee: "Олег", due: "завтра", timecodeSec: 30, priority: "medium" }],
  followUpDraft: "Олег проверяет сборку завтра.",
});
const config = { baseUrl: "https://ai.example/v1", model: "model", apiKey: "private-test-key" };
function completion(result: unknown, extra: object = {}): Response {
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) }, ...extra }] });
}

describe("summary templates", () => {
  it("ships five readable immutable templates, with persistent editable copies and custom rules", async () => {
    const { bb } = storage();
    const templates = createSummaryTemplateStore(bb, { now: () => 1000 });
    expect((await templates.list()).map((t) => t.id)).toEqual(["executive", "sales", "hr", "tech", "custom"]);
    expect((await templates.get("sales")).prompt).toContain("BANT/MEDDIC");
    await expect(templates.update("executive", { label: "x", prompt: "y" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(templates.delete("custom")).rejects.toMatchObject({ code: "invalid_input" });
    const copy = await templates.copy("executive", "Мой разбор");
    expect(copy).toMatchObject({ label: "Мой разбор", builtIn: false, editable: true, updatedAt: 1000 });
    const edited = await templates.update(copy.id, { label: "Мои правила", prompt: "Укажи только риски", description: "Риски проекта" });
    expect((await createSummaryTemplateStore(bb).get(copy.id))).toEqual(edited);
    expect((await templates.get("executive")).prompt).toEqual(SUMMARY_TEMPLATES.executive.prompt);
    const custom = await templates.create({ label: "С нуля", prompt: "Разбери бюджет" });
    expect(custom.description).toBe("");
    await templates.delete(copy.id);
    await expect(templates.get(copy.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates empty and overlong rules and cannot fetch another BB namespace's templates", async () => {
    const first = createSummaryTemplateStore(storage().bb);
    const second = createSummaryTemplateStore(storage().bb);
    await expect(first.create({ label: " ", prompt: "x" })).rejects.toThrow();
    await expect(first.create({ label: "x", prompt: "p".repeat(12_001) })).rejects.toThrow();
    const custom = await first.create({ label: "Персональный", prompt: "Мои правила" });
    await expect(second.get(custom.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await second.list())).toHaveLength(5);
  });
});

describe("structured meeting analysis", () => {
  it("stores exact previously applied rules despite later template edits, with server-computed metrics", async () => {
    const { bb, rows } = storage();
    const service = createAnalysisService(bb, { now: () => 1000 });
    const template = await service.templates.create({ label: "Риски", prompt: "Укажи только риски" });
    const prompt = buildAnalysisPrompt(document, template);
    expect(prompt.systemPrompt).toContain("Укажи только риски");
    expect(prompt.userPrompt).toContain(document.segments[0].text);
    await service.templates.update(template.id, { label: "Риски", prompt: "Новые правила" });
    const analysis = await service.save(document, { ...insightInput(), templateSnapshot: prompt.templateSnapshot, speakerMetrics: [{ speaker: "поддельный" }] });
    expect(meetingAnalysisSchema.parse(analysis)).toEqual(analysis);
    expect(analysis.insights.templateSnapshot.prompt).toBe("Укажи только риски");
    expect(analysis.insights.templateSnapshot.systemPrompt).toBe(prompt.systemPrompt);
    expect(analysis.insights.template).toBe(template.id);
    expect(analysis.insights.speakerMetrics[0]).toMatchObject({ speaker: "Анна", talkTimeSec: 20, sharePercent: 66.67, questionsAsked: 1 });
    expect(analysis.summaryMd).toContain("[00:30]");
    expect((await createAnalysisService(bb).get(document.meetingId))).toEqual(analysis);
    expect([...rows.values()].map((v) => JSON.stringify(v)).join(" ")).not.toContain("private-test-key");
    await expect(service.save(document, insightInput(), { templateSnapshot: { ...prompt.templateSnapshot, systemPrompt: "другие правила" } })).rejects.toMatchObject({ code: "invalid_ai_response" });
    await service.delete(document.meetingId);
    expect(await service.get(document.meetingId)).toBeNull();
  });

  it("keeps stable task IDs and completion across reanalysis and ignores model-supplied IDs/done", async () => {
    const service = createAnalysisService(storage().bb);
    const first = await service.save(document, insightInput());
    const id = first.insights.actionItems[0].id;
    expect(id).toMatch(/^act_[a-f0-9]{24}$/);
    await service.setActionItemDone(document.meetingId, id, true);
    const supplied = insightInput();
    supplied.actionItems.push({ task: "Подтвердить дату", assignee: "Анна", due: "завтра", timecodeSec: 60, priority: "medium" });
    supplied.actionItems.reverse();
    const second = await service.save(document, { ...supplied, actionItems: supplied.actionItems.map((item) => ({ ...item, id: "model-id", done: false })) });
    expect(second.insights.actionItems.find((item) => item.id === id)?.done).toBe(true);
    expect(second.summaryMd).toContain("- [x] Проверить сборку");
    await expect(service.setActionItemDone(document.meetingId, "absent", true)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed JSON, timestamps outside the transcript and an empty transcript without saving a fallback", async () => {
    const { bb, rows } = storage();
    const service = createAnalysisService(bb);
    await expect(service.save(document, "bad json")).rejects.toMatchObject({ code: "invalid_ai_response" });
    await expect(service.save(document, { ...insightInput(), actionItems: [{ ...insightInput().actionItems[0], timecodeSec: 500 }] })).rejects.toMatchObject({ code: "invalid_ai_response" });
    await expect(service.save({ ...document, segments: [] }, insightInput())).rejects.toMatchObject({ code: "empty_transcript" });
    expect(rows.size).toBe(0);
    const noTasks = await service.save(document, { ...insightInput(), decisions: [], actionItems: [] });
    expect(noTasks.insights.decisions).toEqual([]);
    expect(noTasks.insights.actionItems).toEqual([]);
  });

  it("computes real intervals without inventing duration for short or zero-length speech", () => {
    const metrics = computeSpeakerMetrics([
      { id: 0, startSec: 0, endSec: 0.5, speaker: "Анна", text: "Да?" },
      { id: 1, startSec: 0.25, endSec: 1, speaker: "Анна", text: "Точно?" },
      { id: 2, startSec: 1, endSec: 1, speaker: "Олег", text: "Да." },
    ]);
    expect(metrics[0]).toMatchObject({ talkTimeSec: 1, wordCount: 2, questionsAsked: 2, sharePercent: 100, wordsPerMin: 120 });
    expect(metrics[1]).toMatchObject({ talkTimeSec: 0, sharePercent: 0, wordsPerMin: 0 });
  });

  it("maps runtime speaker aliases and preserves segment IDs and timecodes", () => {
    expect(makeAnalysisDocument({ id: "id", title: "title", speakerNames: { "ui:name": "Анна" } }, [
      { id: 10, start: 10, end: 20, speaker: "Имя", speakerKey: "ui:name", text: "Реплика", source: "ui" },
    ]).segments[0]).toEqual({ id: 10, startSec: 10, endSec: 20, speaker: "Анна", text: "Реплика" });
  });

  it("bounds context with visible truncation instead of silently claiming complete analysis", () => {
    const large: AnalysisDocument = { ...document, segments: Array.from({ length: 1000 }, (_, i) => ({ id: i, startSec: i, endSec: i + 1, speaker: "Анна", text: "речь ".repeat(100) })) };
    const prompt = buildAnalysisPrompt(large, SUMMARY_TEMPLATES.executive);
    expect(Buffer.byteLength(prompt.userPrompt)).toBeLessThanOrEqual(AI_CONTEXT_MAX_BYTES);
    expect(prompt.context).toMatchObject({ totalSegments: 1000, truncated: true });
    expect(prompt.context.includedSegments).toBeLessThan(1000);
    expect(prompt.systemPrompt).toContain("Если контекст усечён");
  });

  it("serializes task changes so simultaneous completions don't overwrite each other", async () => {
    const service = createAnalysisService(storage().bb);
    const secondAction = { task: "Подтвердить дату", assignee: "Анна", due: null, timecodeSec: 60, priority: "medium" };
    const saved = await service.save(document, { ...insightInput(), actionItems: [...insightInput().actionItems, secondAction] });
    await Promise.all(saved.insights.actionItems.map((item) => service.setActionItemDone(document.meetingId, item.id, true)));
    expect((await service.get(document.meetingId))?.insights.actionItems.every((item) => item.done)).toBe(true);
  });

  it("refuses results that exceed the per-value KV storage limit", async () => {
    const { bb, rows } = storage();
    const service = createAnalysisService(bb);
    const large = { ...insightInput(), decisions: Array.from({ length: 50 }, () => "решение ".repeat(240)) };
    await expect(service.save(document, large)).rejects.toMatchObject({ code: "invalid_ai_response" });
    expect(rows.size).toBe(0);
    expect(ANALYSIS_STORAGE_MAX_BYTES).toBeLessThan(256 * 1024);
  });
});

describe("OpenAI-compatible analysis API", () => {
  it("uses exact rules, configured model and server-side credentials; retries unsupported optional parameters only", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const rejected = ["response_format", "temperature", "max_tokens"];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
      if (rejected.length) return Response.json({ error: { message: `Unsupported parameter: ${rejected.shift()}` } }, { status: 400 });
      return completion(insightInput());
    });
    const service = createAnalysisService(storage().bb, { fetch: fetcher });
    const result = await service.analyze(document, config, { templateId: "tech" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(requests[0].url).toBe("https://ai.example/v1/chat/completions");
    expect(requests[0].init.redirect).toBe("error");
    expect(requests[0].init.headers).toMatchObject({ authorization: "Bearer private-test-key" });
    for (const request of requests) {
      expect(request.body.model).toBe("model");
      expect(request.body.messages).toEqual(requests[0].body.messages);
    }
    expect(requests.at(-1)!.body).not.toHaveProperty("response_format");
    expect(requests.at(-1)!.body).not.toHaveProperty("temperature");
    expect(requests.at(-1)!.body).not.toHaveProperty("max_tokens");
    expect(result.insights.templateSnapshot).toEqual(snapshotTemplate(SUMMARY_TEMPLATES.tech));
  });

  it("supports local API without a key and a base URL already ending in chat/completions", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).not.toHaveProperty("authorization");
      return completion(insightInput());
    });
    await createAnalysisService(storage().bb, { fetch: fetcher }).analyze(document, { baseUrl: "http://127.0.0.1:1234/v1/chat/completions", model: "local" });
    expect(String(fetcher.mock.calls[0][0])).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });

  it("reports missing API configuration before any network call and never stores a fake summary", async () => {
    const { bb, rows } = storage();
    const fetcher = vi.fn<typeof fetch>();
    await expect(createAnalysisService(bb, { fetch: fetcher }).analyze(document, { baseUrl: "", model: "" })).rejects.toMatchObject({ code: "ai_not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("redacts upstream error bodies and rejects oversized or truncated responses", async () => {
    const { bb, rows } = storage();
    const unauthorized = createAnalysisService(bb, { fetch: async () => Response.json({ error: { message: "private-test-key detail" } }, { status: 401 }) });
    await expect(unauthorized.analyze(document, config)).rejects.toMatchObject({ code: "ai_auth_failed" });
    try { await unauthorized.analyze(document, config); } catch (error) { expect(String(error)).not.toContain("private-test-key"); }
    const huge = createAnalysisService(bb, { fetch: async () => new Response("x".repeat(AI_RESPONSE_MAX_BYTES + 1)) });
    await expect(huge.analyze(document, config)).rejects.toMatchObject({ code: "invalid_ai_response" });
    const truncated = createAnalysisService(bb, { fetch: async () => completion(insightInput(), { finish_reason: "length" }) });
    await expect(truncated.analyze(document, config)).rejects.toMatchObject({ code: "invalid_ai_response" });
    expect(rows.size).toBe(0);
  });

  it("bounds requests with a timeout even if an injected fetch ignores AbortSignal", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const service = createAnalysisService(storage().bb, { fetch: fetcher, timeoutMs: 10 });
    await expect(service.analyze(document, config)).rejects.toMatchObject({ code: "ai_timeout" });
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("cancels outgoing API work on plugin disposal and prevents subsequent writes", async () => {
    const { bb, rows } = storage();
    const lifetime = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const service = createAnalysisService(bb, { fetch: fetcher, signal: lifetime.signal });
    const pending = service.analyze(document, config);
    while (!fetcher.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
    lifetime.abort();
    await expect(pending).rejects.toMatchObject({ code: "ai_cancelled" });
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    await expect(service.save(document, insightInput())).rejects.toMatchObject({ code: "ai_cancelled" });
    expect(rows.size).toBe(0);
  });
});

describe("grounded transcript questions", () => {
  it("answers across supplied documents, validates exact quotes and derives trusted timestamps", async () => {
    const second: AnalysisDocument = { meetingId: "mtg_analysis02", title: "Согласование", segments: [{ id: 12, startSec: 122, endSec: 130, speaker: "Ирина", text: "Проверка согласована сегодня." }] };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("Согласование");
      return completion({ answer: "Проверка согласована [mtg_analysis02/12 99:99].", citations: [{ meetingId: second.meetingId, segmentId: 12, quote: "согласована сегодня" }] });
    });
    const result = await createAnalysisService(storage().bb, { fetch: fetcher }).ask("Когда согласовали?", [document, second], config);
    expect(askResultSchema.parse(result)).toEqual(result);
    expect(result.citations[0]).toMatchObject({ timecodeSec: 122, speaker: "Ирина", meetingTitle: "Согласование" });
    expect(result.answer).toContain("[mtg_analysis02/12 02:02]");
    expect(result.answer).not.toContain("99:99");
  });

  it("rejects fabricated quotes, foreign meeting IDs and missing sources", async () => {
    for (const raw of [
      { answer: "Вывод", citations: [{ meetingId: document.meetingId, segmentId: 1, quote: "Я решил уволиться" }] },
      { answer: "Вывод", citations: [{ meetingId: "foreign", segmentId: 1, quote: document.segments[1].text }] },
      { answer: "Срок — завтра", citations: [] },
      { answer: "[foreign/1 00:30]", citations: [{ meetingId: document.meetingId, segmentId: 1, quote: "проверю сборку" }] },
    ]) {
      const service = createAnalysisService(storage().bb, { fetch: async () => completion(raw) });
      await expect(service.ask("Что решили?", [document], config)).rejects.toMatchObject({ code: "invalid_ai_response" });
    }
  });

  it("allows an explicit lack-of-evidence answer without generating tasks or citations", async () => {
    const service = createAnalysisService(storage().bb, { fetch: async () => completion({ answer: "Недостаточно данных в переданных расшифровках", citations: [] }) });
    const result = await service.ask("Сколько стоит выпуск?", [document], config);
    expect(result.citations).toEqual([]);
    expect(result.answer).toContain("Недостаточно данных");
  });
});
