// Host entry: file reads (whitelist, symlinks, chunks), segments and the
// final transcript, logs, remote control (seq, ack, viewer), debug dumps and
// the Zoom profile — through the SDK harness with contract validation.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import type { HostPaths } from "../src/host/paths.js";
import { CACHE_LIMIT, cacheSizes, parseSegmentLines, readLiveSegments, readTranscript } from "../src/host/transcript-files.js";
import { zoomSignedIn } from "../src/host/zoom-profile.js";
import { botConfig, cleanupTempDirs, fakeHostData, newMeetingId, tempDir, waitFor } from "./host-helpers.js";

const harnesses: Array<{ experimental_dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.experimental_dispose()));
  await cleanupTempDirs();
});

async function setup() {
  const { dataDir, tempDir: workerTemp, paths } = await fakeHostData();
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: workerTemp } });
  harnesses.push(harness);
  return { call: harness.experimental_call.bind(harness), paths };
}

async function meetingWithDir(paths: HostPaths): Promise<{ id: string; dir: string }> {
  const id = newMeetingId();
  const dir = path.join(paths.meetings, id);
  await fs.mkdir(dir, { recursive: true });
  return { id, dir };
}

function segmentLine(id: number, text = `реплика ${id}`): string {
  return JSON.stringify({ id, start: id, end: id + 0.9, speakerKey: "ui:Анна", speaker: "Анна", source: "ui", text });
}

describe("meeting.readFile / meeting.filePath", () => {
  it("reads whitelisted files in chunks and refuses everything else", async () => {
    const { call, paths } = await setup();
    const { id, dir } = await meetingWithDir(paths);
    const bytes = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
    await fs.writeFile(path.join(dir, "audio.ogg"), bytes);

    const head = await call("meeting.readFile", { meetingId: id, file: "audio.ogg", offset: 0, length: 100 });
    expect(head.totalBytes).toBe(10_000);
    expect(Buffer.from(head.base64!, "base64")).toEqual(bytes.subarray(0, 100));
    expect(head.mtimeMs).toBeGreaterThan(0);
    const tail = await call("meeting.readFile", { meetingId: id, file: "audio.ogg", offset: 9_950, length: 4_000_000 });
    expect(Buffer.from(tail.base64!, "base64")).toEqual(bytes.subarray(9_950));
    const past = await call("meeting.readFile", { meetingId: id, file: "audio.ogg", offset: 20_000, length: 10 });
    expect(past).toMatchObject({ base64: "", totalBytes: 10_000 });

    expect(await call("meeting.readFile", { meetingId: id, file: "screen.jpg", offset: 0, length: 10 })).toEqual({
      base64: null,
      totalBytes: 0,
      mtimeMs: null,
    });
    expect(await call("meeting.readFile", { meetingId: newMeetingId(), file: "audio.ogg", offset: 0, length: 10 })).toMatchObject({
      base64: null,
    });

    // Not in READABLE_FILES / path traversal / bad ids: rejected by the contract before the handler runs.
    for (const file of ["config.json", "../config.json", "bot.log", "/etc/passwd"]) {
      await expect(call("meeting.readFile", { meetingId: id, file: file as "audio.ogg", offset: 0, length: 10 })).rejects.toThrow();
    }
    await expect(call("meeting.readFile", { meetingId: "../../etc", file: "audio.ogg", offset: 0, length: 10 })).rejects.toThrow();
    await expect(call("meeting.readFile", { meetingId: id, file: "audio.ogg", offset: 0, length: 5 * 1024 * 1024 })).rejects.toThrow();

    // A symlink planted in the meeting dir is not followed.
    const secret = path.join(await tempDir("meetings-secret-"), "secret.txt");
    await fs.writeFile(secret, "top secret");
    await fs.symlink(secret, path.join(dir, "transcript.txt"));
    await expect(call("meeting.readFile", { meetingId: id, file: "transcript.txt", offset: 0, length: 100 })).rejects.toThrow(/символическая ссылка/);
    expect(await call("meeting.filePath", { meetingId: id, file: "transcript.txt" })).toEqual({ path: null });

    // A meeting dir that is itself a symlink is treated as absent.
    const outside = await tempDir("meetings-outside-");
    await fs.writeFile(path.join(outside, "audio.ogg"), "x");
    const linked = newMeetingId();
    await fs.symlink(outside, path.join(paths.meetings, linked));
    expect(await call("meeting.readFile", { meetingId: linked, file: "audio.ogg", offset: 0, length: 10 })).toMatchObject({ base64: null });

    expect(await call("meeting.filePath", { meetingId: id, file: "dir" })).toEqual({ path: dir });
    expect(await call("meeting.filePath", { meetingId: id, file: "audio.ogg" })).toEqual({ path: path.join(dir, "audio.ogg") });
    expect(await call("meeting.filePath", { meetingId: id, file: "bot.log" })).toEqual({ path: null });
    expect(await call("meeting.filePath", { meetingId: newMeetingId(), file: "dir" })).toEqual({ path: null });
  });
});

describe("meeting.segments / meeting.transcript", () => {
  it("pages live segments, tolerates a partial last line, then switches to the final transcript", async () => {
    const { call, paths } = await setup();
    const { id, dir } = await meetingWithDir(paths);
    const file = path.join(dir, "segments.jsonl");
    expect(await call("meeting.segments", { meetingId: id, afterId: -1, limit: 10 })).toEqual({
      final: false,
      segments: [],
      lastId: -1,
      total: 0,
    });

    const partial = segmentLine(3);
    await fs.writeFile(file, `${segmentLine(0)}\n${segmentLine(1)}\nnot json\n${segmentLine(2)}\n${partial.slice(0, 20)}`);
    const first = await call("meeting.segments", { meetingId: id, afterId: -1, limit: 10 });
    expect(first).toMatchObject({ final: false, lastId: 2, total: 3 });
    expect(first.segments.map((s) => s.id)).toEqual([0, 1, 2]);
    expect((await call("meeting.status", { meetingIds: [id] })).snapshots[0]!.files.segments).toBe(3);

    await fs.appendFile(file, `${partial.slice(20)}\n${segmentLine(4)}\n`);
    const page = await call("meeting.segments", { meetingId: id, afterId: 1, limit: 2 });
    expect(page.segments.map((s) => s.id)).toEqual([2, 3]);
    expect(page).toMatchObject({ lastId: 3, total: 5 });
    expect((await call("meeting.segments", { meetingId: id, afterId: 4, limit: 10 })).segments).toEqual([]);
    expect(await call("meeting.transcript", { meetingId: id })).toEqual({ transcript: null });

    const transcript = {
      version: 1,
      meetingId: id,
      audioSec: 10,
      createdAt: Date.now(),
      asr: { engine: "gigaam", model: "v3_e2e_rnnt" },
      diarization: "ui+acoustic",
      speakers: [{ key: "ui:Анна", label: "Анна", source: "ui", talkSec: 2, segments: 2 }],
      segments: [JSON.parse(segmentLine(1, "второй")), JSON.parse(segmentLine(0, "первый"))],
    };
    await fs.writeFile(path.join(dir, "transcript.json"), JSON.stringify(transcript));
    const final = await call("meeting.segments", { meetingId: id, afterId: -1, limit: 10 });
    expect(final).toMatchObject({ final: true, lastId: 1, total: 2 });
    expect(final.segments.map((s) => s.text)).toEqual(["первый", "второй"]);
    expect((await call("meeting.transcript", { meetingId: id })).transcript?.speakers[0]?.label).toBe("Анна");
    const snap = (await call("meeting.status", { meetingIds: [id] })).snapshots[0]!;
    expect(snap.files).toMatchObject({ transcriptFinal: true, segments: 2 });
  });

  it("re-reads segments.jsonl after the transcriber rewrites it", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "segments.jsonl");
    await fs.writeFile(file, `${segmentLine(0)}\n${segmentLine(1)}\n${segmentLine(2)}\n`);
    expect((await readLiveSegments(file)).map((s) => s.id)).toEqual([0, 1, 2]);
    // Resume after a crash: lines with id >= nextId dropped (new file via rename).
    await fs.writeFile(`${file}.tmp`, `${segmentLine(0)}\n`);
    await fs.rename(`${file}.tmp`, file);
    expect((await readLiveSegments(file)).map((s) => s.id)).toEqual([0]);
    // Truncated in place to a shorter file.
    await fs.writeFile(file, `${segmentLine(5)}\n`);
    expect((await readLiveSegments(file)).map((s) => s.id)).toEqual([5]);
    // A repeated id replaces the earlier line.
    await fs.appendFile(file, `${segmentLine(5, "исправлено")}\n${segmentLine(4)}\n`);
    expect((await readLiveSegments(file)).map((s) => [s.id, s.text])).toEqual([[4, "реплика 4"], [5, "исправлено"]]);
    expect(parseSegmentLines('{"id":-1}\n\n{"id":1,"start":0,"end":1,"speakerKey":"x","speaker":"","source":"ui","text":""}')).toHaveLength(1);
    await fs.rm(file);
    expect(await readLiveSegments(file)).toEqual([]);
  });

  it("keeps parse caches bounded across many meetings", async () => {
    const dir = await tempDir();
    for (let index = 0; index < CACHE_LIMIT + 8; index += 1) {
      const meeting = path.join(dir, `m${index}`);
      await fs.mkdir(meeting);
      await fs.writeFile(path.join(meeting, "segments.jsonl"), `${segmentLine(0)}\n`);
      await fs.writeFile(path.join(meeting, "transcript.json"), "{}");
      expect(await readLiveSegments(path.join(meeting, "segments.jsonl"))).toHaveLength(1);
      expect(await readTranscript(path.join(meeting, "transcript.json"))).toBeNull();
    }
    expect(cacheSizes().live).toBeLessThanOrEqual(CACHE_LIMIT);
    expect(cacheSizes().transcripts).toBeLessThanOrEqual(CACHE_LIMIT);
    // An evicted file is simply parsed again.
    expect(await readLiveSegments(path.join(dir, "m0", "segments.jsonl"))).toHaveLength(1);
  });
});

describe("meeting.logs", () => {
  it("returns bounded tails of bot.log, transcriber.log and events.jsonl", async () => {
    const { call, paths } = await setup();
    const { id, dir } = await meetingWithDir(paths);
    expect((await call("meeting.logs", { meetingId: id, lines: 10 })).text).toBe("Логов пока нет.");
    await fs.writeFile(path.join(dir, "bot.log"), Array.from({ length: 5000 }, (_, i) => `bot line ${i}`).join("\n") + "\n");
    await fs.writeFile(path.join(dir, "transcriber.log"), `${"x".repeat(10_000)}\nlast transcriber line\n`);
    await fs.writeFile(path.join(dir, "events.jsonl"), '{"t":1,"level":"info","msg":"joined"}\n');
    const { text } = await call("meeting.logs", { meetingId: id, lines: 3 });
    expect(text).toContain("== bot.log (последние 3 строк)\nbot line 4997\nbot line 4998\nbot line 4999");
    expect(text).not.toContain("bot line 4996");
    expect(text).toContain("last transcriber line");
    expect(text).toMatch(/x{2000}…/);
    expect(text).not.toMatch(/x{2001}/);
    expect(text).toContain('"msg":"joined"');
    expect((await call("meeting.logs", { meetingId: newMeetingId(), lines: 5 })).text).toMatch(/не найден/);
    await expect(call("meeting.logs", { meetingId: id, lines: 5000 })).rejects.toThrow();
  });

  it("does not follow a log that is a symlink, nor block on a FIFO", async () => {
    const { call, paths } = await setup();
    const { id, dir } = await meetingWithDir(paths);
    const secret = path.join(await tempDir(), "id_rsa");
    await fs.writeFile(secret, "PRIVATE KEY\n");
    await fs.symlink(secret, path.join(dir, "bot.log"));
    const fifo = spawnSync("mkfifo", [path.join(dir, "transcriber.log")]);
    expect(fifo.status).toBe(0);
    await fs.writeFile(path.join(dir, "events.jsonl"), '{"msg":"real"}\n');
    const { text } = await call("meeting.logs", { meetingId: id, lines: 10 });
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("transcriber.log");
    expect(text).toContain('"msg":"real"');
  });
});

describe("meeting.control / meeting.viewer / meeting.debugDump", () => {
  it("queues numbered commands only for a running bot and keeps the viewer alive", { timeout: 30_000 }, async () => {
    const { call, paths } = await setup();
    const id = newMeetingId();
    const dir = path.join(paths.meetings, id);
    await fs.mkdir(dir, { recursive: true });
    expect(await call("meeting.control", { meetingId: id, action: "click", x: 10, y: 20 })).toEqual({ queued: false, seq: 0 });
    expect(await call("meeting.debugDump", { meetingId: id })).toEqual({ requested: false });
    await expect(call("meeting.control", { meetingId: newMeetingId(), action: "done" })).rejects.toThrow(/не найдена/);

    await call("meeting.start", { config: botConfig(id, { liveTranscription: false }) });
    const first = await call("meeting.control", { meetingId: id, action: "click", x: 640, y: 360 });
    expect(first).toEqual({ queued: true, seq: 1 });
    const command = JSON.parse(await fs.readFile(path.join(dir, "control", "1.json"), "utf8"));
    expect(command).toMatchObject({ seq: 1, action: "click", x: 640, y: 360 });
    expect(Object.keys(command).sort()).toEqual(["action", "seq", "t", "x", "y"]);
    const viewer = JSON.parse(await fs.readFile(path.join(dir, "viewer.json"), "utf8"));
    expect(viewer.until).toBeGreaterThan(Date.now() + 25_000);

    expect(await call("meeting.control", { meetingId: id, action: "type", text: "Notetaker" })).toEqual({ queued: true, seq: 2 });
    // The bot acknowledged up to 7 and removed the files: numbering continues after the ack.
    await fs.rm(path.join(dir, "control", "1.json"));
    await fs.rm(path.join(dir, "control", "2.json"));
    await fs.writeFile(path.join(dir, "control", "ack.json"), JSON.stringify({ seq: 7, t: Date.now() }));
    expect(await call("meeting.control", { meetingId: id, action: "key", key: "Enter" })).toEqual({ queued: true, seq: 8 });

    // Concurrent commands never share a seq.
    const many = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call("meeting.control", { meetingId: id, action: "scroll", dy: i * 10 })),
    );
    expect(new Set(many.map((r) => r.seq)).size).toBe(8);
    expect(Math.min(...many.map((r) => r.seq))).toBe(9);

    await expect(call("meeting.control", { meetingId: id, action: "click", x: 1 })).rejects.toThrow(/x и y/);
    await expect(call("meeting.control", { meetingId: id, action: "key" })).rejects.toThrow(/key/);
    await expect(call("meeting.control", { meetingId: id, action: "click", x: -1, y: 1 })).rejects.toThrow();

    expect(await call("meeting.viewer", { meetingId: id, untilMs: Date.now() + 5_000 })).toEqual({ ok: true });
    const shortened = JSON.parse(await fs.readFile(path.join(dir, "viewer.json"), "utf8"));
    expect(shortened.until).toBeLessThan(Date.now() + 6_000);
    await call("meeting.viewer", { meetingId: id, untilMs: Date.now() + 24 * 3600_000 });
    expect(JSON.parse(await fs.readFile(path.join(dir, "viewer.json"), "utf8")).until).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(await call("meeting.viewer", { meetingId: newMeetingId(), untilMs: Date.now() })).toEqual({ ok: false });

    expect(await call("meeting.debugDump", { meetingId: id })).toEqual({ requested: true });
    await waitFor(() => fs.stat(path.join(dir, "debug", "dump.json")).then(() => true, () => false), Boolean, 5_000, "debug dump");
    await call("meeting.delete", { meetingId: id });
  });
});

describe("zoom.profile", () => {
  it("detects Zoom session cookies in the profile's cookie database", async () => {
    const { call, paths } = await setup();
    expect(await call("zoom.profile", { action: "status" })).toEqual({
      exists: false,
      signedIn: false,
      path: paths.zoomProfile,
      updatedAt: null,
    });
    const network = path.join(paths.zoomProfile, "Default", "Network");
    await fs.mkdir(network, { recursive: true });
    expect(await call("zoom.profile", { action: "status" })).toMatchObject({ exists: true, signedIn: false });

    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = path.join(network, "Cookies");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)");
    const chromeNow = (BigInt(Date.now()) * 1000n + 11_644_473_600_000_000n).toString();
    db.prepare("INSERT INTO cookies VALUES (?, ?, '', x'00', ?)").run(".zoom.us", "_zm_ssid", BigInt(chromeNow) - 1_000_000n);
    db.prepare("INSERT INTO cookies VALUES (?, ?, '', x'00', ?)").run(".example.com", "zm_aid", 0);
    db.close();
    // Only an expired zoom cookie and a foreign one: not signed in.
    expect(await zoomSignedIn(paths.zoomProfile)).toBe(false);

    const again = new DatabaseSync(dbFile);
    again.prepare("INSERT INTO cookies VALUES (?, ?, '', x'00', ?)").run("zoom.us", "zm_aid", BigInt(chromeNow) + 3_600_000_000n);
    again.close();
    const status = await call("zoom.profile", { action: "status" });
    expect(status).toMatchObject({ exists: true, signedIn: true, path: paths.zoomProfile });
    expect(status.updatedAt).toBeGreaterThan(0);

    expect(await call("zoom.profile", { action: "delete" })).toMatchObject({ exists: false, signedIn: false });
    await expect(fs.stat(paths.zoomProfile)).rejects.toThrow();
  });

  it("falls back to a byte search when the cookie store cannot be opened as SQLite", async () => {
    const profile = await tempDir("meetings-profile-");
    await fs.mkdir(path.join(profile, "Default"), { recursive: true });
    await fs.writeFile(path.join(profile, "Default", "Cookies"), Buffer.concat([Buffer.from("garbage\0\0"), Buffer.from(".zoom.us\0zm_haid")]));
    expect(await zoomSignedIn(profile)).toBe(true);
    await fs.writeFile(path.join(profile, "Default", "Cookies"), "garbage without session cookies");
    expect(await zoomSignedIn(profile)).toBe(false);
  });
});
