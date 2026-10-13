// End-to-end through the server: the plugin's server entry (fake plugin
// host) talks to the REAL host entry (host harness), which runs the real bot
// runner in Chrome/Xvfb against the mock meeting, and the real transcriber
// against the running GigaAM server. Slow (minutes) and needs an installed
// runtime, so it only runs with MEETINGS_E2E=1:
//
//   MEETINGS_E2E=1 npx vitest run test/server-e2e.test.ts
//
// The runtime is borrowed from .e2e/hostdata (scripts/dev-host-setup.mts
// installs it) through symlinks; meeting directories go to .e2e/server-e2e.
// A small HTTP server stands in for the bb server: it serves the fixtures and
// forwards /api/v1/plugins/meetings/http/* to the plugin's routes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { hostContract } from "../src/shared/contract.js";
import { load } from "./server-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHARED = path.join(ROOT, ".e2e", "hostdata");
const DATA = path.join(ROOT, ".e2e", "server-e2e", "hostdata");
const TEMP = path.join(ROOT, ".e2e", "server-e2e", "tmp");
const FIXTURES = path.join(ROOT, ".e2e", "fixtures");
/** Heavy, version-independent pieces are borrowed; runtime/<hash> is installed here by env.setup. */
const SHARED_PARTS = ["bin", "python", "cache", "venv", "models", "packages"];
const PLUGIN_HTTP = "/api/v1/plugins/meetings/http/";

type Loaded = Awaited<ReturnType<typeof load>>;

interface Detail {
  status: string;
  segmentsCount: number;
  transcriptStatus: string;
  speakers: Array<{ key: string; label: string }>;
  activeSpeakers: string[];
  errorMessage: string | null;
}

function prepareDataDir(): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(TEMP, { recursive: true });
  for (const part of SHARED_PARTS) {
    const link = path.join(DATA, part);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(SHARED, part), link);
  }
  const runtime = path.join(DATA, "runtime");
  if (fs.existsSync(runtime) && fs.lstatSync(runtime).isSymbolicLink()) fs.unlinkSync(runtime);
}

function gigaamUrl(): string {
  const status = JSON.parse(execFileSync("bb", ["gigaam", "status", "--json"], { encoding: "utf8" })) as { port: number | null };
  if (status.port === null) throw new Error("GigaAM is not running");
  return `http://127.0.0.1:${status.port}`;
}

/** Fixtures under /fixtures/, plugin routes under /api/v1/plugins/meetings/http/ (like the bb server). */
function startFrontServer(target: { loaded: Loaded | null }): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname.startsWith(PLUGIN_HTTP) && target.loaded !== null) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key] = value;
        const method = req.method ?? "GET";
        const response = await target.loaded.harness.behavior.fetchHttp(method, `/${url.pathname.slice(PLUGIN_HTTP.length)}${url.search}`, {
          headers,
          ...(chunks.length > 0 && method !== "GET" ? { body: Buffer.concat(chunks) } : {}),
        });
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (url.pathname.startsWith("/fixtures/")) {
        const file = path.join(FIXTURES, decodeURIComponent(url.pathname.slice("/fixtures/".length)));
        if (file.startsWith(FIXTURES) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "audio/wav" });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }
      res.writeHead(404).end("not found");
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

const enabled = process.env.MEETINGS_E2E === "1";

describe.runIf(enabled)("server + real host + mock meeting", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  const target: { loaded: Loaded | null } = { loaded: null };
  let base = "";

  beforeAll(async () => {
    prepareDataDir();
    const front = await startFrontServer(target);
    cleanup.push(() => new Promise<void>((resolve) => front.server.close(() => resolve())));
    base = `http://127.0.0.1:${front.port}`;
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: DATA, tempDir: TEMP } });
    cleanup.push(() => host.experimental_dispose());
    const loaded = await load({
      loopbackBaseUrl: base,
      settings: {
        botName: "Notetaker E2E",
        gigaamUrl: gigaamUrl(),
        aloneTimeoutMinutes: 1,
        waitingTimeoutMinutes: 2,
        screenshotIntervalSec: 2,
        maxDurationMinutes: 10,
      },
    });
    // Route the server's host calls into the real host entry.
    const call = host.experimental_call as (method: string, input: unknown) => Promise<unknown>;
    loaded.fake.handle = (method: string, input: unknown) => {
      if (!(method in hostContract)) throw new Error(`unknown host method ${method}`);
      return call(method, input);
    };
    target.loaded = loaded;
    // Install this plugin version's runtime files (everything heavy is already there).
    let report = await loaded.service.envReport(true);
    if (!report.ready) {
      console.log(`not ready: ${report.items.filter((i) => i.required && !i.ok).map((i) => i.id).join(", ")}; running env.setup`);
      await loaded.harness.behavior.callRpc("env.setup", { force: false });
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        report = await loaded.service.envReport(true);
        if (report.setup.phase !== "running") break;
      }
      console.log(`setup ${report.setup.phase}: ${report.setup.message}`);
    }
    const missing = report.items.filter((item) => item.required && !item.ok).map((item) => `${item.id}: ${item.detail}`);
    expect(missing, "run scripts/dev-host-setup.mts first").toEqual([]);
  }, 6 * 60_000);

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step();
  });

  it("joins through meetings_join, follows the meeting to done and notifies the thread", { timeout: 8 * 60_000 }, async () => {
    const { harness, service } = target.loaded!;
    const hasScript = fs.existsSync(path.join(FIXTURES, "mock-script.json"));
    const url = `${base}${PLUGIN_HTTP}mock-meeting/index.html${hasScript ? `?script=${encodeURIComponent(`${base}/fixtures/mock-script.json`)}` : ""}`;
    const joined = await harness.behavior.callAgentTool("meetings_join", { url, title: "E2E планёрка", waitSeconds: 90 }, { threadId: "thr_e2e" });
    expect(typeof joined, JSON.stringify(joined)).toBe("string");
    console.log(joined);
    const id = /mtg_[a-z0-9]+/.exec(joined as string)![0];
    cleanup.push(async () => {
      await service.call("meeting.delete", { meetingId: id }).catch(() => undefined);
    });
    expect(joined as string).toMatch(/записывает|recording/);

    // Let the real scheduler follow it.
    const run = harness.behavior.runService("scheduler");
    cleanup.push(async () => {
      run.controller.abort();
      await run.done;
    });
    let detail: Detail | null = null;
    const seen = new Set<string>();
    const speakersLive = new Set<string>();
    let liveSegments = 0;
    const deadline = Date.now() + 7 * 60_000;
    while (Date.now() < deadline) {
      detail = ((await harness.behavior.callRpc("meetings.get", { id })) as { meeting: Detail }).meeting;
      if (!seen.has(detail.status)) console.log(`${new Date().toISOString()} ${detail.status} segments=${detail.segmentsCount} transcript=${detail.transcriptStatus}`);
      seen.add(detail.status);
      if (detail.status === "recording") liveSegments = Math.max(liveSegments, detail.segmentsCount);
      for (const name of detail.activeSpeakers) speakersLive.add(name);
      if (detail.status === "done" || detail.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(detail?.status, detail?.errorMessage ?? "").toBe("done");
    expect(seen.has("recording")).toBe(true);
    console.log(`live segments while recording: ${liveSegments}; speaking seen live: ${[...speakersLive].join(", ")}`);
    expect(liveSegments).toBeGreaterThan(0);
    expect(speakersLive.size).toBeGreaterThan(0);
    expect(detail!.segmentsCount).toBeGreaterThan(3);

    const segments = (await harness.behavior.callRpc("meetings.segments", { id })) as { final: boolean; segments: Array<{ speaker: string; text: string }> };
    expect(segments.final).toBe(true);
    console.log(segments.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n"));
    if (hasScript) {
      expect(new Set(segments.segments.map((s) => s.speaker))).toEqual(new Set(["Олег Петров", "Анна Смирнова", "Дмитрий Волков"]));
      const hits = (await harness.behavior.callRpc("meetings.search", { query: "нагрузочным тестированием" })) as { hits: Array<{ meetingId: string; speaker: string }> };
      expect(hits.hits.find((hit) => hit.meetingId === id)?.speaker).toBe("Дмитрий Волков");
    }

    const sends = harness.inspection.sdk.callsTo("threads.send") as Array<[{ threadId: string; mode: string; input: Array<{ text: string }> }]>;
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toMatchObject({ threadId: "thr_e2e", mode: "queue-if-active" });
    console.log(sends[0]![0].input[0]!.text);

    // Real audio through the Range route and a transcript download.
    const audio = await harness.behavior.fetchHttp("GET", `/audio?id=${id}`, { headers: { range: "bytes=0-" } });
    expect([200, 206]).toContain(audio.status);
    expect(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("OggS");
    const md = await harness.behavior.fetchHttp("GET", `/download?id=${id}&format=md`);
    expect(await md.text()).toContain("# E2E планёрка");
    const page = (await harness.behavior.callAgentTool("meetings_transcript", { id })) as string;
    expect(page).toContain("[End of transcript]");
  });

  it("passes `bb meetings selftest` against the mock page served by the plugin", { timeout: 6 * 60_000 }, async () => {
    const { harness } = target.loaded!;
    const result = await harness.behavior.runCli(["selftest", "--json", "--timeout", "4m"]);
    console.log(result.stdout, result.stderr);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; problems: string[]; speakers: string[]; kept: boolean };
    expect(parsed.problems).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.speakers.length).toBeGreaterThan(0);
    expect(parsed.kept).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
