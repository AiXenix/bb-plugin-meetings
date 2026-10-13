import { describe, expect, it } from "vitest";
import { botConfigSchema } from "../src/shared/runtime-files.js";
import { Repository } from "../src/server/db.js";
import {
  CHROME,
  GIGAAM_URL,
  ZOOM_URL,
  uniqueZoomUrl,
  botState,
  envReport,
  holdStart,
  hostCalls,
  load,
  segment,
  transcriberState,
  until,
} from "./server-fixtures.js";

const T0 = Date.UTC(2026, 9, 13, 7, 0, 0);

interface Summary {
  id: string;
  status: string;
  statusDetail: string | null;
  title: string;
  errorCode: string | null;
  errorMessage: string | null;
  segmentsCount: number;
  transcriptStatus: string;
  transcriptProgress: number | null;
  speakers: Array<{ key: string; label: string; originalLabel: string }>;
  activeSpeakers: string[];
  participantsCount: number | null;
  durationSec: number;
  hasAudio: boolean;
  screenshotVersion: number | null;
  scheduledAt: number | null;
}

async function join(harness: Awaited<ReturnType<typeof load>>["harness"], input: Record<string, unknown> = {}) {
  return ((await harness.behavior.callRpc("meetings.join", { url: ZOOM_URL, ...input })) as { meeting: Summary }).meeting;
}

async function get(harness: Awaited<ReturnType<typeof load>>["harness"], id: string) {
  return ((await harness.behavior.callRpc("meetings.get", { id })) as { meeting: Summary & { participants: string[]; speakerNames: Record<string, string> } }).meeting;
}

describe("join", () => {
  it("starts a bot with a BotConfig built from the settings", async () => {
    const { harness, fake } = await load({
      settings: {
        botName: "Записыватель",
        maxDurationMinutes: 90,
        aloneTimeoutMinutes: 0.5,
        waitingTimeoutMinutes: 3,
        silenceTimeoutMinutes: 0,
        screenshotIntervalSec: 5,
        chatAnnouncement: "Привет! Я записываю встречу.",
        speakerSelectors: '{"lagMs":{"tile":900}}',
        liveTranscription: true,
        diarization: "ui",
        speakerLagMs: 500,
        keepRawAudio: true,
        useZoomAccount: true,
      },
    });
    fake.profile = { ...fake.profile, exists: true, signedIn: true, updatedAt: 1 };
    const meeting = await join(harness);
    expect(meeting).toMatchObject({ title: "Zoom 81234567890", status: "starting" });
    const [start] = hostCalls(harness, "meeting.start");
    const config = botConfigSchema.parse((start?.input as { config: unknown }).config);
    expect(config).toEqual({
      version: 1,
      meetingId: meeting.id,
      mode: "meeting",
      platform: "zoom",
      url: ZOOM_URL,
      joinUrl: "https://app.zoom.us/wc/81234567890/join?pwd=AbCdEf123.1",
      meetingNumber: "81234567890",
      passcode: "AbCdEf123.1",
      botName: "Записыватель",
      maxDurationSec: 5400,
      aloneTimeoutSec: 30,
      waitingTimeoutSec: 180,
      silenceTimeoutSec: 0,
      screenshotIntervalSec: 5,
      chatAnnouncement: "Привет! Я записываю встречу.",
      speakerSelectors: { lagMs: { tile: 900 } },
      chromePath: CHROME,
      zoomProfileDir: fake.profile.path,
      liveTranscription: true,
      transcriber: { gigaamUrl: GIGAAM_URL, diarization: "ui", speakerLagMs: 500, keepRawAudio: true, threads: 0 },
      createdAt: config.createdAt,
    });
    expect(start?.hostId).toBe("host-1");
    expect(meeting.id).toMatch(/^mtg_[a-z0-9]{12}$/);
  });

  it("applies per-meeting title, bot name and duration", async () => {
    const { harness } = await load();
    const meeting = await join(harness, { title: "Планёрка", botName: "Бот", maxDurationMinutes: 30 });
    expect(meeting.title).toBe("Планёрка");
    const config = botConfigSchema.parse((hostCalls(harness, "meeting.start")[0]?.input as { config: unknown }).config);
    expect(config).toMatchObject({ botName: "Бот", maxDurationSec: 1800, zoomProfileDir: null });
    const detail = (await harness.behavior.callRpc("meetings.get", { id: meeting.id })) as { meeting: { maxDurationMinutes: number } };
    expect(detail.meeting.maxDurationMinutes).toBe(30);
  });

  it("installs the per-version runtime by itself after a plugin update, then joins", async () => {
    const { harness, fake } = await load();
    const missing = envReport({
      ready: false,
      items: [{ id: "runtime", label: "Файлы бота", ok: false, required: true, version: null, detail: "Не установлены", fix: null }],
    });
    fake.env = missing;
    const setupCalls = () => hostCalls(harness, "env.setup").length;
    const original = fake.handle.bind(fake);
    fake.handle = (method: string, input: unknown) => {
      if (method === "env.setup") fake.env = envReport(); // the install finishes at once
      return original(method, input);
    };
    const meeting = await join(harness);
    expect(setupCalls()).toBe(1);
    expect(meeting.status).not.toBe("failed");
    expect(hostCalls(harness, "meeting.start")).toHaveLength(1);
  });

  it("rejects bad links, missing components and a missing primary machine", async () => {
    const { harness, fake } = await load();
    await expect(harness.behavior.callRpc("meetings.join", { url: "https://meet.google.com/abc" })).rejects.toThrow(
      /Поддерживаются только ссылки Zoom/,
    );
    fake.env = envReport({
      ready: false,
      items: [{ id: "xvfb", label: "Xvfb", ok: false, required: true, version: null, detail: "not found", fix: "sudo apt install xvfb" }],
    });
    await expect(harness.behavior.callRpc("meetings.join", { url: ZOOM_URL })).rejects.toThrow(/Не хватает компонентов для записи: Xvfb/);
    expect(hostCalls(harness, "meeting.start")).toEqual([]);
    expect(((await harness.behavior.callRpc("meetings.list", {})) as { meetings: unknown[] }).meetings).toEqual([]);

    const noHost = await load({ primaryHostId: null });
    await expect(noHost.harness.behavior.callRpc("meetings.join", { url: ZOOM_URL })).rejects.toThrow(/основная машина/);
  });

  it("marks the meeting failed when the host cannot start the bot", async () => {
    const { harness, fake } = await load();
    fake.failStart = "spawn failed: ENOENT";
    await expect(join(harness)).rejects.toThrow(/Не удалось запустить бота: spawn failed: ENOENT/);
    const [meeting] = ((await harness.behavior.callRpc("meetings.list", {})) as { meetings: Summary[] }).meetings;
    expect(meeting).toMatchObject({ status: "failed", errorCode: "unknown" });
  });

  it("enforces maxConcurrentBots over live meetings", async () => {
    const { harness, service, fake } = await load({ settings: { maxConcurrentBots: 1 } });
    const first = await join(harness);
    await expect(join(harness, { url: uniqueZoomUrl() })).rejects.toThrow(/лимит «Одновременных записей» \(1\)/);
    // Once the first one is processing, a new bot may start.
    fake.setBot(first.id, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 10, bytes: 100 } }, false);
    fake.get(first.id).audio = Buffer.alloc(100, 1);
    fake.get(first.id).transcriber = transcriberState({ phase: "finalizing" });
    fake.get(first.id).transcriberAlive = true;
    await service.tick();
    expect((await get(harness, first.id)).status).toBe("processing");
    expect((await join(harness, { url: uniqueZoomUrl() })).status).toBe("starting");
  });
});

describe("scheduling", () => {
  it("starts a scheduled meeting when it is due, within the concurrency limit", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock, settings: { maxConcurrentBots: 1 } });
    const scheduled = await join(harness, { scheduledAt: T0 + 10 * 60_000, title: "Ретро" });
    expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: T0 + 10 * 60_000, title: "Ретро" });
    expect(hostCalls(harness, "meeting.start")).toEqual([]);
    expect(await service.tick()).toBe(15_000);

    // Another bot is busy when the time comes: the meeting waits for a free slot.
    const busy = await join(harness, { url: uniqueZoomUrl() });
    clock = T0 + 10 * 60_000;
    await service.tick();
    expect((await get(harness, scheduled.id)).statusDetail).toBe("Ждёт свободного бота (лимит 1)");

    fake.setBot(busy.id, { phase: "ended", endReason: "stopped" }, false);
    await service.tick();
    expect((await get(harness, busy.id)).status).toBe("cancelled");
    await service.tick();
    const started = hostCalls(harness, "meeting.start").map((call) => (call.input as { config: { meetingId: string } }).config.meetingId);
    expect(started).toEqual([busy.id, scheduled.id]);
    expect((await get(harness, scheduled.id)).status).toBe("starting");
  });

  it("gives up on meetings missed by more than two hours and tells the thread", async () => {
    let clock = T0;
    const { harness, service } = await load({ now: () => clock });
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--at", new Date(T0 + 60_000).toISOString(), "--json"], {
      threadId: "thr_missed",
    });
    const scheduled = (JSON.parse(result.stdout) as { meeting: Summary }).meeting;
    expect(scheduled.status).toBe("scheduled");
    clock = T0 + 3 * 3600_000;
    await service.tick();
    expect(await get(harness, scheduled.id)).toMatchObject({
      status: "failed",
      statusDetail: "Пропущена",
      errorMessage: "Встреча пропущена: в назначенное время bb не работал",
    });
    expect(hostCalls(harness, "meeting.start")).toEqual([]);
    const sends = harness.inspection.sdk.callsTo("threads.send") as Array<[{ threadId: string; input: Array<{ text: string }> }]>;
    expect(sends).toHaveLength(1);
    expect(sends[0]![0].threadId).toBe("thr_missed");
    expect(sends[0]![0].input[0]!.text).toContain("Причина: Встреча пропущена");
  });

  it("waits for a free bot at the regular poll rate and explains a miss caused by the limit", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock, settings: { maxConcurrentBots: 1 } });
    const busy = await join(harness);
    fake.setBot(busy.id, { phase: "in_meeting" });
    const scheduled = await join(harness, { scheduledAt: T0 + 60_000 });
    clock = T0 + 60_000;
    // Overdue but held back by the limit: no 500 ms busy loop over the host.
    expect(await service.tick()).toBe(2_000);
    expect((await get(harness, scheduled.id)).statusDetail).toBe("Ждёт свободного бота (лимит 1)");
    clock = T0 + 60_000 + 2 * 3600_000 + 1;
    await service.tick();
    expect(await get(harness, scheduled.id)).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("все боты были заняты"),
    });
  });
});

describe("races with a starting bot", () => {
  async function startingId(harness: Awaited<ReturnType<typeof load>>["harness"]): Promise<string> {
    await until(() => hostCalls(harness, "meeting.start").length === 1);
    return botConfigSchema.parse((hostCalls(harness, "meeting.start")[0]!.input as { config: unknown }).config).meetingId;
  }

  it("delivers a stop pressed while meeting.start is still running", async () => {
    const { harness, fake } = await load({ now: () => T0 });
    const release = holdStart(fake);
    const joining = harness.behavior.runCli(["join", ZOOM_URL, "--json"], { threadId: "thr_stop" });
    const id = await startingId(harness);
    const stopping = harness.behavior.callRpc("meetings.stop", { id }) as Promise<{ meeting: Summary }>;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not "lost": the host has no directory for it yet, so the stop waits for the start.
    expect(await get(harness, id)).toMatchObject({ status: "starting", errorCode: null });
    expect(hostCalls(harness, "meeting.stop")).toEqual([]);
    release();
    expect((await joining).exitCode).toBe(0);
    const stopped = (await stopping).meeting;
    expect(hostCalls(harness, "meeting.stop")).toHaveLength(1);
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: null, errorMessage: null });
    expect(fake.get(id).bot).toMatchObject({ phase: "ended", endReason: "stopped" });
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("removes the bot of a meeting deleted while meeting.start is running", async () => {
    const { harness, fake } = await load({ now: () => T0 });
    const release = holdStart(fake);
    const joining = harness.behavior.callRpc("meetings.join", { url: ZOOM_URL });
    const id = await startingId(harness);
    expect(await harness.behavior.callRpc("meetings.delete", { id })).toEqual({ deleted: true });
    expect(hostCalls(harness, "meeting.delete")).toEqual([]);
    release();
    await expect(joining).rejects.toThrow(/не найдена/);
    expect(hostCalls(harness, "meeting.delete").map((call) => (call.input as { meetingId: string }).meetingId)).toEqual([id]);
    expect(fake.meetings.has(id)).toBe(false);
  });

  it("removes the bot of a deleted scheduled meeting the scheduler was starting", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock });
    const scheduled = await join(harness, { scheduledAt: T0 + 60_000 });
    const release = holdStart(fake);
    clock = T0 + 60_000;
    const ticking = service.tick();
    const id = await startingId(harness);
    expect(id).toBe(scheduled.id);
    expect(await harness.behavior.callRpc("meetings.delete", { id })).toEqual({ deleted: true });
    release();
    await ticking;
    expect(fake.meetings.has(id)).toBe(false);
    expect(((await harness.behavior.callRpc("meetings.list", {})) as { meetings: unknown[] }).meetings).toEqual([]);
  });

  it("does not keep segments of a meeting deleted during a reconcile", async () => {
    const { bb, harness, service, fake } = await load();
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    fake.setBot(meeting.id, { phase: "in_meeting" });
    runtime.transcriber = transcriberState();
    runtime.transcriberAlive = true;
    runtime.segments = [segment(0, 0, "Анна", "Секретное обсуждение.")];
    // The segments page is read, but its answer arrives only after the delete.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = fake.handle.bind(fake);
    fake.handle = (method, input) => {
      const out = handle(method, input);
      return method === "meeting.segments" ? gate.then(() => out) : out;
    };
    const ticking = service.tick();
    await until(() => hostCalls(harness, "meeting.segments").length === 1);
    const deleting = harness.behavior.callRpc("meetings.delete", { id: meeting.id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await ticking;
    expect(await deleting).toEqual({ deleted: true });
    expect(new Repository(bb.storage.database()).segmentStats(meeting.id).count).toBe(0);
    expect(((await harness.behavior.callRpc("meetings.search", { query: "секретное" })) as { hits: unknown[] }).hits).toEqual([]);
  });
});

describe("reconcile", () => {
  it("follows a meeting from joining to done, ingests segments and notifies once", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock });
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--title", "Бюджет Q4", "--json"], { threadId: "thr_42" });
    expect(result.exitCode).toBe(0);
    const { meeting } = JSON.parse(result.stdout) as { meeting: Summary & { url: string } };
    const id = meeting.id;
    expect(meeting.url).toBe("https://us02web.zoom.us/j/81234567890?pwd=***");

    fake.setBot(id, { phase: "joining" });
    expect(await service.tick()).toBe(2_000);
    expect((await get(harness, id)).status).toBe("joining");

    fake.setBot(id, { phase: "waiting_room", detail: "Waiting for the host to admit us" });
    await service.tick();
    expect((await get(harness, id)).status).toBe("waiting_room");
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "meetings.changed", payload: { id } });

    // Recording with live segments.
    const runtime = fake.get(id);
    runtime.audio = Buffer.alloc(5000, 7);
    runtime.screenshotMtime = 123;
    runtime.transcriber = transcriberState({ phase: "live", processedSec: 20, audioSec: 30 });
    runtime.transcriberAlive = true;
    runtime.segments = [
      segment(0, 1, "Анна", "Добрый день, обсуждаем бюджет на четвёртый квартал."),
      segment(1, 5, "unknown", "Мы потратили ёлки-палки много денег.", { speakerKey: "unknown", speaker: "Неизвестный", source: "none" }),
    ];
    fake.setBot(id, {
      phase: "in_meeting",
      joinedAt: T0 + 1000,
      recordingStartedAt: T0 + 2000,
      activeSpeakers: ["Анна"],
      participants: { count: 3, names: ["Анна", "Борис", "Notetaker"] },
      audio: { seconds: 30, bytes: 5000 },
    });
    await service.tick();
    let detail = await get(harness, id);
    expect(detail).toMatchObject({
      status: "recording",
      transcriptStatus: "live",
      segmentsCount: 2,
      activeSpeakers: ["Анна"],
      participantsCount: 3,
      participants: ["Анна", "Борис", "Notetaker"],
      durationSec: 30,
      hasAudio: true,
      screenshotVersion: 123,
    });
    const live = (await harness.behavior.callRpc("meetings.segments", { id })) as { segments: unknown[]; final: boolean; total: number; lastId: number };
    expect(live).toMatchObject({ final: false, total: 2, lastId: 1 });

    // Search: Russian prefix match, case folding and ё/е folding.
    const hits = (await harness.behavior.callRpc("meetings.search", { query: "БЮДЖЕТ" })) as { hits: Array<{ meetingId: string; snippet: string; speaker: string }> };
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]).toMatchObject({ meetingId: id, speaker: "Анна" });
    expect(hits.hits[0]?.snippet).toContain("\u0002бюджет\u0003");
    expect(((await harness.behavior.callRpc("meetings.search", { query: "елки" })) as { hits: unknown[] }).hits).toHaveLength(1);
    expect(((await harness.behavior.callRpc("meetings.search", { query: 'квартал" OR "x' })) as { hits: unknown[] }).hits).toHaveLength(0);

    runtime.segments.push(segment(2, 9, "Борис", "Согласен, давайте сократим расходы."));
    await service.tick();
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "meetings.segments", payload: { id, lastId: 2 } });
    expect((await get(harness, id)).segmentsCount).toBe(3);

    // The bot leaves; the transcriber finalizes.
    clock += 60_000;
    fake.setBot(id, { phase: "ended", endReason: "meeting_ended", endedAt: clock, activeSpeakers: [] }, false);
    runtime.transcriber = transcriberState({ phase: "finalizing", processedSec: 15, audioSec: 30 });
    await service.tick();
    detail = await get(harness, id);
    expect(detail).toMatchObject({ status: "processing", transcriptStatus: "finalizing", transcriptProgress: 0.5, activeSpeakers: [] });

    // The transcriber died: it is respawned in live mode (resumes from its checkpoint).
    runtime.transcriberAlive = false;
    await service.tick();
    expect(fake.ensureCalls).toEqual([{ meetingId: id, mode: "live" }]);
    const ensure = hostCalls(harness, "meeting.ensureTranscriber")[0]?.input as { transcriber: { gigaamUrl: string } };
    expect(ensure.transcriber.gigaamUrl).toBe(GIGAAM_URL);

    // Final transcript with refined speakers replaces the live segments.
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.transcriber = transcriberState({ phase: "done", processedSec: 30, audioSec: 30 });
    runtime.segments = [
      segment(0, 1, "Анна", "Добрый день, обсуждаем бюджет на четвёртый квартал."),
      segment(1, 5, "Спикер 2", "Мы потратили много денег на маркетинг."),
      segment(2, 9, "Борис", "Согласен, давайте сократим расходы."),
    ];
    await service.tick();
    detail = await get(harness, id);
    expect(detail).toMatchObject({ status: "done", transcriptStatus: "done", segmentsCount: 3, transcriptProgress: null });
    expect(detail.speakers.map((s) => s.key).sort()).toEqual(["spk:2", "ui:Анна", "ui:Борис"]);
    const final = (await harness.behavior.callRpc("meetings.segments", { id })) as { final: boolean; segments: Array<{ text: string }> };
    expect(final.final).toBe(true);
    expect(((await harness.behavior.callRpc("meetings.search", { query: "елки" })) as { hits: unknown[] }).hits).toHaveLength(0);
    expect(((await harness.behavior.callRpc("meetings.search", { query: "маркетинг" })) as { hits: unknown[] }).hits).toHaveLength(1);

    const sends = harness.inspection.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    const [args] = sends[0] as [{ threadId: string; mode: string; input: Array<{ type: string; text: string; mentions: unknown[] }> }];
    expect(args.threadId).toBe("thr_42");
    expect(args.mode).toBe("queue-if-active");
    expect(args.input).toHaveLength(1);
    expect(args.input[0]).toMatchObject({ type: "text", mentions: [] });
    const text = args.input[0]!.text;
    expect(text).toContain(`Встреча «Бюджет Q4» (${id}) записана и расшифрована.`);
    expect(text).toContain("Длительность: 30 с.");
    expect(text).toContain("Спикеры: Анна (33%), Спикер 2 (33%), Борис (33%).");
    expect(text).toContain(`bb meetings transcript ${id}`);
    expect(text).toContain("meetings_save_summary");
    expect(text).not.toContain("AbCdEf123");

    // Nothing more happens on later ticks.
    await service.tick();
    await service.tick();
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(await service.tick()).toBe(15_000);
  });

  it("notifies failures with the Russian explanation, unless disabled", async () => {
    const { harness, service, fake } = await load();
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--json"], { threadId: "thr_7" });
    const { meeting } = JSON.parse(result.stdout) as { meeting: Summary };
    fake.setBot(meeting.id, { phase: "failed", endReason: "error", error: { code: "wrong_passcode", message: "Passcode wrong" } }, false);
    await service.tick();
    const failed = await get(harness, meeting.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "wrong_passcode" });
    const sends = harness.inspection.sdk.callsTo("threads.send") as Array<[{ input: Array<{ text: string }> }]>;
    expect(sends).toHaveLength(1);
    expect(sends[0]![0].input[0]!.text).toContain("Причина: Неверный код доступа");

    const quiet = await load({ settings: { notifyThread: false } });
    const r2 = await quiet.harness.behavior.runCli(["join", ZOOM_URL, "--json"], { threadId: "thr_8" });
    const id2 = (JSON.parse(r2.stdout) as { meeting: Summary }).meeting.id;
    quiet.fake.setBot(id2, { phase: "failed", error: { code: "denied", message: "Removed" } }, false);
    await quiet.service.tick();
    expect(quiet.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);

    const optOut = await load();
    const r3 = await optOut.harness.behavior.runCli(["join", ZOOM_URL, "--no-notify", "--json"], { threadId: "thr_9" });
    const id3 = (JSON.parse(r3.stdout) as { meeting: { id: string; requestedByThreadId: string | null } }).meeting;
    expect(id3.requestedByThreadId).toBeNull();
  });

  it("survives a deleted thread", async () => {
    const { harness, service, fake } = await load({ sendThrows: true });
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--json"], { threadId: "thr_gone" });
    const { meeting } = JSON.parse(result.stdout) as { meeting: Summary };
    fake.setBot(meeting.id, { phase: "failed", error: { code: "invalid_meeting", message: "invalid" } }, false);
    await service.tick();
    expect((await get(harness, meeting.id)).status).toBe("failed");
    expect(harness.inspection.logEntries.some((e) => e.level === "warn" && e.message.includes("thread is gone"))).toBe(true);
  });

  it("confirms a crash on a second poll, then transcribes what was recorded", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock });
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    runtime.audio = Buffer.alloc(500, 1);
    fake.setBot(meeting.id, { phase: "in_meeting", audio: { seconds: 40, bytes: 500 } });
    await service.tick();
    // The process is gone but state.json still says in_meeting.
    fake.setBot(meeting.id, { phase: "in_meeting" }, false);
    await service.tick();
    expect((await get(harness, meeting.id)).status).toBe("recording");
    clock += 2_000;
    await service.tick();
    const crashed = await get(harness, meeting.id);
    expect(crashed).toMatchObject({ status: "processing", errorCode: "browser_crashed" });
    expect(fake.ensureCalls).toEqual([{ meetingId: meeting.id, mode: "live" }]);
  });

  it("reloads live segments when a resumed transcriber dropped lines", async () => {
    const { harness, service, fake } = await load();
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    fake.setBot(meeting.id, { phase: "in_meeting" });
    runtime.transcriber = transcriberState();
    runtime.transcriberAlive = true;
    runtime.segments = [segment(0, 0, "Анна", "Раз."), segment(1, 3, "Анна", "Два."), segment(2, 6, "Анна", "Три.")];
    await service.tick();
    expect((await get(harness, meeting.id)).segmentsCount).toBe(3);
    runtime.segments = [segment(0, 0, "Анна", "Раз."), segment(1, 3, "Анна", "Два, исправлено.")];
    await service.tick();
    const live = (await harness.behavior.callRpc("meetings.segments", { id: meeting.id })) as { segments: Array<{ text: string }> };
    expect(live.segments.map((s) => s.text)).toEqual(["Раз.", "Два, исправлено."]);
  });

  it("marks meetings whose directory is gone as lost on startup", async () => {
    const { harness, service, fake } = await load();
    const meeting = await join(harness);
    fake.setBot(meeting.id, { phase: "in_meeting" });
    await service.tick();
    fake.meetings.delete(meeting.id);
    await service.tick();
    expect(await get(harness, meeting.id)).toMatchObject({ status: "failed", statusDetail: "lost" });
  });

  it("gives an imported recording no 1970 recording date", async () => {
    const { harness, service, fake } = await load({ now: () => T0 });
    const result = await harness.behavior.runCli(["import", "/home/bb/call.mp3", "--json"]);
    const id = (JSON.parse(result.stdout) as { meeting: Summary }).meeting.id;
    const runtime = fake.get(id);
    // The host writes recordingStartedAt 0 for imports.
    fake.setBot(id, { phase: "ended", endReason: "stopped", recordingStartedAt: 0, startedAt: T0, endedAt: T0, audio: { seconds: 5, bytes: 10 } }, false);
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.segments = [segment(0, 0, "Спикер 1", "Импортированная запись.")];
    await service.tick();
    expect(await get(harness, id)).toMatchObject({ status: "done", recordingStartedAt: null });
    const download = await harness.behavior.fetchHttp("GET", `/download?id=${id}&format=txt`);
    expect(download.headers.get("content-disposition")).not.toContain("1970");
    const hits = (await harness.behavior.callRpc("meetings.search", { query: "импортированная" })) as { hits: Array<{ meetingDate: number }> };
    expect(hits.hits[0]?.meetingDate).toBe(T0);
  });

  it("fails processing after three failed transcriber runs", async () => {
    const { harness, service, fake } = await load();
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    runtime.audio = Buffer.alloc(10, 1);
    fake.setBot(meeting.id, { phase: "ended", endReason: "stopped", audio: { seconds: 5, bytes: 10 } }, false);
    // The same failed run seen again (the host is backing off) is counted once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (let poll = 0; poll < 3; poll += 1) {
        runtime.transcriber = transcriberState({ phase: "failed", error: "No module named sherpa_onnx", startedAt: 1000 + attempt });
        runtime.transcriberAlive = false;
        await service.tick();
      }
    }
    expect(await get(harness, meeting.id)).toMatchObject({ status: "processing" });
    expect(fake.ensureCalls.length).toBe(6);
    runtime.transcriber = transcriberState({ phase: "failed", error: "No module named sherpa_onnx", startedAt: 1002 });
    runtime.transcriberAlive = false;
    await service.tick();
    expect(await get(harness, meeting.id)).toMatchObject({
      status: "failed",
      transcriptStatus: "failed",
      transcriptError: "No module named sherpa_onnx",
    });
    expect(fake.ensureCalls.length).toBe(6);
  });

  it("fails processing when the transcriber keeps dying without writing a failed phase", async () => {
    let clock = T0;
    const { harness, service, fake } = await load({ now: () => clock });
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    runtime.audio = Buffer.alloc(10, 1);
    fake.setBot(meeting.id, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 5, bytes: 10 } }, false);
    // Every run is killed (OOM, segfault) while finalizing: transcriber.json never says "failed".
    for (let run = 0; run < 3; run += 1) {
      runtime.transcriber = transcriberState({ phase: "finalizing", startedAt: 2_000 + run, processedSec: 5, audioSec: 5 });
      runtime.transcriberAlive = false;
      clock += 10 * 60_000;
      await service.tick();
    }
    expect(await get(harness, meeting.id)).toMatchObject({
      status: "failed",
      transcriptStatus: "failed",
      transcriptError: "Транскрибатор несколько раз завершился с ошибкой. Смотрите bb meetings logs",
    });
    expect(fake.ensureCalls).toHaveLength(2);
  });

  it("re-transcribes a meeting that failed in transcription: clears the error and tells the thread", async () => {
    const { harness, service, fake } = await load();
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--json"], { threadId: "thr_again" });
    const id = (JSON.parse(result.stdout) as { meeting: Summary }).meeting.id;
    const runtime = fake.get(id);
    runtime.audio = Buffer.alloc(10, 1);
    fake.setBot(id, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 5, bytes: 10 } }, false);
    for (let run = 0; run < 3; run += 1) {
      runtime.transcriber = transcriberState({ phase: "failed", error: "GigaAM 500", startedAt: 1_000 + run });
      runtime.transcriberAlive = false;
      await service.tick();
    }
    expect(await get(harness, id)).toMatchObject({ status: "failed", errorCode: "unknown" });
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);

    await harness.behavior.callRpc("meetings.retranscribe", { id });
    expect(await get(harness, id)).toMatchObject({ status: "processing", errorCode: null, errorMessage: null });
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.transcriber = transcriberState({ mode: "offline", phase: "done", processedSec: 5, audioSec: 5, startedAt: 9_000 });
    runtime.segments = [segment(0, 0, "Анна", "Теперь распозналось.")];
    await service.tick();
    expect(await get(harness, id)).toMatchObject({ status: "done", errorCode: null, errorMessage: null, transcriptError: null });
    const sends = harness.inspection.sdk.callsTo("threads.send") as Array<[{ input: Array<{ text: string }> }]>;
    expect(sends).toHaveLength(2);
    expect(sends[1]![0].input[0]!.text).toContain("записана и расшифрована");
  });

  it("keeps a bot error through a re-transcription", async () => {
    const { harness, service, fake } = await load();
    const meeting = await join(harness);
    const runtime = fake.get(meeting.id);
    runtime.audio = Buffer.alloc(10, 1);
    runtime.final = true;
    runtime.segments = [segment(0, 0, "Анна", "Связь пропала.")];
    fake.setBot(meeting.id, { phase: "failed", endReason: "error", error: { code: "browser_crashed", message: "boom" }, audio: { seconds: 5, bytes: 10 } }, false);
    await service.tick();
    expect(await get(harness, meeting.id)).toMatchObject({ status: "done", errorCode: "browser_crashed" });
    await harness.behavior.callRpc("meetings.retranscribe", { id: meeting.id });
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.segments = [segment(0, 0, "Анна", "Связь пропала.")];
    await service.tick();
    expect(await get(harness, meeting.id)).toMatchObject({ status: "done", errorCode: "browser_crashed" });
  });

  it("runs the scheduler service and stops promptly on abort", async () => {
    const { harness, fake } = await load();
    const meeting = await join(harness);
    fake.setBot(meeting.id, { phase: "in_meeting" });
    const run = harness.behavior.runService("scheduler");
    for (let i = 0; i < 50 && (await get(harness, meeting.id)).status !== "recording"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await get(harness, meeting.id)).status).toBe("recording");
    const started = Date.now();
    run.controller.abort();
    await run.done;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("user actions", () => {
  it("stops, cancels and deletes", async () => {
    const { harness, service, fake } = await load({ now: () => T0 });
    const live = await join(harness);
    fake.setBot(live.id, { phase: "in_meeting", audio: { seconds: 12, bytes: 300 } });
    fake.get(live.id).audio = Buffer.alloc(300, 1);
    fake.get(live.id).segments = [segment(0, 0, "Анна", "Тестовая запись.")];
    await service.tick();
    const stopped = ((await harness.behavior.callRpc("meetings.stop", { id: live.id })) as { meeting: Summary }).meeting;
    expect(stopped.status).toBe("processing");
    expect(hostCalls(harness, "meeting.stop")).toHaveLength(1);

    const later = await join(harness, { scheduledAt: T0 + 3600_000 });
    await expect(harness.behavior.callRpc("meetings.cancel", { id: live.id })).rejects.toThrow(/Отменить можно только запланированную/);
    const cancelled = ((await harness.behavior.callRpc("meetings.cancel", { id: later.id })) as { meeting: Summary }).meeting;
    expect(cancelled.status).toBe("cancelled");

    expect(await harness.behavior.callRpc("meetings.delete", { id: live.id })).toEqual({ deleted: true });
    expect(hostCalls(harness, "meeting.delete").map((c) => (c.input as { meetingId: string }).meetingId)).toEqual([live.id]);
    expect(fake.meetings.has(live.id)).toBe(false);
    expect(((await harness.behavior.callRpc("meetings.search", { query: "тестовая" })) as { hits: unknown[] }).hits).toEqual([]);
    expect(await harness.behavior.callRpc("meetings.delete", { id: later.id })).toEqual({ deleted: true });
    expect(hostCalls(harness, "meeting.delete")).toHaveLength(1);
    await expect(harness.behavior.callRpc("meetings.get", { id: live.id })).rejects.toThrow(/не найдена/);
  });

  it("renames speakers everywhere and re-transcribes", async () => {
    const { harness, service, fake } = await load();
    const meeting = await join(harness, { title: "Ретро" });
    const runtime = fake.get(meeting.id);
    runtime.audio = Buffer.alloc(100, 1);
    runtime.final = true;
    runtime.segments = [segment(0, 0, "Спикер 1", "Начнём ретро."), segment(1, 4, "Спикер 2", "Что прошло хорошо?")];
    fake.setBot(meeting.id, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 8, bytes: 100 } }, false);
    await service.tick();
    expect((await get(harness, meeting.id)).status).toBe("done");

    const renamed = ((await harness.behavior.callRpc("meetings.renameSpeaker", { id: meeting.id, speakerKey: "spk:1", name: "Анна" })) as { meeting: Summary }).meeting;
    expect(renamed.speakers.find((s) => s.key === "spk:1")).toMatchObject({ label: "Анна", originalLabel: "Спикер 1" });
    const cli = await harness.behavior.runCli(["rename-speaker", meeting.id, "Спикер 2", "Борис", "Петров"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("Борис Петров [spk:2]");

    const segments = (await harness.behavior.callRpc("meetings.segments", { id: meeting.id })) as { segments: Array<{ speaker: string }> };
    expect(segments.segments.map((s) => s.speaker)).toEqual(["Анна", "Борис Петров"]);
    const download = await harness.behavior.fetchHttp("GET", `/download?id=${meeting.id}&format=txt`);
    const body = await download.text();
    expect(body).toContain("Анна: Начнём ретро.");
    expect(body).toContain("Борис Петров: Что прошло хорошо?");
    const hits = (await harness.behavior.callRpc("meetings.search", { query: "ретро" })) as { hits: Array<{ speaker: string }> };
    expect(hits.hits[0]?.speaker).toBe("Анна");
    await expect(harness.behavior.callRpc("meetings.renameSpeaker", { id: meeting.id, speakerKey: "spk:9", name: "X" })).rejects.toThrow(
      /Спикер «spk:9» не найден/,
    );
    // An empty name resets to the transcriber's label.
    const reset = ((await harness.behavior.callRpc("meetings.renameSpeaker", { id: meeting.id, speakerKey: "spk:1", name: "" })) as { meeting: Summary }).meeting;
    expect(reset.speakers.find((s) => s.key === "spk:1")?.label).toBe("Спикер 1");

    expect((await get(harness, meeting.id)).speakerNames).toEqual({ "spk:2": "Борис Петров" });
    const again = ((await harness.behavior.callRpc("meetings.retranscribe", { id: meeting.id })) as { meeting: Summary }).meeting;
    expect(again).toMatchObject({ status: "processing", segmentsCount: 0, transcriptStatus: "finalizing" });
    // A new run renumbers the acoustic clusters: "Спикер 2" may be another voice now.
    expect((await get(harness, meeting.id)).speakerNames).toEqual({});
    expect(fake.ensureCalls.at(-1)).toEqual({ meetingId: meeting.id, mode: "offline" });
    expect(((await harness.behavior.callRpc("meetings.segments", { id: meeting.id })) as { total: number }).total).toBe(0);
    runtime.final = true;
    runtime.segments = [segment(0, 0, "Спикер 1", "Начнём ретро заново.")];
    await service.tick();
    expect((await get(harness, meeting.id)).status).toBe("done");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("updates title and summary", async () => {
    const { harness } = await load();
    const meeting = await join(harness);
    const updated = ((await harness.behavior.callRpc("meetings.update", { id: meeting.id, title: "Новое", summaryMd: "## Итоги" })) as { meeting: Summary & { hasSummary: boolean } }).meeting;
    expect(updated).toMatchObject({ title: "Новое", hasSummary: true });
    const cleared = ((await harness.behavior.callRpc("meetings.update", { id: meeting.id, summaryMd: null })) as { meeting: { hasSummary: boolean } }).meeting;
    expect(cleared.hasSummary).toBe(false);
  });

  it("serves the live view and forwards remote control", async () => {
    const { harness, fake } = await load({ now: () => T0 });
    const meeting = await join(harness);
    fake.setBot(meeting.id, { phase: "waiting_room", detail: "Captcha" });
    fake.get(meeting.id).screenshotMtime = 42;
    const view = await harness.behavior.callRpc("meetings.liveView", { id: meeting.id });
    expect(view).toEqual({ screenshotVersion: 42, phase: "waiting_room", detail: "Captcha", controllable: true });
    expect(fake.viewers).toEqual([{ meetingId: meeting.id, untilMs: T0 + 30_000 }]);
    const control = await harness.behavior.callRpc("meetings.control", { id: meeting.id, action: "click", x: 640, y: 360 });
    expect(control).toEqual({ queued: true, seq: 1 });
    expect(hostCalls(harness, "meeting.control")[0]?.input).toEqual({ meetingId: meeting.id, action: "click", x: 640, y: 360 });
    await expect(harness.behavior.callRpc("meetings.liveView", { id: "mtg_unknown0000" })).rejects.toThrow(/не найдена/);
    expect(await harness.behavior.callRpc("meetings.logs", { id: meeting.id })).toEqual({ text: `bot log of ${meeting.id}` });
    expect(await harness.behavior.callRpc("meetings.debugDump", { id: meeting.id })).toEqual({ requested: true });
  });

  it("runs a Zoom sign-in session", async () => {
    const { harness, service, fake } = await load();
    const started = (await harness.behavior.callRpc("zoom.loginStart", null)) as { session: { id: string; phase: string } | null; useZoomAccount: boolean };
    expect(started.session?.phase).toBe("starting");
    const config = botConfigSchema.parse((hostCalls(harness, "meeting.start")[0]?.input as { config: unknown }).config);
    expect(config).toMatchObject({ mode: "login", joinUrl: "https://zoom.us/signin", zoomProfileDir: fake.profile.path, liveTranscription: false });
    const sessionId = started.session!.id;
    // The session is not a meeting, but it has a live view and accepts control.
    fake.setBot(sessionId, { phase: "joining", detail: "Waiting for sign-in" });
    expect(await harness.behavior.callRpc("meetings.liveView", { id: sessionId })).toMatchObject({ phase: "joining", controllable: true });
    expect(((await harness.behavior.callRpc("meetings.list", {})) as { meetings: unknown[] }).meetings).toEqual([]);
    await harness.behavior.callRpc("zoom.loginFinish", null);
    expect(hostCalls(harness, "meeting.control").at(-1)?.input).toEqual({ meetingId: sessionId, action: "done" });
    fake.setBot(sessionId, { phase: "ended", detail: "Signed in", endedAt: 5 }, false);
    fake.profile = { ...fake.profile, exists: true, signedIn: true, updatedAt: 5 };
    await service.tick();
    const status = (await harness.behavior.callRpc("zoom.status", null)) as { profile: { signedIn: boolean }; session: { phase: string } };
    expect(status.profile.signedIn).toBe(true);
    expect(status.session.phase).toBe("ended");
    const out = (await harness.behavior.callRpc("zoom.logout", null)) as { profile: { exists: boolean }; session: unknown };
    expect(out).toMatchObject({ profile: { exists: false }, session: null });
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "meetings.zoom")).toBe(true);
  });

  it("imports a file for offline transcription", async () => {
    const { harness, service, fake } = await load();
    const result = await harness.behavior.runCli(["import", "calls/interview.mp3", "--title", "Интервью"], { cwd: "/home/bb/work" });
    expect(result.stdout).toMatch(/^Imported as mtg_/);
    const call = hostCalls(harness, "meeting.import")[0]?.input as { sourcePath: string; config: unknown };
    expect(call.sourcePath).toBe("/home/bb/work/calls/interview.mp3");
    const id = botConfigSchema.parse(call.config).meetingId;
    expect(await get(harness, id)).toMatchObject({ status: "processing", title: "Интервью" });
    const runtime = fake.get(id);
    runtime.final = true;
    runtime.transcriberAlive = false;
    runtime.segments = [segment(0, 0, "Спикер 1", "Расскажите о себе.")];
    await service.tick();
    expect(await get(harness, id)).toMatchObject({ status: "done", segmentsCount: 1 });
  });

  it("caches the environment report for 10 s and runs setup", async () => {
    let clock = T0;
    const { harness } = await load({ now: () => clock });
    const first = (await harness.behavior.callRpc("env.status", null)) as { env: { ready: boolean }; error: null };
    expect(first.env.ready).toBe(true);
    await harness.behavior.callRpc("env.status", null);
    expect(hostCalls(harness, "env.check")).toHaveLength(1);
    clock += 11_000;
    await harness.behavior.callRpc("env.status", null);
    expect(hostCalls(harness, "env.check")).toHaveLength(2);
    expect(hostCalls(harness, "env.check")[0]?.input).toEqual({ chromePath: "", gigaamUrl: "" });
    await harness.behavior.callRpc("env.setup", {});
    expect(hostCalls(harness, "env.setup")[0]?.input).toEqual({ force: false, chromePath: "", gigaamUrl: "" });
    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "meetings.env", payload: {} });

    const broken = await load();
    broken.fake.handle = () => {
      throw new Error("host worker crashed");
    };
    expect(await broken.harness.behavior.callRpc("env.status", null)).toEqual({ env: null, error: "host worker crashed" });
  });
});

describe("botState fixture", () => {
  it("is a valid state", () => {
    expect(botState("mtg_abcdef12").phase).toBe("joining");
  });
});
