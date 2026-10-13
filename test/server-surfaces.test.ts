import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_PAGE_CHARS } from "../src/server/tools.js";
import { rpcContract } from "../src/shared/rpc-contract.js";
import { ZOOM_URL, hostCalls, load, segment, transcriberState, uniqueZoomUrl } from "./server-fixtures.js";

const T0 = Date.UTC(2026, 9, 13, 7, 0, 0);

type Loaded = Awaited<ReturnType<typeof load>>;

/** A finished meeting with a final transcript of `count` segments. */
async function doneMeeting(loaded: Loaded, count = 3, title = "Планёрка") {
  const { harness, service, fake } = loaded;
  const result = await harness.behavior.runCli(["join", ZOOM_URL, "--title", title, "--json"]);
  const id = (JSON.parse(result.stdout) as { meeting: { id: string } }).meeting.id;
  const runtime = fake.get(id);
  runtime.audio = Buffer.alloc(1000, 3);
  runtime.final = true;
  runtime.segments = Array.from({ length: count }, (_, i) =>
    segment(i, i * 4, i % 2 === 0 ? "Анна" : "Спикер 2", `Реплика номер ${i}: обсуждаем бюджет и сроки проекта.`),
  );
  fake.setBot(id, { phase: "ended", endReason: "meeting_ended", recordingStartedAt: T0, audio: { seconds: count * 4, bytes: 1000 } }, false);
  await service.tick();
  return id;
}

describe("registrations", () => {
  it("registers the RPC methods, routes, CLI, tools and the scheduler", async () => {
    const { harness } = await load();
    const r = harness.inspection.registrations;
    expect([...r.rpcMethods].sort()).toEqual(Object.keys(rpcContract).sort());
    expect(r.httpRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /audio",
      "GET /download",
      "GET /mock-meeting/index.html",
      "GET /mock-meeting/mock.css",
      "GET /mock-meeting/mock.js",
      "GET /screenshot",
      "HEAD /audio",
      "POST /mock-meeting/log",
    ]);
    expect(r.httpRoutes.every((route) => route.auth === "local")).toBe(true);
    expect(r.services.map((s) => s.name)).toEqual(["scheduler"]);
    expect(r.cli?.name).toBe("meetings");
    expect(r.cli?.commands.map((c) => c.name).sort()).toEqual(
      [
        "api",
        "calendar",
        "calendar-skip",
        "calendar-sync",
        "calendar-unskip",
        "cancel",
        "debug-dump",
        "delete",
        "doctor",
        "import",
        "join",
        "list",
        "logs",
        "rename-speaker",
        "retranscribe",
        "screenshot",
        "search",
        "selftest",
        "setup",
        "show",
        "stop",
        "summary",
        "transcript",
        "zoom-login",
        "zoom-logout",
        "zoom-status",
      ].sort(),
    );
    expect(r.agentTools.map((t) => t.name)).toEqual([
      "meetings_join",
      "meetings_status",
      "meetings_stop",
      "meetings_transcript",
      "meetings_search",
      "meetings_save_summary",
      "meetings_rename_speaker",
    ]);
    const joinTool = r.agentTools[0]!;
    expect(joinTool.instructions?.length).toBeLessThan(4096);
    expect(joinTool.presentation?.label?.pending).toBe("Отправляю бота на встречу");
    expect(Object.keys(r.settingsDescriptors)).toEqual([
      "botName",
      "maxDurationMinutes",
      "aloneTimeoutMinutes",
      "waitingTimeoutMinutes",
      "maxConcurrentBots",
      "chatAnnouncement",
      "notifyThread",
      "autoSummaryPrompt",
      "liveTranscription",
      "diarization",
      "speakerLagMs",
      "gigaamUrl",
      "keepRawAudio",
      "screenshotIntervalSec",
      "silenceTimeoutMinutes",
      "useZoomAccount",
      "speakerSelectors",
      "chromePath",
      "calendarIcsUrls",
      "calendarAutoJoin",
      "calendarLeadMinutes",
      "calendarFilter",
      "calendarSyncMinutes",
    ]);
  });

  it("validates settings ranges and JSON", async () => {
    const { harness } = await load();
    await expect(harness.behavior.setSettings({ maxConcurrentBots: 9 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ speakerSelectors: "[1,2]" })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ calendarIcsUrls: "ftp://x" })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ calendarIcsUrls: "https://cal.example.com:99999/secret.ics" })).rejects.toThrow();
    await harness.behavior.setSettings({ speakerSelectors: '{"tile":[".x"]}', calendarIcsUrls: "https://a/b.ics webcal://c/d.ics" });
  });
});

describe("mock meeting page", () => {
  it("serves the embedded mock meeting for the selftest", async () => {
    const { harness } = await load();
    const page = await harness.behavior.fetchHttp("GET", "/mock-meeting/index.html");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain('src="mock.js"');
    const script = await harness.behavior.fetchHttp("GET", "/mock-meeting/mock.js");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const log = await harness.behavior.fetchHttp("POST", "/mock-meeting/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(log.status).toBe(204);
  });

  it("selftest joins the mock page on the loopback URL and reports problems", async () => {
    const { harness, fake } = await load();
    fake.onStatus = (ids) => {
      const runtime = fake.get(ids[0]!);
      if (runtime.bot === null) {
        fake.setBot(ids[0]!, { phase: "in_meeting", activeSpeakers: ["Анна Смирнова"], participants: { count: 4, names: [] } });
        runtime.audio = Buffer.alloc(100, 1);
      } else {
        fake.setBot(ids[0]!, { phase: "ended", endReason: "meeting_ended", audio: { seconds: 30, bytes: 100 } }, false);
        runtime.final = true;
      }
    };
    const result = await harness.behavior.runCli(["selftest", "--json"]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; statuses: string[]; speakers: string[]; kept: boolean; meetingId: string };
    expect(parsed).toMatchObject({ ok: true, statuses: ["starting", "recording", "done"], speakers: ["Анна Смирнова"], kept: false });
    const config = (hostCalls(harness, "meeting.start")[0]?.input as { config: { platform: string; joinUrl: string } }).config;
    expect(config.platform).toBe("mock");
    expect(config.joinUrl).toBe("http://127.0.0.1:38886/api/v1/plugins/meetings/http/mock-meeting/index.html?popup=0");
    expect(hostCalls(harness, "meeting.delete")).toHaveLength(1);

    const failing = await load();
    failing.fake.onStatus = (ids) =>
      failing.fake.setBot(ids[0]!, { phase: "failed", error: { code: "browser_crashed", message: "Chrome exited" } }, false);
    const bad = await failing.harness.behavior.runCli(["selftest"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain("Selftest FAILED");
    expect(bad.stdout).toContain("Problem:   the bot never got into the mock meeting");
    expect(bad.stdout).toContain("Logs: bb meetings logs mtg_");
  });
});

describe("bb meetings CLI", () => {
  it("joins with masked output and schedules with --at", async () => {
    const { harness } = await load({ now: () => T0 });
    const now = await harness.behavior.runCli(["join", ZOOM_URL]);
    expect(now.exitCode).toBe(0);
    expect(now.stdout).toContain('"Zoom 81234567890": starting');
    expect(now.stdout).toContain("Link: https://us02web.zoom.us/j/81234567890?pwd=***");
    expect(now.stdout).not.toContain("AbCdEf123");
    const later = await harness.behavior.runCli(["join", "812 3456 7891", "--at", "2026-10-13T18:30:00+03:00", "--max-duration", "2h"]);
    expect(later.stdout).toContain("scheduled");
    expect(later.stdout).toContain("The bot will join at 13.10.2026");
    const bad = await harness.behavior.runCli(["join", ZOOM_URL, "--at", "tomorrow", "--json"]);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "invalid_time" } });
    const invalid = await harness.behavior.runCli(["join", "https://teams.microsoft.com/l/x"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("Not a joinable Zoom link");
  });

  it("lists an exact status beyond the newest 200 meetings, and pages without skipping same-time meetings", async () => {
    let clock = T0;
    const { harness, fake } = await load({ now: () => clock });
    fake.failStart = "spawn failed";
    const failed = await harness.behavior.runCli(["join", ZOOM_URL, "--json"]);
    expect(failed.exitCode).toBe(1);
    fake.failStart = null;
    // 201 newer meetings, three of them created in the same millisecond.
    for (let i = 0; i < 201; i += 1) {
      if (i < 199) clock += 1;
      await harness.behavior.callRpc("meetings.join", { url: uniqueZoomUrl(), scheduledAt: T0 + 24 * 3600_000 });
    }
    const listed = JSON.parse((await harness.behavior.runCli(["list", "--status", "failed", "--json"])).stdout) as {
      meetings: Array<{ status: string }>;
    };
    expect(listed.meetings.map((m) => m.status)).toEqual(["failed"]);

    const seen = new Set<string>();
    let before: number | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = (await harness.behavior.callRpc("meetings.list", { filter: "all", limit: 2, before })) as {
        meetings: Array<{ id: string }>;
        nextBefore: number | null;
      };
      for (const meeting of result.meetings) seen.add(meeting.id);
      if (result.nextBefore === null || seen.size > 10) break;
      before = result.nextBefore;
    }
    // The first page ends inside the three-meeting tie and takes all of it.
    expect(seen.size).toBeGreaterThanOrEqual(3);
    const firstPage = (await harness.behavior.callRpc("meetings.list", { filter: "all", limit: 2, before: null })) as {
      meetings: Array<{ createdAt: number }>;
    };
    expect(firstPage.meetings.map((m) => m.createdAt)).toEqual([clock, clock, clock]);
  }, 30_000);

  it("waits for the join outcome with --wait", async () => {
    const { harness, fake } = await load();
    let polls = 0;
    fake.onStatus = (ids) => {
      polls += 1;
      if (polls >= 2) fake.setBot(ids[0]!, { phase: "waiting_room" });
    };
    const result = await harness.behavior.runCli(["join", ZOOM_URL, "--wait", "5s"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("waiting_room");
    expect(result.stdout).toContain('ask the host to admit "Notetaker"');
  });

  it("lists, shows and reads transcripts in pages", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded, 5);
    const { harness } = loaded;
    const list = await harness.behavior.runCli(["list"]);
    expect(list.stdout.split("\n")[0]).toMatch(/^ID\s+STATUS\s+WHEN\s+LENGTH\s+TITLE$/);
    expect(list.stdout).toContain(`${id}`);
    expect(list.stdout).toContain("done");
    const filtered = await harness.behavior.runCli(["list", "--status", "recording", "--json"]);
    expect(JSON.parse(filtered.stdout)).toEqual({ meetings: [] });

    const show = await harness.behavior.runCli(["show", id]);
    expect(show.stdout).toContain(`Meeting ${id}: Планёрка`);
    expect(show.stdout).toContain("Status:       done (done)");
    expect(show.stdout).toContain("Link:         https://us02web.zoom.us/j/81234567890?pwd=***");
    expect(show.stdout).toContain("Speakers:     Анна [ui:Анна] 60%, Спикер 2 [spk:2] 40%");

    const page1 = await harness.behavior.runCli(["transcript", id, "--limit", "2"]);
    expect(page1.stdout.startsWith("# Планёрка\n")).toBe(true);
    expect(page1.stdout).toContain("**[00:00:00] Анна:** Реплика номер 0");
    expect(page1.stderr).toContain(`Next page: bb meetings transcript ${id} --from 2`);
    const page2 = await harness.behavior.runCli(["transcript", id, "--from", "2", "--limit", "2", "--format", "txt"]);
    expect(page2.stdout.startsWith("[00:00:08] Анна: Реплика номер 2")).toBe(true);
    expect(page2.stderr).toContain("--from 4 --format txt");
    const last = await harness.behavior.runCli(["transcript", id, "--from", "4"]);
    expect(last.stderr ?? "").toBe("");
    const srt = await harness.behavior.runCli(["transcript", id, "--format", "srt"]);
    expect(srt.stdout.startsWith("1\n00:00:00,000 --> 00:00:03,000\nАнна: Реплика номер 0")).toBe(true);
    const json = JSON.parse((await harness.behavior.runCli(["transcript", id, "--json", "--limit", "3"])).stdout) as {
      segments: unknown[];
      nextFrom: number;
      final: boolean;
    };
    expect(json).toMatchObject({ final: true, nextFrom: 3 });
    expect(json.segments).toHaveLength(3);
  });

  it("searches, saves summaries, guards deletion and reports unknown ids", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded);
    const { harness } = loaded;
    const search = await harness.behavior.runCli(["search", "бюджет", "сроки"]);
    expect(search.stdout.split("\n").filter(Boolean)).toHaveLength(3);
    expect(search.stdout).toContain("**бюджет**");
    expect((await harness.behavior.runCli(["search", "отпуск"])).stdout).toContain('No matches for "отпуск"');

    expect((await harness.behavior.runCli(["summary", id])).stderr).toContain("No summary saved");
    const saved = await harness.behavior.runCli(["summary", id, "--set", "## Итоги\n- решили"]);
    expect(saved.stdout).toContain("saved");
    expect((await harness.behavior.runCli(["summary", id])).stdout).toBe("## Итоги\n- решили\n");

    const refused = await harness.behavior.runCli(["delete", id]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("without --yes");
    expect(refused.stderr).toContain(`bb meetings delete ${id} --yes`);

    const missing = await harness.behavior.runCli(["show", "mtg_nonexistent00", "--json"]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "not_found", hint: "List meetings with: bb meetings list" } });

    expect((await harness.behavior.runCli(["delete", id, "--yes"])).stdout).toContain(`Deleted ${id}`);
  });

  it("prints doctor, logs, screenshot path and zoom-login guidance", async () => {
    const loaded = await load();
    const id = await doneMeeting(loaded);
    const { harness } = loaded;
    const doctor = await harness.behavior.runCli(["doctor"]);
    expect(doctor.stdout).toContain("Recording environment: ready");
    expect(doctor.stdout).toContain("[ok     ] Google Chrome");
    expect(doctor.stdout).toContain("GigaAM: ready at http://127.0.0.1:40000");
    expect((await harness.behavior.runCli(["logs", id, "--lines", "5"])).stdout).toBe(`bot log of ${id}\n`);
    expect((await harness.behavior.runCli(["screenshot", id])).stdout).toBe(`/data/meetings/${id}/screen.jpg\n`);
    const login = await harness.behavior.runCli(["zoom-login"]);
    expect(login.stdout).toContain("https://bb.example/plugins/meetings/meetings");
    const setup = await harness.behavior.runCli(["setup", "--force"]);
    expect(setup.stdout).toContain("Follow progress: bb meetings doctor");
    expect(hostCalls(harness, "env.setup")[0]?.input).toMatchObject({ force: true });
  });
});

describe("agent tools", () => {
  it("meetings_join records the thread and waits for the waiting room", async () => {
    const { harness, fake } = await load();
    let polls = 0;
    fake.onStatus = (ids) => {
      polls += 1;
      fake.setBot(ids[0]!, { phase: polls >= 3 ? "waiting_room" : "joining" });
    };
    const result = await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, waitSeconds: 10 }, { threadId: "thr_5" });
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("Бот в зале ожидания: попросите организатора впустить «Notetaker».");
    expect(text).toContain('ask the host to admit "Notetaker"');
    expect(text).toContain("pwd=***");
    expect(text).not.toContain("AbCdEf123");
    const id = /mtg_[a-z0-9]+/.exec(text)![0];
    const detail = (await harness.behavior.callRpc("meetings.get", { id })) as { meeting: { requestedByThreadId: string; source: string } };
    expect(detail.meeting).toMatchObject({ requestedByThreadId: "thr_5", source: "agent" });
  });

  it("meetings_join reports a failure as an error result without a thread message", async () => {
    const { harness, fake } = await load();
    fake.onStatus = (ids) =>
      fake.setBot(ids[0]!, { phase: "failed", endReason: "error", error: { code: "bot_blocked", message: "We detected you may be a bot" } }, false);
    const result = await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL }, { threadId: "thr_6" });
    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("Не удалось подключиться: Zoom не пускает ботов-гостей");
    expect(text).toContain("Joining failed: Zoom blocks guest bots");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("meetings_join promises a thread message only when notifyThread is on", async () => {
    const { harness } = await load({ now: () => T0, settings: { notifyThread: false } });
    const quiet = (await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, startAt: "2026-10-13T20:00:00Z" }, { threadId: "thr_2" })) as string;
    expect(quiet).toContain("Бот подключится 13.10.2026");
    expect(quiet).not.toContain("пришлю");
    expect(quiet).not.toContain("This thread gets a message");
    const cli = await harness.behavior.runCli(["join", uniqueZoomUrl(), "--at", "2026-10-13T20:00:00Z"], { threadId: "thr_2" });
    expect(cli.stdout).not.toContain("This thread gets a message");
    await harness.behavior.setSettings({ notifyThread: true });
    const loud = (await harness.behavior.callAgentTool("meetings_join", { url: uniqueZoomUrl(), startAt: "2026-10-13T20:00:00Z" }, { threadId: "thr_2" })) as string;
    expect(loud).toContain("Когда встреча закончится, я пришлю сюда сообщение с транскриптом.");
  });

  it("refuses a second bot for the same meeting", async () => {
    const { harness } = await load({ now: () => T0 });
    await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, startAt: "2026-10-13T20:00:00Z" }, { threadId: "thr_1" });
    const again = await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, startAt: "2026-10-13T20:10:00Z" }, { threadId: "thr_1" });
    expect(again).toMatchObject({ isError: true });
    expect(JSON.stringify(again)).toContain("уже запланирована");
    const nextDay = await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, startAt: "2026-10-14T20:00:00Z" }, { threadId: "thr_1" });
    expect(nextDay).not.toMatchObject({ isError: true });
  });

  it("meetings_join schedules and validates", async () => {
    const { harness } = await load({ now: () => T0 });
    const scheduled = (await harness.behavior.callAgentTool("meetings_join", { url: ZOOM_URL, startAt: "2026-10-13T20:00:00Z" }, { threadId: "thr_1" })) as string;
    expect(scheduled).toContain("Бот подключится 13.10.2026");
    expect(hostCalls(harness, "meeting.start")).toEqual([]);
    const bad = await harness.behavior.callAgentTool("meetings_join", { url: "hello" }, { threadId: "thr_1" });
    expect(bad).toMatchObject({ isError: true });
  });

  it("meetings_transcript pages under the character budget", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded, 200);
    const { harness } = loaded;
    const first = (await harness.behavior.callAgentTool("meetings_transcript", { id, maxChars: 3000 })) as string;
    expect(first.length).toBeLessThanOrEqual(3000 + 300);
    expect(first).toContain(`[${id} "Планёрка", segments 0-`);
    expect(first).toContain("Планёрка\nДата:");
    const next = /fromSegment (\d+)\]/.exec(first);
    expect(next).not.toBeNull();
    const second = (await harness.behavior.callAgentTool("meetings_transcript", { id, fromSegment: Number(next![1]), maxChars: 3000 })) as string;
    expect(second).toContain(`segments ${next![1]}-`);
    expect(second).not.toContain("Дата:");
    const all = (await harness.behavior.callAgentTool("meetings_transcript", { id })) as string;
    expect(all.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_CHARS + 300);
    expect(all).toContain("[End of transcript]");
  });

  it("status, search, summary, rename and stop tools", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded);
    const { harness, fake, service } = loaded;
    const overview = (await harness.behavior.callAgentTool("meetings_status", {})) as string;
    expect(overview).toContain("Active: none");
    expect(overview).toContain(`${id} | done`);
    expect((await harness.behavior.callAgentTool("meetings_status", { id })) as string).toContain("Speakers:     Анна [ui:Анна]");
    const hits = (await harness.behavior.callAgentTool("meetings_search", { query: "сроки" })) as string;
    expect(hits.split("\n")).toHaveLength(3);
    expect((await harness.behavior.callAgentTool("meetings_save_summary", { id, markdown: "# Итоги" })) as string).toContain("Summary saved");
    expect(service.requireMeeting(id).summaryMd).toBe("# Итоги");
    const renamed = (await harness.behavior.callAgentTool("meetings_rename_speaker", { id, speaker: "Спикер 2", name: "Борис" })) as string;
    expect(renamed).toContain("Борис [spk:2]");

    const live = await harness.behavior.runCli(["join", ZOOM_URL, "--json"]);
    const liveId = (JSON.parse(live.stdout) as { meeting: { id: string } }).meeting.id;
    fake.setBot(liveId, { phase: "in_meeting" });
    fake.get(liveId).transcriber = transcriberState();
    await service.tick();
    const stopped = (await harness.behavior.callAgentTool("meetings_stop", { id: liveId })) as string;
    expect(stopped).toContain(`Бот выходит из встречи ${liveId}`);
    const missing = await harness.behavior.callAgentTool("meetings_status", { id: "mtg_nonexistent00" });
    expect(missing).toMatchObject({ isError: true });
  });
});

describe("HTTP routes", () => {
  async function withAudio(size: number) {
    const loaded = await load();
    const id = await doneMeeting(loaded);
    const audio = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) audio[i] = i % 251;
    loaded.fake.get(id).audio = audio;
    return { ...loaded, id, audio };
  }

  it("serves audio with Range support", async () => {
    const { harness, id, audio } = await withAudio(10_000);
    const full = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/ogg");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("10000");
    expect(Buffer.from(await full.arrayBuffer()).equals(audio)).toBe(true);

    const part = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/10000");
    expect(part.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await part.arrayBuffer()).equals(audio.subarray(100, 200))).toBe(true);

    const suffix = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`, { headers: { range: "bytes=-500" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 9500-9999/10000");
    expect((await suffix.arrayBuffer()).byteLength).toBe(500);

    const beyond = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`, { headers: { range: "bytes=20000-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10000");

    // The fake host's Hono turns HEAD into GET before routing, so call the HEAD handler directly.
    const route = harness.inspection.registrations.httpRoutes.find((r) => r.method === "HEAD" && r.path === "/audio")!;
    const app = new Hono();
    app.get("/audio", (c) => route.handler(c));
    const head = await app.request(`/audio?id=${id}`);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10000");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("caps open-ended ranges at 4 MiB and reads the host in 4 MiB chunks", async () => {
    const size = 9 * 1024 * 1024 + 123;
    const { harness, id, audio } = await withAudio(size);
    const first = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`, { headers: { range: "bytes=0-" } });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-${4 * 1024 * 1024 - 1}/${size}`);
    expect((await first.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024);

    const reads = () => hostCalls(harness, "meeting.readFile").map((c) => (c.input as { length: number }).length);
    const before = reads().length;
    const full = await harness.behavior.fetchHttp("GET", `/download?id=${id}&format=audio`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-disposition")).toMatch(/^attachment; filename="[^"]+\.ogg"; filename\*=UTF-8''/);
    const body = Buffer.from(await full.arrayBuffer());
    expect(body.length).toBe(size);
    expect(body.equals(audio)).toBe(true);
    expect(reads().slice(before).every((length) => length <= 4 * 1024 * 1024)).toBe(true);
  });

  it("serves screenshots without caching and 404s when missing", async () => {
    const loaded = await load();
    const id = await doneMeeting(loaded);
    const { harness, fake } = loaded;
    expect((await harness.behavior.fetchHttp("GET", `/screenshot?id=${id}&v=1`)).status).toBe(404);
    fake.get(id).screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const shot = await harness.behavior.fetchHttp("GET", `/screenshot?id=${id}&v=2`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect(shot.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await shot.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect((await harness.behavior.fetchHttp("GET", "/screenshot?id=../../etc")).status).toBe(400);
    expect((await harness.behavior.fetchHttp("GET", "/screenshot?id=mtg_unknown00000")).status).toBe(404);
  });

  it("downloads transcripts as attachments with UTF-8 file names", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded, 3, "Планёрка «Q4»");
    const { harness } = loaded;
    for (const [format, type] of [
      ["md", "text/markdown; charset=utf-8"],
      ["txt", "text/plain; charset=utf-8"],
      ["srt", "application/x-subrip; charset=utf-8"],
      ["vtt", "text/vtt; charset=utf-8"],
      ["json", "application/json; charset=utf-8"],
    ] as const) {
      const response = await harness.behavior.fetchHttp("GET", `/download?id=${id}&format=${format}`);
      expect(response.status, format).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      const disposition = response.headers.get("content-disposition")!;
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("Планёрка «Q4» 2026-10-13")}.${format}`);
      expect(disposition).toMatch(/filename="[\x20-\x7e]+"/);
      const body = await response.text();
      expect(body).toContain("Реплика номер 1");
      expect(body).not.toContain("AbCdEf123");
    }
    expect((await harness.behavior.fetchHttp("GET", `/download?id=${id}&format=pdf`)).status).toBe(400);
    expect((await harness.behavior.fetchHttp("GET", "/download?id=mtg_unknown00000&format=md")).status).toBe(404);
  });
});

describe("bb meetings api (external agents)", () => {
  const api = async (loaded: Loaded, request: unknown) => {
    const result = await loaded.harness.behavior.runCli(["api", "--request", JSON.stringify(request), "--json"]);
    return { ...result, body: result.exitCode === 0 ? (JSON.parse(result.stdout) as Record<string, any>) : null };
  };

  it("lists and shows meetings without passcodes, with ISO times", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded, 3, "Бюджет Q4");
    const listed = await api(loaded, { action: "list", query: "бюджет" });
    expect(listed.exitCode).toBe(0);
    expect(listed.body?.meetings).toHaveLength(1);
    expect(listed.body?.meetings[0]).toMatchObject({ id, title: "Бюджет Q4", status: "done", transcript: { final: true, segments: 3 } });
    expect(listed.stdout).not.toContain("AbCdEf123");
    expect(listed.body?.meetings[0].link).toContain("pwd=***");
    expect(listed.body?.meetings[0].createdAt).toMatch(/^2026-10-13T/);
    const none = await api(loaded, { action: "list", query: "нет такой" });
    expect(none.body?.meetings).toEqual([]);
    const shown = await api(loaded, { action: "show", id });
    expect(shown.body?.meeting.speakers.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(["Анна", "Спикер 2"]));
  });

  it("joins without a thread to notify and reports the outcome", async () => {
    const loaded = await load({ now: () => T0 });
    const joined = await api(loaded, { action: "join", url: uniqueZoomUrl(), title: "Синк", waitSeconds: 0 });
    expect(joined.exitCode).toBe(0);
    expect(joined.body?.meeting).toMatchObject({ title: "Синк", source: "agent" });
    expect(joined.body?.outcome.en).not.toContain("This thread gets a message");
    const scheduled = await api(loaded, { action: "join", url: uniqueZoomUrl(), startAt: "2026-10-13T20:00:00Z" });
    expect(scheduled.body?.meeting).toMatchObject({ status: "scheduled", scheduledAt: "2026-10-13T20:00:00.000Z" });
    const cancelled = await api(loaded, { action: "cancel", id: scheduled.body?.meeting.id });
    expect(cancelled.body?.meeting.status).toBe("cancelled");
  });

  it("pages transcripts and saves multi-line summaries sent as one JSON line", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded, 200);
    const first = await api(loaded, { action: "transcript", id, maxChars: 2000 });
    expect(first.body).toMatchObject({ final: true, totalSegments: 200, fromSegment: 0, done: false });
    expect(first.body?.nextFromSegment).toBeGreaterThan(0);
    const next = await api(loaded, { action: "transcript", id, fromSegment: first.body?.nextFromSegment, maxChars: 60000 });
    expect(next.body?.fromSegment).toBe(first.body?.nextFromSegment);
    expect(next.body?.done).toBe(true);
    const markdown = "## Резюме\n\n- Решение: перенести релиз\n- Задача: Анна, отчёт";
    const saved = await api(loaded, { action: "save_summary", id, markdown });
    expect(saved.body).toMatchObject({ saved: true });
    expect((await api(loaded, { action: "summary", id })).body?.summaryMd).toBe(markdown);
  });

  it("deletes only with confirm and the user's request", async () => {
    const loaded = await load({ now: () => T0 });
    const id = await doneMeeting(loaded);
    const refused = await api(loaded, { action: "delete", id });
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/confirm/);
    const deleted = await api(loaded, { action: "delete", id, confirm: true, userRequest: "удали встречу Планёрка" });
    expect(deleted.body).toMatchObject({ deleted: true, id });
    const gone = await api(loaded, { action: "show", id });
    expect(gone.exitCode).not.toBe(0);
  });

  it("explains bad requests", async () => {
    const loaded = await load({ now: () => T0 });
    const bad = await api(loaded, { action: "explode" });
    expect(bad.exitCode).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/Invalid request/);
    const notJson = await loaded.harness.behavior.runCli(["api", "--request", "{oops", "--json"]);
    expect(`${notJson.stdout}${notJson.stderr}`).toMatch(/one line of JSON/);
  });
});
