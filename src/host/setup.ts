// env.setup: install what the bot and transcriber need, in the background.
// System packages (Xvfb, PulseAudio, ffmpeg, xdotool, Chrome) only with
// passwordless sudo; everything else is user-level under <hostData>: the
// embedded runtime files, playwright-core (verified npm tarball), uv (pinned,
// sha256-checked), a Python venv with sherpa-onnx, and the sherpa-onnx models.
// One run per data dir at a time; progress goes to setup.json + logs/setup.log.
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RUNTIME_FILES } from "../generated/runtime-files.js";
import { downloadFile } from "./download.js";
import { isExecutable, run, runChecked } from "./exec.js";
import { errorCode, errorMessage, isFile, readJson, removeTree, statOrNull, writeJsonAtomic } from "./fsutil.js";
import { checkModel } from "./models.js";
import type { HostPaths } from "./paths.js";
import {
  CHROME_DEB_URL,
  MODELS,
  PLAYWRIGHT_CORE,
  PYTHON_VERSION,
  UV_VERSION,
  platformProblem,
  transcriberRequirements,
  uvDownload,
  venvSpec,
  type ModelSpec,
} from "./platform.js";
import { pathInUse, probeSudo, probeSystem, probeVenv } from "./probes.js";
import { HEARTBEAT_MS, runningHere, writeSetupRecord, type SetupRecord } from "./setup-state.js";

export interface SetupOptions {
  /** Reinstall the user-level pieces even if they look fine. */
  readonly force: boolean;
  readonly chromePath: string;
}

export interface WorkerLease {
  dispose(): Promise<void>;
}

export interface StepContext {
  readonly signal: AbortSignal;
  readonly log: WriteStream;
  progress(message: string): Promise<void>;
}

/** A setup step; returns notes for the final message. */
export type SetupStep = (paths: HostPaths, options: SetupOptions, context: StepContext) => Promise<string[]>;

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const STALE_STAGING_MS = 10 * 60_000;
const APT_TIMEOUT_MS = 20 * 60_000;
const UV_TIMEOUT_MS = 20 * 60_000;

const active = new Map<string, { controller: AbortController; done: Promise<void> }>();

/**
 * Start a setup run unless one is already running for this data dir (the
 * call then joins it). Resolves once setup.json says "running".
 */
export async function startSetup(
  paths: HostPaths,
  options: SetupOptions,
  retain: (() => WorkerLease) | null,
  steps: readonly SetupStep[] = DEFAULT_STEPS,
): Promise<{ started: boolean }> {
  if (active.has(paths.root)) return { started: false };
  const controller = new AbortController();
  let release!: () => void;
  const entry = { controller, done: new Promise<void>((resolve) => (release = resolve)) };
  active.set(paths.root, entry);
  runningHere.add(paths.root);

  let record: SetupRecord = {
    phase: "running",
    message: "Начинаю установку",
    startedAt: Date.now(),
    finishedAt: null,
    pid: process.pid,
    heartbeatAt: Date.now(),
  };
  // Writes are chained so a slow write never lands after a newer one.
  let saving = Promise.resolve();
  const save = (): Promise<void> => {
    saving = saving.then(() => writeSetupRecord(paths, { ...record, heartbeatAt: Date.now() })).catch(() => undefined);
    return saving;
  };
  try {
    await fs.mkdir(paths.logs, { recursive: true });
    await save();
  } catch (error) {
    active.delete(paths.root);
    runningHere.delete(paths.root);
    release();
    throw error;
  }

  void (async () => {
    let lease: WorkerLease | null = null;
    try {
      lease = retain?.() ?? null;
    } catch {
      // Without a lease the worker may be evicted mid-install; the next env.check then reports it interrupted.
    }
    const heartbeat = setInterval(() => void save(), HEARTBEAT_MS);
    heartbeat.unref();
    let log: WriteStream | null = null;
    try {
      await rotate(paths.setupLog);
      const stream = createWriteStream(paths.setupLog, { flags: "a" });
      log = stream;
      stream.write(`\n=== setup ${new Date().toISOString()} force=${options.force} runtime=${paths.runtimeHash}\n`);
      const context: StepContext = {
        signal: controller.signal,
        log: stream,
        progress: async (message) => {
          record = { ...record, message };
          stream.write(`-- ${message}\n`);
          await save();
        },
      };
      const notes: string[] = [];
      const problems: string[] = [];
      const unsupported = platformProblem();
      if (unsupported !== null) throw new Error(unsupported);
      for (const step of steps) {
        controller.signal.throwIfAborted();
        try {
          notes.push(...(await step(paths, options, context)));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          problems.push(errorMessage(error));
          stream.write(`!! ${errorMessage(error)}\n`);
        }
      }
      record =
        problems.length > 0
          ? { ...record, phase: "failed", message: `Установлено не всё: ${problems.join("; ")}` }
          : { ...record, phase: "done", message: ["Готово.", ...notes].join(" ") };
    } catch (error) {
      record = {
        ...record,
        phase: "failed",
        message: controller.signal.aborted ? "Установка прервана" : errorMessage(error),
      };
    } finally {
      clearInterval(heartbeat);
      record = { ...record, finishedAt: Date.now() };
      if (log !== null) {
        const stream = log;
        stream.write(`=== ${record.phase}: ${record.message}\n`);
        await new Promise<void>((resolve) => stream.end(resolve));
      }
      await save();
      runningHere.delete(paths.root);
      active.delete(paths.root);
      await lease?.dispose().catch(() => undefined);
      release();
    }
  })();
  return { started: true };
}

/** The running setup for this data dir, if any (tests await it). */
export function runningSetup(paths: HostPaths): Promise<void> | null {
  return active.get(paths.root)?.done ?? null;
}

/** Abort every running setup and wait (bounded) for it to wind down. */
export async function cancelSetups(timeoutMs = 4_000): Promise<void> {
  const runs = [...active.values()];
  for (const entry of runs) entry.controller.abort();
  await Promise.race([
    Promise.all(runs.map((entry) => entry.done)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

// ── steps ────────────────────────────────────────────────────────────────

async function systemStep(paths: HostPaths, options: SetupOptions, context: StepContext): Promise<string[]> {
  const system = await probeSystem(options.chromePath);
  const missing = new Set<string>();
  if (system.xvfb.path === null) missing.add("xvfb");
  if (system.pulseaudio.path === null) missing.add("pulseaudio");
  if (system.pactl.path === null) missing.add("pulseaudio-utils");
  if (system.ffmpeg.path === null || system.ffprobe.path === null || !system.ffmpeg.libopus) missing.add("ffmpeg");
  if (system.xdotool.path === null) missing.add("xdotool");
  const needChrome = system.chrome.path === null && !system.chrome.configured;
  if (missing.size === 0 && !needChrome) return [];
  if (!(await probeSudo())) {
    return ["Системные пакеты не установлены: нет sudo без пароля — команды для ручной установки указаны в списке компонентов."];
  }
  if (missing.size > 0) {
    await context.progress(`Устанавливаю системные пакеты: ${[...missing].join(", ")}`);
    await aptInstall([...missing], context);
  }
  if (needChrome) {
    if (process.arch === "arm64") {
      await context.progress("Устанавливаю Chromium");
      await aptInstall(["chromium"], context);
    } else {
      await context.progress("Скачиваю и устанавливаю Google Chrome");
      const deb = path.join(paths.downloads, "google-chrome-stable_current_amd64.deb");
      await downloadFile(CHROME_DEB_URL, deb, { signal: context.signal, log: context.log });
      try {
        await aptInstall([deb], context);
      } finally {
        await fs.rm(deb, { force: true });
      }
    }
  }
  return [];
}

async function aptInstall(packages: readonly string[], context: StepContext): Promise<void> {
  const install = () =>
    run(
      "sudo",
      ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "-o", "DPkg::Lock::Timeout=180", ...packages],
      { timeoutMs: APT_TIMEOUT_MS, signal: context.signal, log: context.log },
    );
  let result = await install();
  if (result.code !== 0 && !result.timedOut) {
    // Stale package lists are the usual cause; refresh once and retry.
    await run("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update", "-q"], {
      timeoutMs: APT_TIMEOUT_MS,
      signal: context.signal,
      log: context.log,
    });
    result = await install();
  }
  if (result.code !== 0) {
    throw new Error(`apt-get install ${packages.map((p) => path.basename(p)).join(" ")} не удался (см. logs/setup.log)`);
  }
}

async function playwrightStep(paths: HostPaths, options: SetupOptions, context: StepContext): Promise<string[]> {
  await ensurePlaywrightPackage(paths, options.force, context);
  await ensureRuntimeDir(paths, { force: options.force });
  return [];
}

export async function playwrightInstalled(paths: HostPaths): Promise<boolean> {
  const pkg = (await readJson(path.join(paths.playwrightPackage, "package.json"))) as { version?: unknown } | null;
  return pkg?.version === PLAYWRIGHT_CORE.version && (await isFile(path.join(paths.playwrightPackage, ".complete")));
}

async function ensurePlaywrightPackage(paths: HostPaths, force: boolean, context: StepContext): Promise<void> {
  if (!force && (await playwrightInstalled(paths))) return;
  await context.progress(`Скачиваю ${PLAYWRIGHT_CORE.name} ${PLAYWRIGHT_CORE.version}`);
  await fs.mkdir(paths.packages, { recursive: true });
  const staging = path.join(paths.packages, `.staging-${process.pid}-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(staging);
  try {
    const tgz = path.join(staging, "package.tgz");
    await downloadFile(PLAYWRIGHT_CORE.url, tgz, {
      integrity: PLAYWRIGHT_CORE.integrity,
      signal: context.signal,
      log: context.log,
      totalMs: 10 * 60_000,
    });
    await runChecked("tar", ["-xzf", tgz, "-C", staging, "--no-same-owner"], {
      timeoutMs: 120_000,
      signal: context.signal,
      log: context.log,
    });
    const extracted = path.join(staging, "package");
    const pkg = (await readJson(path.join(extracted, "package.json"))) as { version?: unknown } | null;
    if (pkg?.version !== PLAYWRIGHT_CORE.version) throw new Error("Архив playwright-core повреждён: нет package.json нужной версии");
    await fs.writeFile(path.join(extracted, ".complete"), `${new Date().toISOString()}\n`);
    await swapInto(extracted, paths.playwrightPackage);
  } finally {
    await removeTree(staging);
  }
}

/**
 * Replace `dest` with `source` (both on one filesystem). Running processes
 * that already resolved files keep their inodes; new lookups see the new tree.
 */
async function swapInto(source: string, dest: string): Promise<void> {
  const old = `${dest}.old-${randomBytes(4).toString("hex")}`;
  const hadOld = await fs.rename(dest, old).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    },
  );
  await fs.rename(source, dest);
  if (hadOld) await removeTree(old);
}

const runtimeInstalls = new Map<string, Promise<void>>();

/**
 * Write the embedded runtime (bot runner, transcriber, mock meeting) into
 * runtime/<hash>/, link playwright-core into its node_modules and mark it
 * .ready — all in a staging dir renamed into place, so a runtime dir is
 * either absent or complete. Cheap enough for meeting.start to call when a
 * plugin update brought a new runtime hash. playwright-core need not be
 * installed yet: the link then dangles until setup downloads the package
 * (only the bot needs it, so transcription keeps working after an update
 * that bumps the pin).
 */
export function ensureRuntimeDir(
  paths: HostPaths,
  options: { readonly force?: boolean; readonly files?: Readonly<Record<string, string>> } = {},
): Promise<void> {
  const running = runtimeInstalls.get(paths.runtime);
  if (running !== undefined) return running;
  const install = installRuntimeDir(paths, options.force ?? false, options.files ?? RUNTIME_FILES).finally(() =>
    runtimeInstalls.delete(paths.runtime),
  );
  runtimeInstalls.set(paths.runtime, install);
  return install;
}

async function installRuntimeDir(paths: HostPaths, force: boolean, files: Readonly<Record<string, string>>): Promise<void> {
  if (!force && (await statOrNull(paths.runtimeReady)) !== null) return;
  await fs.mkdir(paths.runtimeRoot, { recursive: true });
  const staging = path.join(paths.runtimeRoot, `.staging-${paths.runtimeHash}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.resolve(staging, relative);
      if (!target.startsWith(`${staging}${path.sep}`)) throw new Error(`Недопустимый путь во встроенных файлах: ${relative}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const nodeModules = path.join(staging, "node_modules");
    await fs.mkdir(nodeModules, { recursive: true });
    // Relative link: staging and the final dir sit at the same depth.
    await fs.symlink(
      path.relative(path.join(paths.runtime, "node_modules"), paths.playwrightPackage),
      path.join(nodeModules, PLAYWRIGHT_CORE.name),
      "dir",
    );
    await fs.writeFile(
      path.join(staging, ".ready"),
      `${JSON.stringify({ hash: paths.runtimeHash, files: Object.keys(files).length, createdAt: Date.now() })}\n`,
    );
    if (force) {
      await swapInto(staging, paths.runtime);
    } else {
      await fs.rename(staging, paths.runtime).catch(async (error: unknown) => {
        // Another writer finished first; a complete dir is all we need.
        if ((errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") && (await statOrNull(paths.runtimeReady)) !== null) return;
        if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") return swapInto(staging, paths.runtime);
        throw error;
      });
    }
  } finally {
    await removeTree(staging);
  }
}

async function uvStep(paths: HostPaths, options: SetupOptions, context: StepContext): Promise<string[]> {
  const uv = await ensureUv(paths, options.force, context);
  return ensureVenv(paths, uv, options.force, context);
}

async function ensureUv(paths: HostPaths, force: boolean, context: StepContext): Promise<string> {
  if (!force && (await isExecutable(paths.uv))) return paths.uv;
  const asset = uvDownload();
  if (asset === null) throw new Error(`uv не поддерживает ${process.platform}-${process.arch}`);
  await context.progress(`Скачиваю uv ${UV_VERSION}`);
  await fs.mkdir(paths.bin, { recursive: true });
  const staging = path.join(paths.bin, `.uv-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(staging);
  try {
    const archive = path.join(staging, "uv.tar.gz");
    await downloadFile(asset.url, archive, { sha256: asset.sha256, signal: context.signal, log: context.log, totalMs: 10 * 60_000 });
    await runChecked("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], {
      timeoutMs: 120_000,
      signal: context.signal,
      log: context.log,
    });
    const binary = path.join(staging, `uv-${asset.target}`, "uv");
    await fs.chmod(binary, 0o755);
    await fs.rename(binary, paths.uv);
  } finally {
    await removeTree(staging);
  }
  return paths.uv;
}

function uvEnv(paths: HostPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UV_CACHE_DIR: paths.cache,
    UV_PYTHON_INSTALL_DIR: paths.pythonInstalls,
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_PROGRESS: "1",
  };
  delete env.VIRTUAL_ENV;
  delete env.CONDA_PREFIX;
  return env;
}

export async function ensureVenv(paths: HostPaths, uv: string, force: boolean, context: StepContext): Promise<string[]> {
  const notes: string[] = [];
  const spec = venvSpec();
  const before = await probeVenv(paths);
  const inUse = before.python !== null && (await pathInUse(paths.venv));
  let recreate = force || before.python === null;
  if (recreate && inUse) {
    notes.push("Python-окружение сейчас используется транскрибатором, поэтому не пересоздано.");
    recreate = false;
  }
  if (!recreate && before.specOk && before.sherpa !== null) return notes;
  if (!recreate && inUse && before.sherpa !== null) {
    // Replacing numpy/sherpa-onnx under a running transcriber breaks its later lazy imports.
    notes.push("Пакеты Python не обновлены: окружение сейчас используется транскрибатором — повторите установку после окончания расшифровки.");
    return notes;
  }

  const env = uvEnv(paths);
  if (recreate) {
    await removeTree(paths.venv);
    await context.progress(`Создаю окружение Python ${PYTHON_VERSION}`);
    await runChecked(uv, ["venv", "--python", PYTHON_VERSION, paths.venv], {
      timeoutMs: UV_TIMEOUT_MS,
      env,
      signal: context.signal,
      log: context.log,
    });
  }
  await context.progress("Устанавливаю sherpa-onnx и numpy");
  await fs.mkdir(paths.cache, { recursive: true });
  const requirements = path.join(paths.cache, "requirements.txt");
  await fs.writeFile(requirements, transcriberRequirements());
  await runChecked(uv, ["pip", "install", "--python", paths.venvPython, "-r", requirements], {
    timeoutMs: UV_TIMEOUT_MS,
    env,
    signal: context.signal,
    log: context.log,
  });
  await writeJsonAtomic(paths.venvMarker, { spec, installedAt: new Date().toISOString() });
  const after = await probeVenv(paths);
  if (after.sherpa === null) throw new Error(`sherpa-onnx не импортируется после установки: ${after.error ?? "неизвестная ошибка"}`);
  return notes;
}

async function modelsStep(paths: HostPaths, options: SetupOptions, context: StepContext): Promise<string[]> {
  for (const spec of MODELS) await ensureModel(paths, spec, options.force, context);
  return [];
}

async function ensureModel(paths: HostPaths, spec: ModelSpec, force: boolean, context: StepContext): Promise<void> {
  if ((await checkModel(paths, spec, { full: force })).ok) return;
  await context.progress(`Скачиваю ${spec.label} (${(spec.bytes / 1e6).toFixed(1)} МБ)`);
  await downloadFile(spec.url, path.join(paths.models, spec.file), {
    sha256: spec.sha256,
    expectedBytes: spec.bytes,
    signal: context.signal,
    log: context.log,
  });
  const after = await checkModel(paths, spec, { full: true });
  if (!after.ok) throw new Error(after.detail);
}

/** Remove runtime/<hash> dirs of older plugin versions that no live process uses, and stale staging dirs. */
export async function collectGarbage(paths: HostPaths, log?: { write(chunk: string): unknown }): Promise<string[]> {
  const removed: string[] = [];
  for (const root of [paths.runtimeRoot, paths.packages, paths.bin]) {
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    for (const name of entries) {
      const full = path.join(root, name);
      if (full === paths.runtime || full === paths.playwrightPackage || full === paths.uv) continue;
      const temporary = name.startsWith(".staging-") || name.startsWith(".uv-") || name.includes(".old-");
      if (temporary) {
        const stat = await statOrNull(full);
        if (stat === null || Date.now() - stat.mtimeMs < STALE_STAGING_MS) continue;
      } else if (root !== paths.runtimeRoot || (await pathInUse(full))) {
        continue;
      }
      await removeTree(full);
      removed.push(full);
      log?.write(`removed ${full}\n`);
    }
  }
  return removed;
}

async function gcStep(paths: HostPaths, _options: SetupOptions, context: StepContext): Promise<string[]> {
  await collectGarbage(paths, context.log);
  return [];
}

async function rotate(file: string): Promise<void> {
  const stat = await statOrNull(file);
  if (stat !== null && stat.size > LOG_ROTATE_BYTES) await fs.rename(file, `${file}.1`).catch(() => undefined);
}

export const DEFAULT_STEPS: readonly SetupStep[] = [systemStep, playwrightStep, uvStep, modelsStep, gcStep];
