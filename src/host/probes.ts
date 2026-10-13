// What is installed on this machine: system binaries (Chrome, Xvfb,
// PulseAudio, ffmpeg, xdotool), sudo, and the plugin's own runtime pieces.
// Version probes are cached by the binary's mtime+size, so repeated env
// checks cost a few stat calls.
import fs from "node:fs/promises";
import path from "node:path";
import { run, which } from "./exec.js";
import { readJson, statOrNull } from "./fsutil.js";
import type { HostPaths } from "./paths.js";
import { mentionsDir } from "./processes.js";
import { CHROME_CANDIDATES, PLAYWRIGHT_CORE, venvSpec } from "./platform.js";

const PROBE_TIMEOUT_MS = 10_000;
const versionCache = new Map<string, { key: string; value: string | null }>();

/** Run `binary args` once per binary version and cache the parsed answer. */
async function cachedProbe(
  binary: string,
  args: readonly string[],
  parse: (output: string) => string | null,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const stat = await statOrNull(binary);
  if (stat === null) return null;
  const cacheKey = `${binary}\0${args.join("\0")}`;
  const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const cached = versionCache.get(cacheKey);
  if (cached?.key === key) return cached.value;
  const result = await run(binary, args, { timeoutMs }).catch(() => null);
  const value = result === null || result.timedOut ? null : parse(`${result.stdout}\n${result.stderr}`);
  // A timed-out probe is not cached: the next check retries.
  if (result !== null && !result.timedOut) versionCache.set(cacheKey, { key, value });
  return value;
}

function firstMatch(pattern: RegExp): (output: string) => string | null {
  return (output) => pattern.exec(output)?.[1] ?? null;
}

export interface ChromeProbe {
  readonly path: string | null;
  readonly version: string | null;
  readonly configured: boolean;
  readonly detail: string;
}

export async function probeChrome(configuredPath: string): Promise<ChromeProbe> {
  const configured = configuredPath.trim();
  let found: string | null = null;
  if (configured !== "") {
    found = await which(configured);
    if (found === null) {
      return { path: null, version: null, configured: true, detail: `Указанный путь к Chrome недоступен: ${configured}` };
    }
  } else {
    for (const candidate of CHROME_CANDIDATES) {
      found = await which(candidate);
      if (found !== null) break;
    }
    if (found === null) return { path: null, version: null, configured: false, detail: "Google Chrome или Chromium не найден" };
  }
  const version = await cachedProbe(found, ["--version"], firstMatch(/(\d+\.\d+\.\d+\.\d+)/));
  return {
    path: found,
    version,
    configured: configured !== "",
    detail: version === null ? `${found} не отвечает на --version` : found,
  };
}

export interface BinaryProbe {
  readonly path: string | null;
  readonly version: string | null;
}

/** `args` null: the binary has no version flag, only locate it. */
async function probeBinary(name: string, args: readonly string[] | null, pattern: RegExp): Promise<BinaryProbe> {
  const found = await which(name);
  if (found === null || args === null) return { path: found, version: null };
  return { path: found, version: await cachedProbe(found, args, firstMatch(pattern)) };
}

export interface SystemProbe {
  readonly chrome: ChromeProbe;
  readonly xvfb: BinaryProbe;
  readonly pulseaudio: BinaryProbe;
  readonly pactl: BinaryProbe;
  readonly ffmpeg: BinaryProbe & { readonly libopus: boolean };
  readonly ffprobe: BinaryProbe;
  readonly xdotool: BinaryProbe;
}

export async function probeSystem(chromePath: string): Promise<SystemProbe> {
  const [chrome, xvfb, pulseaudio, pactl, ffmpeg, ffprobe, xdotool] = await Promise.all([
    probeChrome(chromePath),
    // Xvfb has no version flag at all.
    probeBinary("Xvfb", null, /$^/),
    probeBinary("pulseaudio", ["--version"], /pulseaudio ([\w.\-+~]+)/),
    probeBinary("pactl", ["--version"], /pactl ([\w.\-+~]+)/),
    probeBinary("ffmpeg", ["-hide_banner", "-version"], /ffmpeg version (\S+)/),
    probeBinary("ffprobe", ["-hide_banner", "-version"], /ffprobe version (\S+)/),
    probeBinary("xdotool", ["--version"], /xdotool version (\S+)/),
  ]);
  const libopus =
    ffmpeg.path !== null &&
    (await cachedProbe(ffmpeg.path, ["-hide_banner", "-encoders"], (out) => (/\blibopus\b/.test(out) ? "yes" : "no"))) === "yes";
  return { chrome, xvfb, pulseaudio, pactl, ffmpeg: { ...ffmpeg, libopus }, ffprobe, xdotool };
}

/** Passwordless sudo (`sudo -n true`); never prompts. */
export async function probeSudo(): Promise<boolean> {
  const sudo = await which("sudo");
  if (sudo === null) return false;
  const result = await run(sudo, ["-n", "true"], { timeoutMs: 5_000 }).catch(() => null);
  return result?.code === 0;
}

export interface RuntimeProbe {
  /** runtime/<hash>/.ready exists. */
  readonly ready: boolean;
  /** playwright-core version resolvable from the runtime dir, or null. */
  readonly playwright: string | null;
  /** Version of the shared extracted package (installed even if the runtime dir is not). */
  readonly sharedPlaywright: string | null;
}

async function packageVersion(dir: string): Promise<string | null> {
  const pkg = (await readJson(path.join(dir, "package.json"))) as { version?: unknown } | null;
  return typeof pkg?.version === "string" ? pkg.version : null;
}

export async function probeRuntime(paths: HostPaths): Promise<RuntimeProbe> {
  const [ready, playwright, sharedComplete, sharedPlaywright] = await Promise.all([
    statOrNull(paths.runtimeReady).then((stat) => stat !== null),
    packageVersion(path.join(paths.runtime, "node_modules", PLAYWRIGHT_CORE.name)),
    statOrNull(path.join(paths.playwrightPackage, ".complete")).then((stat) => stat !== null),
    packageVersion(paths.playwrightPackage),
  ]);
  return { ready, playwright, sharedPlaywright: sharedComplete ? sharedPlaywright : null };
}

export interface VenvProbe {
  readonly python: string | null;
  readonly sherpa: string | null;
  readonly numpy: string | null;
  readonly error: string | null;
  /** The venv was installed from the current requirements. */
  readonly specOk: boolean;
}

const VENV_PROBE = [
  "import json, sys",
  "r = {'python': sys.version.split()[0]}",
  "try:",
  "    import numpy, sherpa_onnx",
  "    from importlib.metadata import version",
  "    r['sherpa'] = getattr(sherpa_onnx, '__version__', None) or version('sherpa-onnx')",
  "    r['numpy'] = numpy.__version__",
  "except Exception as e:",
  "    r['error'] = repr(e)",
  "print(json.dumps(r))",
].join("\n");

const venvCache = new Map<string, { key: string; value: VenvProbe }>();

/** The first import of numpy + sherpa-onnx after an install compiles bytecode: allow it time. */
const VENV_PROBE_TIMEOUT_MS = 60_000;

export async function probeVenv(paths: HostPaths, options: { readonly timeoutMs?: number } = {}): Promise<VenvProbe> {
  const empty: VenvProbe = { python: null, sherpa: null, numpy: null, error: null, specOk: false };
  const python = await statOrNull(paths.venvPython);
  if (python === null) return { ...empty, error: "Окружение ещё не создано" };
  const marker = (await readJson(paths.venvMarker)) as { spec?: unknown } | null;
  const specOk = marker?.spec === venvSpec();
  const markerStat = await statOrNull(paths.venvMarker);
  const cfgStat = await statOrNull(path.join(paths.venv, "pyvenv.cfg"));
  const key = `${python.mtimeMs}:${markerStat?.mtimeMs ?? 0}:${cfgStat?.mtimeMs ?? 0}`;
  const cached = venvCache.get(paths.venv);
  if (cached?.key === key) return { ...cached.value, specOk };
  const result = await run(paths.venvPython, ["-I", "-c", VENV_PROBE], {
    timeoutMs: options.timeoutMs ?? VENV_PROBE_TIMEOUT_MS,
  }).catch((error: unknown) => ({
    code: -1,
    stdout: "",
    stderr: String(error),
    timedOut: false,
    signal: null,
  }));
  let value: VenvProbe;
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    value = {
      python: typeof parsed.python === "string" ? parsed.python : null,
      sherpa: typeof parsed.sherpa === "string" ? parsed.sherpa : null,
      numpy: typeof parsed.numpy === "string" ? parsed.numpy : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      specOk,
    };
  } catch {
    value = { ...empty, error: `Python не запускается: ${(result.stderr || result.stdout).trim().slice(-300)}`, specOk };
  }
  if (!result.timedOut) venvCache.set(paths.venv, { key, value });
  return value;
}

/** Whether any live process's command line names `dir` or a path inside it. */
export async function pathInUse(dir: string): Promise<boolean> {
  const entries = await fs.readdir("/proc").catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (cmdline.split("\0").some((arg) => mentionsDir(arg, dir))) return true;
  }
  return false;
}
