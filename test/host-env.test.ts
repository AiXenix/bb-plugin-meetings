// env.check on this machine with an empty data dir, and the setup machinery
// (coalescing, worker lease, runtime dir install, garbage collection) with
// injected steps instead of real downloads. The real install is exercised by
// scripts/dev-host-setup.mts.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import { checkEnv } from "../src/host/env.js";
import { checkModel } from "../src/host/models.js";
import { hostPaths, type HostPaths } from "../src/host/paths.js";
import { MODELS, PLAYWRIGHT_CORE, transcriberRequirements, venvSpec } from "../src/host/platform.js";
import { collectGarbage, ensureRuntimeDir, ensureVenv, runningSetup, startSetup, type SetupStep } from "../src/host/setup.js";
import { readSetupRecord } from "../src/host/setup-state.js";
import { envReportSchema } from "../src/shared/contract.js";
import { cleanupTempDirs, processAlive, tempDir, waitFor } from "./host-helpers.js";

const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await cleanupTempDirs();
});

async function fakePlaywright(paths: HostPaths): Promise<void> {
  await fs.mkdir(paths.playwrightPackage, { recursive: true });
  await fs.writeFile(path.join(paths.playwrightPackage, "package.json"), JSON.stringify({ name: "playwright-core", version: PLAYWRIGHT_CORE.version, type: "module", main: "index.mjs" }));
  await fs.writeFile(path.join(paths.playwrightPackage, "index.mjs"), "export const chromium = { launch() {} };\n");
  await fs.writeFile(path.join(paths.playwrightPackage, ".complete"), "x");
}

describe("env.check", () => {
  it("reports every component; user-level ones are missing in a fresh data dir", { timeout: 60_000 }, async () => {
    const dataDir = await tempDir();
    const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: await tempDir() } });
    const report = await harness.experimental_call("env.check", { chromePath: "", gigaamUrl: "http://127.0.0.1:9" });
    expect(envReportSchema.parse(report)).toBeTruthy();
    expect(report.items.map((item) => item.id)).toEqual([
      "chrome", "xvfb", "pulseaudio", "ffmpeg", "xdotool", "node", "runtime", "playwright", "uv", "venv",
      "sherpa-onnx", "vad-model", "speaker-model", "gigaam",
    ]);
    const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
    for (const id of ["runtime", "playwright", "uv", "venv", "sherpa-onnx", "vad-model", "speaker-model", "gigaam"]) {
      expect(byId[id]!.ok, id).toBe(false);
    }
    expect(byId.gigaam!.fix).toMatch(/gigaam/);
    expect(byId.node).toMatchObject({ ok: true, version: process.versions.node });
    expect(byId.xdotool!.required).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.setup).toMatchObject({ phase: "idle", startedAt: null, logTail: "" });
    expect(report.hostDataDir).toBe(dataDir);
    expect(report.gigaam).toMatchObject({ url: "http://127.0.0.1:9", ready: false });
    // This machine has Chrome, Xvfb, PulseAudio and ffmpeg with libopus.
    expect(byId.chrome).toMatchObject({ ok: true, fix: null });
    expect(report.chromePath).toBe(byId.chrome!.detail);
    expect(byId.ffmpeg!.ok).toBe(true);
    await harness.experimental_dispose();
  });

  it("flags a configured Chrome path that does not exist", async () => {
    const paths = hostPaths(await tempDir());
    const report = await checkEnv(paths, { chromePath: "/nonexistent/chrome", gigaamUrl: "http://127.0.0.1:9" });
    const chrome = report.items.find((item) => item.id === "chrome")!;
    expect(chrome).toMatchObject({ ok: false });
    expect(chrome.fix).toMatch(/chromePath/);
    expect(report.chromePath).toBeNull();
  });

  it("verifies model size and checksum, caching a verified hash", async () => {
    const paths = hostPaths(await tempDir());
    const spec = { ...MODELS[0]!, file: "tiny.onnx", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" };
    expect((await checkModel(paths, spec)).ok).toBe(false);
    await fs.mkdir(paths.models, { recursive: true });
    await fs.writeFile(path.join(paths.models, "tiny.onnx"), "hellx");
    expect(await checkModel(paths, spec)).toMatchObject({ ok: false, detail: expect.stringContaining("контрольная сумма") });
    await fs.writeFile(path.join(paths.models, "tiny.onnx"), "hello");
    expect((await checkModel(paths, spec)).ok).toBe(true);
    const verified = JSON.parse(await fs.readFile(path.join(paths.models, ".verified.json"), "utf8"));
    expect(verified["tiny.onnx"].sha256).toBe(spec.sha256);
    await fs.writeFile(path.join(paths.models, "tiny.onnx"), "hi");
    expect(await checkModel(paths, spec)).toMatchObject({ ok: false, detail: expect.stringContaining("размер") });
  });
});

describe("startSetup", () => {
  it("runs once per data dir, holds a worker lease while running and records the result", async () => {
    const paths = hostPaths(await tempDir());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    const steps: SetupStep[] = [
      async (_paths, options, context) => {
        ran.push(`one force=${options.force}`);
        await context.progress("Шаг один");
        await gate;
        return ["Заметка."];
      },
      async () => {
        ran.push("two");
        throw new Error("второй шаг сломался");
      },
      async () => {
        ran.push("three");
        return [];
      },
    ];
    let leases = 0;
    const retain = () => {
      leases += 1;
      return { dispose: async () => void (leases -= 1) };
    };
    expect(await startSetup(paths, { force: true, chromePath: "" }, retain, steps)).toEqual({ started: true });
    expect(await startSetup(paths, { force: false, chromePath: "" }, retain, steps)).toEqual({ started: false });
    await waitFor(() => readSetupRecord(paths), (record) => record.message === "Шаг один");
    expect(leases).toBe(1);
    expect((await readSetupRecord(paths)).phase).toBe("running");

    release();
    await runningSetup(paths);
    expect(ran).toEqual(["one force=true", "two", "three"]);
    expect(leases).toBe(0);
    const record = await readSetupRecord(paths);
    expect(record).toMatchObject({ phase: "failed", message: "Установлено не всё: второй шаг сломался" });
    expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt!);
    const log = await fs.readFile(paths.setupLog, "utf8");
    expect(log).toContain("-- Шаг один");
    expect(log).toContain("!! второй шаг сломался");

    // A new run may start once the previous one finished.
    expect(await startSetup(paths, { force: false, chromePath: "" }, null, [async () => ["Всё хорошо."]])).toEqual({ started: true });
    await runningSetup(paths);
    expect(await readSetupRecord(paths)).toMatchObject({ phase: "done", message: "Готово. Всё хорошо." });
  });

  it("reports a run whose worker disappeared as interrupted", async () => {
    const paths = hostPaths(await tempDir());
    await fs.writeFile(
      paths.setupState,
      JSON.stringify({ phase: "running", message: "Скачиваю uv", startedAt: 1, finishedAt: null, pid: 999_999, heartbeatAt: Date.now() - 120_000 }),
    );
    expect(await readSetupRecord(paths)).toMatchObject({ phase: "failed", message: "Установка была прервана: Скачиваю uv" });
    await fs.writeFile(
      paths.setupState,
      JSON.stringify({ phase: "running", message: "Скачиваю uv", startedAt: 1, finishedAt: null, pid: 999_999, heartbeatAt: Date.now() }),
    );
    expect((await readSetupRecord(paths)).phase).toBe("running");
  });

  it("returns the env report at once from env.setup and holds a lease until the run ends", { timeout: 60_000 }, async () => {
    const dataDir = await tempDir();
    const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: await tempDir() } });
    // Disposing right away aborts the run before it downloads anything substantial.
    const report = await harness.experimental_call("env.setup", { force: false, chromePath: "", gigaamUrl: "http://127.0.0.1:9" });
    expect(report.setup.phase).toBe("running");
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await harness.experimental_dispose(); // aborts the run
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    const record = await readSetupRecord(hostPaths(dataDir));
    expect(record).toMatchObject({ phase: "failed", message: "Установка прервана" });
  });
});

describe("ensureRuntimeDir / collectGarbage", () => {
  it("writes the runtime atomically with playwright-core linked, once", async () => {
    const paths = hostPaths(await tempDir(), "testhash");
    const files = { "bot/bot-runner.mjs": "import { chromium } from 'playwright-core'; console.log(typeof chromium.launch);\n", "transcriber/transcriber.py": "print(1)\n" };
    // playwright-core is not needed to write it (the transcriber runs without it): the link dangles until setup installs it.
    await Promise.all([ensureRuntimeDir(paths, { files }), ensureRuntimeDir(paths, { files })]);
    expect(await fs.readFile(path.join(paths.runtime, "bot", "bot-runner.mjs"), "utf8")).toBe(files["bot/bot-runner.mjs"]);
    expect(await fs.readFile(paths.transcriberScript, "utf8")).toBe(files["transcriber/transcriber.py"]);
    expect(JSON.parse(await fs.readFile(paths.runtimeReady, "utf8"))).toMatchObject({ hash: "testhash", files: 2 });
    expect(await fs.readlink(path.join(paths.runtime, "node_modules", "playwright-core"))).toBe("../../../packages/playwright-core-1.64.0");
    await expect(fs.stat(path.join(paths.runtime, "node_modules", "playwright-core", "package.json"))).rejects.toThrow();
    await fakePlaywright(paths);
    const run = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [paths.botScript], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.once("error", reject);
      child.once("close", () => resolve(out.trim()));
    });
    expect(run).toBe("function");
    expect((await fs.readdir(paths.runtimeRoot)).filter((name) => name.startsWith("."))).toEqual([]);

    // Not forced: an existing .ready dir is kept as is; forced: rewritten.
    await fs.writeFile(path.join(paths.runtime, "bot", "bot-runner.mjs"), "changed");
    await ensureRuntimeDir(paths, { files });
    expect(await fs.readFile(path.join(paths.runtime, "bot", "bot-runner.mjs"), "utf8")).toBe("changed");
    await ensureRuntimeDir(paths, { files, force: true });
    expect(await fs.readFile(path.join(paths.runtime, "bot", "bot-runner.mjs"), "utf8")).toBe(files["bot/bot-runner.mjs"]);
    await expect(ensureRuntimeDir(hostPaths(paths.root, "evil"), { files: { "../escape.js": "x" } })).rejects.toThrow(/Недопустимый путь/);
  });

  it("removes old runtime dirs unless a live process uses them", { timeout: 20_000 }, async () => {
    const paths = hostPaths(await tempDir(), "current");
    for (const name of ["current", "old1", "inuse"]) await fs.mkdir(path.join(paths.runtimeRoot, name, "bot"), { recursive: true });
    const stale = path.join(paths.runtimeRoot, ".staging-old");
    await fs.mkdir(stale);
    await fs.utimes(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const fresh = path.join(paths.runtimeRoot, ".staging-new");
    await fs.mkdir(fresh);
    // One process (sh -c would fork a sleep that outlives the kill in afterEach).
    const user = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", path.join(paths.runtimeRoot, "inuse", "bot", "bot-runner.mjs")], {
      stdio: "ignore",
    });
    strays.push(user.pid!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const removed = await collectGarbage(paths);
    expect(removed.sort()).toEqual([path.join(paths.runtimeRoot, "old1"), stale].sort());
    expect((await fs.readdir(paths.runtimeRoot)).sort()).toEqual([".staging-new", "current", "inuse"]);
  });

  it("does not upgrade the venv's packages in place while a transcriber runs from it", { timeout: 20_000 }, async () => {
    const paths = hostPaths(await tempDir());
    await fs.mkdir(path.dirname(paths.venvPython), { recursive: true });
    await fs.writeFile(paths.venvPython, `#!/bin/sh\necho '{"python": "3.12.9", "sherpa": "1.13.8", "numpy": "2.2.0"}'\n`, { mode: 0o755 });
    // Installed from older requirements (a plugin update changed them).
    await fs.writeFile(paths.venvMarker, JSON.stringify({ spec: "older" }));
    const uvCalls = path.join(paths.root, "uv-calls");
    const uv = path.join(paths.root, "fake-uv");
    await fs.writeFile(uv, `#!/bin/sh\necho "$@" >> '${uvCalls}'\n`, { mode: 0o755 });
    const log = createWriteStream(path.join(paths.root, "setup.log"));
    const context = { signal: new AbortController().signal, log, progress: async () => undefined };
    try {
      const transcriber = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", paths.venvPython], { stdio: "ignore" });
      strays.push(transcriber.pid!);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await ensureVenv(paths, uv, false, context)).join(" ")).toMatch(/не обновлены/);
      expect(await fs.readFile(uvCalls, "utf8").catch(() => "")).toBe("");

      process.kill(transcriber.pid!, "SIGKILL");
      await waitFor(async () => processAlive(transcriber.pid!), (alive) => !alive);
      expect(await ensureVenv(paths, uv, false, context)).toEqual([]);
      expect(await fs.readFile(uvCalls, "utf8")).toContain(`pip install --python ${paths.venvPython}`);
    } finally {
      await new Promise<void>((resolve) => log.end(resolve));
    }
  });

  it("derives the venv spec from the transcriber requirements", () => {
    expect(transcriberRequirements({})).toContain("sherpa-onnx==1.13.8");
    expect(transcriberRequirements({ "transcriber/requirements.txt": "numpy==1\n" })).toBe("numpy==1\n");
    expect(venvSpec("a")).not.toBe(venvSpec("b"));
  });
});
