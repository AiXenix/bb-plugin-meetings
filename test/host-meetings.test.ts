// Host entry against a fake runtime: spawn, liveness, stop + escalation,
// crash detection, transcriber management, import, delete. Runs through the
// SDK harness, so every input and output is validated against hostContract.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { AUTO_STOP_ESCALATION_MS } from "../src/host/meetings.js";
import { readProc } from "../src/host/processes.js";
import type { HostPaths } from "../src/host/paths.js";
import {
  botConfig,
  cleanupTempDirs,
  fakeHostData,
  newMeetingId,
  processAlive,
  tempDir,
  waitFor,
} from "./host-helpers.js";


const harnesses: Array<{ experimental_dispose(): Promise<void> }> = [];
const strays: number[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.experimental_dispose()));
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await cleanupTempDirs();
});

async function setup(options: { runtime?: boolean } = {}) {
  const { dataDir, tempDir: workerTemp, paths } = await fakeHostData(options);
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir, tempDir: workerTemp },
  });
  harnesses.push(harness);
  const call = harness.experimental_call.bind(harness);
  return { harness, call, paths, dataDir };
}

function dirOf(paths: HostPaths, meetingId: string): string {
  return path.join(paths.meetings, meetingId);
}

async function readJsonFile(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function childPid(paths: HostPaths, meetingId: string): Promise<number> {
  const text = await waitFor(
    () => fs.readFile(path.join(dirOf(paths, meetingId), "child.pid"), "utf8").catch(() => ""),
    (value) => value !== "",
    10_000,
    "child.pid",
  );
  return Number(text);
}

describe("meeting.start / status / stop", () => {
  it("spawns a detached bot and the live transcriber, then stops on request", { timeout: 30_000 }, async () => {
    const { call, paths, dataDir } = await setup();
    const id = newMeetingId();
    const started = await call("meeting.start", { config: botConfig(id) });
    expect(started.exists).toBe(true);
    expect(started.botAlive).toBe(true);
    expect(started.bot?.pid).toBeGreaterThan(0);

    const dir = dirOf(paths, id);
    const pids = await readJsonFile(path.join(dir, "pids.json"));
    const botPid = pids.bot.pid as number;
    // Own session/process group, cwd = meeting dir.
    const proc = await readProc(botPid);
    expect(proc?.pgid).toBe(botPid);
    expect(proc?.cwd).toBe(dir);
    expect(proc?.argv).toEqual([process.execPath, paths.botScript, "--meeting-dir", dir]);
    expect(await readJsonFile(path.join(dir, "config.json"))).toMatchObject({ meetingId: id, botName: "normal" });

    const live = await waitFor(
      () => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!),
      (snap) => snap.bot?.phase === "in_meeting" && snap.transcriberAlive,
      10_000,
      "in_meeting + transcriber",
    );
    expect(live.roster).toBeNull();
    const runs = await waitFor(
      async () =>
        (await fs.readFile(path.join(dir, "transcriber-runs.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      (list) => list.length > 0,
      10_000,
      "transcriber run record",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ isolated: 1, hostData: dataDir, cwd: dir });
    expect(runs[0].argv).toEqual([
      "--meeting-dir", dir, "--mode", "live", "--models-dir", paths.models, "--host-data", paths.root,
      "--threads", "2", "--gigaam-url", "http://127.0.0.1:1",
    ]);
    expect(await fs.readFile(path.join(dir, "bot.log"), "utf8")).toContain(`hostData ${dataDir}`);

    await expect(call("meeting.start", { config: botConfig(id) })).rejects.toThrow(/уже запущен/);

    const child = await childPid(paths, id);
    const stopping = await call("meeting.stop", { meetingId: id });
    expect(stopping.exists).toBe(true);
    const request = await readJsonFile(path.join(dir, "stop.request"));
    expect(Date.now() - request.requestedAt).toBeLessThan(5_000);

    const ended = await waitFor(
      () => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!),
      (snap) => !snap.botAlive,
      10_000,
      "bot exit",
    );
    expect(ended.bot).toMatchObject({ phase: "ended", endReason: "stopped" });
    // An exiting process loses its command line a moment before it is a zombie; the bot SIGKILLs
    // its child just before exiting. Under load either can trail the status by a few ms.
    await waitFor(async () => processAlive(botPid), (alive) => !alive, 2_000, "bot gone");
    await waitFor(async () => processAlive(child), (alive) => !alive, 2_000, "bot child gone");
    // The live transcriber is left to finish the audio.
    expect(ended.transcriberAlive).toBe(true);
  });

  it("escalates a stop that the bot ignores for 45 s, sparing the transcriber", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    await call("meeting.start", { config: botConfig(id, { botName: "stubborn" }) });
    const dir = dirOf(paths, id);
    const child = await childPid(paths, id);
    await waitFor(() => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!), (s) => s.transcriberAlive);

    const first = await call("meeting.stop", { meetingId: id });
    expect(first.botAlive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await call("meeting.stop", { meetingId: id });
    expect(second.botAlive).toBe(true); // still inside the grace period

    await fs.writeFile(path.join(dir, "stop.request"), JSON.stringify({ requestedAt: Date.now() - 46_000 }));
    const forced = await call("meeting.stop", { meetingId: id });
    expect(forced.botAlive).toBe(false);
    expect(forced.bot).toMatchObject({ phase: "ended", endReason: "stopped", error: null });
    expect(processAlive(child)).toBe(false);
    expect(forced.transcriberAlive).toBe(true);
  });

  it("escalates an overdue stop request on a status poll, without a second stop", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    await call("meeting.start", { config: botConfig(id, { botName: "stubborn" }) });
    const dir = dirOf(paths, id);
    const child = await childPid(paths, id);
    await waitFor(() => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!), (s) => s.transcriberAlive);
    expect((await call("meeting.stop", { meetingId: id })).botAlive).toBe(true);

    // Not yet overdue: polls leave it alone.
    await fs.writeFile(path.join(dir, "stop.request"), JSON.stringify({ requestedAt: Date.now() - AUTO_STOP_ESCALATION_MS + 10_000 }));
    expect((await call("meeting.status", { meetingIds: [id] })).snapshots[0]!.botAlive).toBe(true);

    await fs.writeFile(path.join(dir, "stop.request"), JSON.stringify({ requestedAt: Date.now() - AUTO_STOP_ESCALATION_MS - 1_000 }));
    const polled = (await call("meeting.status", { meetingIds: [id] })).snapshots[0]!;
    expect(polled.botAlive).toBe(false);
    expect(polled.bot).toMatchObject({ phase: "ended", endReason: "stopped", error: null });
    expect(processAlive(child)).toBe(false);
    expect(polled.transcriberAlive).toBe(true);
  });

  it("returns the other meetings' snapshots when one cannot be updated", { timeout: 20_000 }, async () => {
    const { call, paths } = await setup();
    const good = newMeetingId();
    const bad = newMeetingId();
    for (const id of [good, bad]) await fs.mkdir(dirOf(paths, id), { recursive: true });
    const now = Date.now();
    // A dead bot whose state still says "recording", in a dir the host cannot write (a full disk behaves alike).
    await fs.writeFile(
      path.join(dirOf(paths, bad), "state.json"),
      JSON.stringify({
        version: 1, meetingId: bad, pid: 999_999_999, phase: "in_meeting", detail: "", startedAt: now, joinedAt: now,
        recordingStartedAt: now, endedAt: null, endReason: null, error: null,
        participants: { count: 1, names: [] }, activeSpeakers: [], audio: { seconds: 1, bytes: 32000 }, updatedAt: now,
      }),
    );
    await fs.chmod(dirOf(paths, bad), 0o555);
    try {
      const { snapshots } = await call("meeting.status", { meetingIds: [good, bad] });
      expect(snapshots.map((snap) => snap.meetingId)).toEqual([good, bad]);
      expect(snapshots[0]).toMatchObject({ exists: true, botAlive: false });
      // Reported as crashed even though the rewrite could not be saved.
      expect(snapshots[1]!.bot).toMatchObject({ phase: "failed", error: { code: "browser_crashed" } });
    } finally {
      await fs.chmod(dirOf(paths, bad), 0o755);
    }
  });

  it("marks a crashed bot as failed/browser_crashed and kills what it left behind", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    await call("meeting.start", { config: botConfig(id, { botName: "crash" }) });
    const child = await childPid(paths, id);
    const dir = dirOf(paths, id);
    const botPid = (await readJsonFile(path.join(dir, "pids.json"))).bot.pid as number;
    await waitFor(async () => processAlive(botPid), (alive) => !alive, 10_000, "bot crash");
    expect(processAlive(child)).toBe(true); // orphaned "Chrome"

    const { snapshots } = await call("meeting.status", { meetingIds: [id] });
    const snap = snapshots[0]!;
    expect(snap.botAlive).toBe(false);
    expect(snap.bot?.phase).toBe("failed");
    expect(snap.bot?.error?.code).toBe("browser_crashed");
    expect(snap.bot?.error?.message).toContain("FATAL: simulated crash");
    expect(snap.bot?.endedAt).not.toBeNull();
    await waitFor(async () => processAlive(child), (alive) => !alive, 5_000, "orphan cleanup");
    expect(snap.transcriberAlive).toBe(true);
    // The rewrite is persisted and the bot's throwaway profile is gone.
    expect((await readJsonFile(path.join(dir, "state.json"))).phase).toBe("failed");
    await expect(fs.stat(path.join(dir, "chrome-profile"))).rejects.toThrow();
  });

  it("does not trust a recorded pid that now belongs to another process", { timeout: 20_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const dir = dirOf(paths, id);
    await fs.mkdir(dir, { recursive: true });
    // An unrelated live process, as if the bot's pid had been reused.
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    strays.push(other.pid!);
    const now = Date.now();
    await fs.writeFile(path.join(dir, "pids.json"), JSON.stringify({ bot: { pid: other.pid, startedAt: now } }));
    await fs.writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        version: 1, meetingId: id, pid: other.pid, phase: "in_meeting", detail: "", startedAt: now, joinedAt: now,
        recordingStartedAt: now, endedAt: null, endReason: null, error: null,
        participants: { count: 1, names: [] }, activeSpeakers: ["Анна"], audio: { seconds: 1, bytes: 32000 }, updatedAt: now,
      }),
    );
    const { snapshots } = await call("meeting.status", { meetingIds: [id] });
    expect(snapshots[0]!.botAlive).toBe(false);
    expect(snapshots[0]!.bot?.phase).toBe("failed");
    expect(processAlive(other.pid!)).toBe(true);
  });

  it("reports unknown meetings as absent and refuses to start without the runtime", async () => {
    const { call } = await setup({ runtime: false });
    const id = newMeetingId();
    const { snapshots } = await call("meeting.status", { meetingIds: [id] });
    expect(snapshots[0]).toMatchObject({ meetingId: id, exists: false, bot: null, botAlive: false });
    await expect(call("meeting.start", { config: botConfig(id) })).rejects.toThrow(/Компоненты для записи не установлены/);
    expect(await call("meeting.stop", { meetingId: id })).toMatchObject({ exists: false });
    expect(await call("runtime.list", {})).toEqual({ meetingIds: [] });
  });

  it("needs playwright-core for the bot only; the transcriber starts without it", { timeout: 20_000 }, async () => {
    const { call, paths } = await setup();
    await fs.rm(path.join(paths.runtime, "node_modules"), { recursive: true });
    await expect(call("meeting.start", { config: botConfig(newMeetingId()) })).rejects.toThrow(/playwright-core/);
    const id = newMeetingId();
    const dir = dirOf(paths, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(botConfig(id)));
    const snap = await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber: botConfig(id).transcriber });
    expect(snap.transcriberAlive).toBe(true);
  });

  it("refuses a second Zoom sign-in session and protects the profile while one runs", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const login = newMeetingId();
    const profile = paths.zoomProfile;
    await call("meeting.start", {
      config: botConfig(login, { mode: "login", liveTranscription: false, zoomProfileDir: profile }),
    });
    await fs.mkdir(profile, { recursive: true });
    await expect(
      call("meeting.start", { config: botConfig(newMeetingId(), { mode: "login", liveTranscription: false, zoomProfileDir: profile }) }),
    ).rejects.toThrow(/Уже идёт вход в Zoom/);
    await expect(call("zoom.profile", { action: "delete" })).rejects.toThrow(/сеансом входа/);
    const snap = (await call("meeting.status", { meetingIds: [login] })).snapshots[0]!;
    expect(snap.transcriberAlive).toBe(false); // no transcriber for login sessions
    await call("meeting.delete", { meetingId: login });
    expect(await call("zoom.profile", { action: "delete" })).toMatchObject({ exists: false, signedIn: false });
  });
});

describe("meeting.ensureTranscriber", () => {
  it("is a no-op while alive, restarts offline from scratch, and leaves a final transcript alone", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const transcriber = botConfig(id).transcriber;
    await call("meeting.start", { config: botConfig(id) });
    const dir = dirOf(paths, id);
    await waitFor(() => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!), (s) => s.transcriberAlive);

    const runs = async () =>
      (await fs.readFile(path.join(dir, "transcriber-runs.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    await waitFor(runs, (list) => list.length === 1, 10_000, "transcriber run record");
    await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    expect(await runs()).toHaveLength(1);

    // Offline while the bot records: refused.
    await expect(call("meeting.ensureTranscriber", { meetingId: id, mode: "offline", transcriber })).rejects.toThrow(/записывает/);
    await call("meeting.stop", { meetingId: id });
    await waitFor(() => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!), (s) => !s.botAlive);
    // Offline without audio: refused.
    await expect(call("meeting.ensureTranscriber", { meetingId: id, mode: "offline", transcriber })).rejects.toThrow(/нет аудиозаписи/);

    await fs.writeFile(path.join(dir, "audio.ogg"), Buffer.alloc(1000, 1));
    await fs.writeFile(path.join(dir, "segments.jsonl"), '{"id":0,"start":0,"end":1,"speakerKey":"unknown","speaker":"x","source":"none","text":"old"}\n');
    const livePid = (await runs())[0].pid as number;
    const offlineTranscriber = { ...transcriber, gigaamUrl: null, threads: 0 };
    const offline = await call("meeting.ensureTranscriber", { meetingId: id, mode: "offline", transcriber: offlineTranscriber });
    expect(processAlive(livePid)).toBe(false);
    expect(offline.files.segments).toBe(offline.files.transcriptFinal ? 1 : 0);
    const final = await waitFor(
      () => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!),
      (s) => s.files.transcriptFinal,
      10_000,
      "offline transcript",
    );
    expect(final.files.segments).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1].argv).toEqual(["--meeting-dir", dir, "--mode", "offline", "--models-dir", paths.models, "--host-data", paths.root, "--threads", "0"]);
    expect((await readJsonFile(path.join(dir, "config.json"))).transcriber).toEqual(offlineTranscriber);

    // Final: live ensure does nothing.
    await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    expect(await runs()).toHaveLength(2);
    const transcript = await call("meeting.transcript", { meetingId: id });
    expect(transcript.transcript?.segments[0]?.text).toBe("привет");
  });

  it("keeps the old transcript when a re-transcription cannot start", { timeout: 20_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const dir = dirOf(paths, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(botConfig(id)));
    await fs.writeFile(path.join(dir, "audio.ogg"), Buffer.alloc(500, 1));
    const outputs = ["transcript.json", "transcript.md", "transcript.txt", "segments.jsonl", "embeddings.jsonl", "transcriber.json"];
    for (const name of outputs) await fs.writeFile(path.join(dir, name), `old ${name}\n`);
    // E.g. while `setup --force` recreates the venv.
    await fs.rm(paths.venvPython);
    const transcriber = { ...botConfig(id).transcriber, threads: 0 };
    await expect(call("meeting.ensureTranscriber", { meetingId: id, mode: "offline", transcriber })).rejects.toThrow(/Python-окружение/);
    for (const name of outputs) expect(await fs.readFile(path.join(dir, name), "utf8")).toBe(`old ${name}\n`);
    expect((await readJsonFile(path.join(dir, "config.json"))).transcriber).toEqual(botConfig(id).transcriber);
  });

  it("respawns a dead live transcriber with a crash-loop backoff", { timeout: 20_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const transcriber = botConfig(id).transcriber;
    const dir = dirOf(paths, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(botConfig(id, { liveTranscription: false })));
    await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    const pids = await readJsonFile(path.join(dir, "pids.json"));
    expect(pids.transcriber).toMatchObject({ mode: "live", restarts: 0 });
    process.kill(pids.transcriber.pid, "SIGKILL");
    await waitFor(async () => processAlive(pids.transcriber.pid), (alive) => !alive);
    // Within the backoff window: not respawned.
    const snap = await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    expect(snap.transcriberAlive).toBe(false);
    // Pretend the last start was long ago.
    await fs.writeFile(path.join(dir, "pids.json"), JSON.stringify({ transcriber: { ...pids.transcriber, startedAt: Date.now() - 60_000 } }));
    const again = await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    expect(again.transcriberAlive).toBe(true);
    expect((await readJsonFile(path.join(dir, "pids.json"))).transcriber.restarts).toBe(1);
  });
  it("restarts a dead offline run offline even when asked for live", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const transcriber = botConfig(id).transcriber;
    const dir = dirOf(paths, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(botConfig(id)));
    await fs.writeFile(path.join(dir, "audio.ogg"), Buffer.alloc(500, 1));
    await fs.writeFile(path.join(dir, "fake-transcriber-slow"), "");
    await call("meeting.ensureTranscriber", { meetingId: id, mode: "offline", transcriber });
    const first = await readJsonFile(path.join(dir, "pids.json"));
    expect(first.transcriber).toMatchObject({ mode: "offline", restarts: 0 });
    const runs = () =>
      fs.readFile(path.join(dir, "transcriber-runs.jsonl"), "utf8").then(
        (text) => text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
        () => [],
      );
    await waitFor(runs, (list) => list.length === 1);
    process.kill(first.transcriber.pid, "SIGKILL");
    await waitFor(async () => processAlive(first.transcriber.pid), (alive) => !alive);
    await fs.writeFile(path.join(dir, "pids.json"), JSON.stringify({ transcriber: { ...first.transcriber, startedAt: Date.now() - 60_000 } }));
    const snap = await call("meeting.ensureTranscriber", { meetingId: id, mode: "live", transcriber });
    expect(snap.transcriberAlive).toBe(true);
    const second = await readJsonFile(path.join(dir, "pids.json"));
    expect(second.transcriber).toMatchObject({ mode: "offline", restarts: 1 });
    const both = await waitFor(runs, (list) => list.length === 2);
    expect(both[1].argv.slice(0, 4)).toEqual(["--meeting-dir", dir, "--mode", "offline"]);
  });
});

describe("meeting.import", () => {
  it("converts an audio file to Opus, writes a terminal state and transcribes offline", { timeout: 60_000 }, async () => {
    const { call, paths } = await setup();
    const sourceDir = await tempDir("meetings-import-");
    const wav = path.join(sourceDir, "call.wav");
    const made = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "16000", wav]);
    expect(made.status).toBe(0);

    const id = newMeetingId();
    await expect(call("meeting.import", { config: botConfig(id), sourcePath: "call.wav" })).rejects.toThrow(/абсолютный путь/);
    await expect(call("meeting.import", { config: botConfig(id), sourcePath: sourceDir })).rejects.toThrow(/не обычный файл/);
    await expect(call("meeting.import", { config: botConfig(id), sourcePath: `${wav}.missing` })).rejects.toThrow(/не найден/);

    const snap = await call("meeting.import", { config: botConfig(id, { platform: "mock" }), sourcePath: wav });
    expect(snap.exists).toBe(true);
    expect(snap.botAlive).toBe(false);
    expect(snap.bot).toMatchObject({ phase: "ended", endReason: "stopped", recordingStartedAt: null, pid: 0 });
    expect(snap.bot!.audio.seconds).toBeGreaterThan(2.9);
    expect(snap.bot!.audio.seconds).toBeLessThan(3.2);
    expect(snap.files.audioBytes).toBeGreaterThan(1000);

    const dir = dirOf(paths, id);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", path.join(dir, "audio.ogg")]);
    expect(JSON.parse(probe.stdout.toString()).streams[0]).toMatchObject({ codec_name: "opus", channels: 1, sample_rate: "48000" });
    expect((await readJsonFile(path.join(dir, "config.json"))).platform).toBe("mock");

    const done = await waitFor(
      () => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!),
      (s) => s.files.transcriptFinal,
      10_000,
      "import transcript",
    );
    expect(done.bot?.phase).toBe("ended"); // not rewritten as a crash
    await expect(call("meeting.import", { config: botConfig(id), sourcePath: wav })).rejects.toThrow(/уже существует/);
  });

  it("removes the meeting dir when the source has no audio", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const sourceDir = await tempDir("meetings-import-");
    const bogus = path.join(sourceDir, "notes.txt");
    await fs.writeFile(bogus, "not audio");
    const id = newMeetingId();
    await expect(call("meeting.import", { config: botConfig(id), sourcePath: bogus })).rejects.toThrow(/ffmpeg/);
    await expect(fs.stat(dirOf(paths, id))).rejects.toThrow();
  });
});

describe("meeting.import cancellation", () => {
  it("kills ffmpeg and removes the half-made meeting when the call is cancelled", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const bin = await tempDir("meetings-fake-bin-");
    const ffmpegPid = path.join(bin, "ffmpeg.pid");
    // A conversion that would take far longer than the caller waits.
    await fs.writeFile(path.join(bin, "ffmpeg"), `#!/bin/sh\necho $$ > '${ffmpegPid}'\nsleep 300\n`, { mode: 0o755 });
    await fs.writeFile(path.join(bin, "ffprobe"), "#!/bin/sh\necho 3.0\n", { mode: 0o755 });
    const source = path.join(bin, "call.mp4");
    await fs.writeFile(source, "not really a video");
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    try {
      const id = newMeetingId();
      const controller = new AbortController();
      const pending = call("meeting.import", { config: botConfig(id), sourcePath: source }, { signal: controller.signal });
      const pid = Number(await waitFor(() => fs.readFile(ffmpegPid, "utf8").catch(() => ""), (t) => t.trim() !== ""));
      strays.push(pid);
      const aborted = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow();
      // Well inside the daemon's 5 s cancel grace, after which it would SIGKILL the worker.
      expect(Date.now() - aborted).toBeLessThan(4_000);
      await waitFor(async () => processAlive(pid), (alive) => !alive, 5_000, "ffmpeg killed");
      await waitFor(() => fs.stat(dirOf(paths, id)).then(() => true, () => false), (exists) => !exists, 10_000, "meeting dir removed");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("meeting.delete / runtime.list", () => {
  it("kills the bot, its children and the transcriber, then removes the directory", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const keep = newMeetingId();
    await call("meeting.start", { config: botConfig(id, { botName: "stubborn" }) });
    await fs.mkdir(dirOf(paths, keep), { recursive: true });
    const child = await childPid(paths, id);
    const snap = await waitFor(() => call("meeting.status", { meetingIds: [id] }).then((r) => r.snapshots[0]!), (s) => s.transcriberAlive);
    const pids = await readJsonFile(path.join(dirOf(paths, id), "pids.json"));
    expect(snap.botAlive).toBe(true);

    expect((await call("runtime.list", {})).meetingIds.sort()).toEqual([id, keep].sort());
    expect(await call("meeting.delete", { meetingId: id })).toEqual({ deleted: true });
    for (const pid of [pids.bot.pid, pids.transcriber.pid, child]) expect(processAlive(pid)).toBe(false);
    await expect(fs.stat(dirOf(paths, id))).rejects.toThrow();
    expect(await call("meeting.delete", { meetingId: id })).toEqual({ deleted: false });
    expect((await call("runtime.list", {})).meetingIds).toEqual([keep]);
  });
});
