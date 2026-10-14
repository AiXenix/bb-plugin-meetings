import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingAnalysis } from "../src/shared/analysis.js";
import { botConfigSchema } from "../src/shared/runtime-files.js";
import { startMeeting } from "../src/host/meetings.js";
import { botConfig, cleanupTempDirs, fakeHostData, newMeetingId } from "./host-helpers.js";
import { hostCalls, load, segment, transcriberState, uniqueZoomUrl, until } from "./server-fixtures.js";

type Loaded = Awaited<ReturnType<typeof load>>;
const loaded: Loaded[] = [];
afterEach(async () => {
  for (const fixture of loaded.splice(0)) await fixture.harness.lifecycle.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

async function fixture(options: Parameters<typeof load>[0] = {}) {
  const result = await load(options);
  loaded.push(result);
  // The original fixture simulates only Zoom; new platform profiles remain
  // separate, just as the real recording host does.
  const original = result.fake.handle.bind(result.fake);
  result.fake.handle = (method, input) => {
    if (method === "browser.profile") {
      const { platform, action } = input as { platform: string; action: string };
      return { exists: action !== "delete", signedIn: action !== "delete", path: `/host/profiles/${platform}`, updatedAt: action === "delete" ? null : 1 };
    }
    return original(method, input);
  };
  return result;
}

async function join(f: Loaded, fields: Record<string, unknown> = {}, threadId?: string) {
  if (threadId) {
    const result = await f.harness.behavior.runCli(["join", uniqueZoomUrl(), "--json"], { threadId });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout).meeting.id as string;
  }
  const result = await f.harness.behavior.callRpc("meetings.join", { url: uniqueZoomUrl(), ...fields }) as { meeting: { id: string } };
  return result.meeting.id;
}

async function finish(f: Loaded, id: string) {
  const runtime = f.fake.get(id);
  runtime.audio = Buffer.alloc(1000, 3);
  runtime.final = true;
  runtime.segments = [segment(0, 0, "Анна", "Решили проверить выпуск завтра."), segment(1, 10, "Олег", "Я проверю сборку и отправлю отчёт завтра.")];
  f.fake.setBot(id, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 15, bytes: 1000 } }, false);
  await f.service.tick();
  return f.service.requireMeeting(id);
}

function insights() {
  return { tldr: "Согласовали проверку выпуска завтра.", decisions: ["[00:00] Проверить выпуск завтра"], risks: [], keyTopics: ["Выпуск"],
    sentiment: { overall: "constructive", label: "Рабочее обсуждение", score: 75 },
    chapters: [{ startSec: 0, endSec: 13, title: "Проверка", summary: "Проверка сборки" }],
    actionItems: [{ task: "Проверить сборку и отправить отчёт", assignee: "Олег", due: "завтра", timecodeSec: 10, priority: "medium" }],
    followUpDraft: "Олег проверит сборку завтра." };
}

function apiCompletion() { return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(insights()) } }] }); }

describe("Notetaker integrated settings and agent mode", () => {
  it("keeps API/signing/calendar secrets out of RPC and authenticated REST settings responses", async () => {
    const f = await fixture();
    const secrets = ["private-ai-key", "private-signing-key", "private-calendar-feed"];
    const settings = await f.harness.behavior.callRpc("notetaker.settings", { patch: {
      aiApiKey: secrets[0], webhookSecret: secrets[1], calendarIcsUrls: `https://calendar.example/${secrets[2]}.ics`,
    } });
    expect(settings).toMatchObject({ settings: { aiApiKeyConfigured: true, webhookSecretConfigured: true, calendarFeedCount: 1 } });
    const created = await f.harness.behavior.callRpc("agent.tokenCreate", {}) as { token: string };
    const response = await f.harness.behavior.fetchHttp("POST", "/api-token", { headers: { "content-type": "application/json", authorization: `Bearer ${created.token}` }, body: JSON.stringify({ action: "settings" }) });
    expect(response.status).toBe(200);
    const text = JSON.stringify(settings) + await response.text() + JSON.stringify(f.harness.inspection.logEntries);
    for (const secret of [...secrets, created.token]) expect(text).not.toContain(secret);
  });

  it("defaults to agent mode, prepares the selected template and saves its exact rules after later editing", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("No network expected"); });
    vi.stubGlobal("fetch", fetcher);
    const f = await fixture();
    const settings = await f.harness.behavior.callRpc("notetaker.settings", {}) as { settings: { summaryMode: string } };
    expect(settings.settings.summaryMode).toBe("agent");
    const saved = await f.harness.behavior.callRpc("templates.save", { label: "Мои правила", prompt: "Укажи только подтверждённые решения" }) as { template: { id: string } };
    const id = await join(f);
    await finish(f, id);
    const result = await f.harness.behavior.callRpc("meetings.analyze", { id, templateId: saved.template.id }) as { needsAgent: boolean; prompt: string };
    expect(result.needsAgent).toBe(true);
    expect(result.prompt).toContain("Укажи только подтверждённые решения");
    expect(result.prompt).toContain("meetings_save_insights");
    await f.harness.behavior.callRpc("templates.save", { id: saved.template.id, label: "Мои правила", prompt: "Теперь укажи риски" });
    // The agent follows the returned prompt: id + structured JSON. The selected
    // snapshot must take precedence over the meeting's original default.
    const analysis = await f.harness.behavior.callRpc("meetings.saveInsights", { id, insights: insights() }) as { analysis: MeetingAnalysis };
    expect(analysis.analysis.insights.template).toBe(saved.template.id);
    expect(analysis.analysis.insights.templateSnapshot.prompt).toBe("Укажи только подтверждённые решения");
    expect(f.service.requireMeeting(id).summaryMd).toBe(analysis.analysis.summaryMd);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects both analysis and structured insight saving while the transcript is still live", async () => {
    const f = await fixture();
    const id = await join(f);
    const runtime = f.fake.get(id);
    runtime.audio = Buffer.alloc(1000, 1);
    runtime.segments = [segment(0, 0, "Анна", "Решили проверить выпуск завтра.")];
    f.fake.setBot(id, { phase: "in_meeting", audio: { seconds: 15, bytes: 1000 } }, true);
    await f.service.tick();
    await expect(f.harness.behavior.callRpc("meetings.analyze", { id })).rejects.toThrow("окончательного");
    await expect(f.harness.behavior.callRpc("meetings.saveInsights", { id, insights: { ...insights(), chapters: [], actionItems: [] } })).rejects.toThrow("окончательного");
    expect(await f.service.notetaker.analysis.get(id)).toBeNull();
    expect(f.service.requireMeeting(id).summaryMd).toBeNull();
  });

  it("keeps default agent Q&A in the existing transcript/provider flow without requesting the optional API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const f = await fixture();
    const id = await join(f);
    await finish(f, id);
    const answer = await f.harness.behavior.callRpc("meetings.ask", { id, question: "Что Олег должен проверить?" }) as { needsAgent: boolean; prompt: string };
    expect(answer.needsAgent).toBe(true);
    expect(answer.prompt).toContain(id);
    expect(answer.prompt).toContain("meetings_transcript");
    expect(answer.prompt).toContain("таймкод");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("finalization, completion and recording options", () => {
  it("waits for the final late ASR segment before automatic API analysis and the completion webhook", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return String(url).includes("ai.example") ? apiCompletion() : new Response(null, { status: 204 });
    }));
    const f = await fixture({ settings: { summaryMode: "api", aiBaseUrl: "https://ai.example/v1", aiModel: "test", webhookUrl: "https://receiver.example/events", webhookSecret: "private-key" } });
    const id = await join(f);
    const runtime = f.fake.get(id);
    runtime.audio = Buffer.alloc(1000, 3);
    runtime.segments = [segment(0, 0, "Анна", "Решили проверить выпуск завтра.")];
    runtime.transcriberAlive = true;
    runtime.transcriber = transcriberState({ phase: "finalizing", audioSec: 15, processedSec: 10, segments: 1 });
    f.fake.setBot(id, { phase: "ended", endReason: "stopped", audio: { seconds: 15, bytes: 1000 } }, false);
    await f.service.tick();
    expect(f.service.requireMeeting(id).status).toBe("processing");
    expect(requests).toEqual([]);
    const row = await finish(f, id);
    runtime.transcriberAlive = false;
    await f.service.notetaker.completed(row);
    expect(requests.filter((r) => r.url.includes("ai.example"))).toHaveLength(1);
    const event = requests.find((r) => r.url.includes("receiver.example"))!;
    expect(event).toBeDefined();
    expect(event.body.data).toMatchObject({ transcriptFinal: true, segmentsCount: 2, analysis: { meetingId: id } });
    expect(JSON.stringify(event.body)).toContain("Я проверю сборку и отправлю отчёт завтра.");
    expect(JSON.stringify(event.body)).not.toContain("private-key");
    expect(event.body.data.url).not.toContain("AbCdEf123");
    await f.service.tick();
    await f.service.notetaker.completed(f.service.requireMeeting(id));
    expect(requests.filter((r) => r.url.includes("receiver.example"))).toHaveLength(1);
  });

  it("finishes an audio-only recording without spawning ASR or asking an agent to analyze it", async () => {
    const f = await fixture({ settings: { autoTranscribe: false } });
    const id = await join(f, {}, "thr_audioonly");
    const start = hostCalls(f.harness, "meeting.start")[0];
    expect(botConfigSchema.parse((start.input as { config: unknown }).config)).toMatchObject({ autoTranscribe: false, liveTranscription: false });
    const runtime = f.fake.get(id);
    runtime.audio = Buffer.alloc(1000, 2);
    f.fake.setBot(id, { phase: "ended", endReason: "stopped", audio: { seconds: 10, bytes: 1000 } }, false);
    await f.service.tick();
    expect(f.service.requireMeeting(id)).toMatchObject({ status: "done", transcriptStatus: "none", transcriptFinal: false, hasAudio: true });
    expect(hostCalls(f.harness, "meeting.ensureTranscriber")).toHaveLength(0);
    const messages = f.harness.inspection.sdk.callsTo("threads.send") as Array<[{ input: Array<{ text: string }> }]>;
    expect(messages).toHaveLength(1);
    expect(messages[0][0].input[0].text).not.toContain("meetings_save_insights");
  });

  it("cancels completion API work on plugin unload without delivering a webhook or persisting insights", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const f = await fixture({ settings: { summaryMode: "api", aiBaseUrl: "https://ai.example/v1", aiModel: "test", webhookUrl: "https://receiver.example/events", webhookSecret: "private-key" } });
    const id = await join(f);
    const row = await finish(f, id);
    await until(() => fetcher.mock.calls.length === 1);
    const pending = f.service.notetaker.completed(row);
    f.service.dispose();
    await pending;
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await f.service.notetaker.analysis.get(id)).toBeNull();
  });

  it("deleting a meeting cancels its pending analysis and leaves no webhook or orphan completion record", async () => {
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
      requests.push(String(url));
      return String(url).includes("ai.example") ? gate : new Response(null, { status: 204 });
    }));
    const f = await fixture({ settings: { summaryMode: "api", aiBaseUrl: "https://ai.example/v1", aiModel: "test", webhookUrl: "https://receiver.example/events", webhookSecret: "private-key" } });
    const id = await join(f);
    const row = await finish(f, id);
    await until(() => requests.length > 0);
    const pending = f.service.notetaker.completed(row);
    await f.harness.behavior.callRpc("meetings.delete", { id });
    release(apiCompletion());
    await pending;
    expect(requests.filter((url) => url.includes("receiver.example"))).toEqual([]);
    expect(await f.service.notetaker.analysis.get(id)).toBeNull();
    expect(await f.bb.storage.kv.get("meeting-completion.v1." + id)).toBeUndefined();
    expect(await f.bb.storage.kv.get("requested-analysis.v1." + id)).toBeUndefined();
  });

  it("deleting while an agent result is saving rejects that result and removes any late persisted analysis", async () => {
    const f = await fixture();
    const id = await join(f);
    await finish(f, id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.service.notetaker.analysis.save.bind(f.service.notetaker.analysis);
    const saving = vi.spyOn(f.service.notetaker.analysis, "save").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = f.harness.behavior.callRpc("meetings.saveInsights", { id, insights: insights() });
    const rejected = expect(pending).rejects.toThrow("удалена");
    await until(() => saving.mock.calls.length === 1);
    await f.harness.behavior.callRpc("meetings.delete", { id });
    release();
    await rejected;
    expect(await f.service.notetaker.analysis.get(id)).toBeNull();
    expect(await f.bb.storage.kv.get("meeting-completion.v1." + id)).toBeUndefined();
  });
});

describe("platform and browser account boundaries", () => {
  it.each([
    ["zoom", "https://zoom.us/j/81234567890?pwd=one", "https://app.zoom.us/wc/81234567890/join?pwd=two"],
    ["meet", "https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij?authuser=1"],
    ["telemost", "https://telemost.yandex.ru/j/12345678901234567890", "https://telemost.yandex.com/j/12345678901234567890"],
    ["jitsi", "https://meet.jit.si/ReleaseDiscussion", "https://meet.jit.si/ReleaseDiscussion#config.startWithAudioMuted=true"],
  ])("suppresses a second active %s bot despite equivalent invitation formats", async (_platform, first, second) => {
    const f = await fixture();
    await join(f, { url: first });
    await expect(join(f, { url: second })).rejects.toThrow("уже");
    expect(hostCalls(f.harness, "meeting.start")).toHaveLength(1);
  });

  it("routes Meet and Telemost to their own authenticated profiles without reusing the Zoom profile", async () => {
    const f = await fixture({ settings: { useZoomAccount: true, useMeetAccount: true, useTelemostAccount: true, maxConcurrentBots: 4 } });
    f.fake.profile = { ...f.fake.profile, exists: true, signedIn: true };
    await join(f, { url: "https://meet.google.com/abc-defg-hij" });
    await join(f, { url: "https://telemost.yandex.ru/j/12345678901234567890" });
    const configs = hostCalls(f.harness, "meeting.start").map((call) => botConfigSchema.parse((call.input as { config: unknown }).config));
    expect(configs[0]).toMatchObject({ platform: "meet", browserProfileDir: "/host/profiles/meet", zoomProfileDir: null });
    expect(configs[1]).toMatchObject({ platform: "telemost", browserProfileDir: "/host/profiles/telemost", zoomProfileDir: null });
    const accounts = await f.harness.behavior.callRpc("accounts.status", {});
    expect(JSON.stringify(accounts)).not.toContain("/host/profiles");
  });

  it("rejects profiles belonging to another platform or outside plugin storage before launching any process", async () => {
    const { paths } = await fakeHostData({ runtime: false });
    for (const profile of [path.join(paths.profiles, "zoom"), "/tmp/unrelated-browser-profile"]) {
      const id = newMeetingId();
      await expect(startMeeting(paths, botConfig(id, { platform: "meet", url: "https://meet.google.com/abc-defg-hij", browserProfileDir: profile }))).rejects.toThrow("этой платформе");
      await expect(fs.stat(path.join(paths.meetings, id))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
