// Host data layout (docs/dev/DESIGN.md §3) and the names of the files inside
// a meeting directory (§4). Everything the host touches is derived from here.
import path from "node:path";
import { MEETING_ID_PATTERN } from "../shared/runtime-files.js";
import { RUNTIME_HASH } from "../generated/runtime-files.js";
import { PLAYWRIGHT_CORE } from "./platform.js";

export interface HostPaths {
  readonly root: string;
  readonly bin: string;
  readonly uv: string;
  /** uv-managed CPython installs. */
  readonly pythonInstalls: string;
  readonly cache: string;
  readonly downloads: string;
  readonly venv: string;
  readonly venvPython: string;
  /** `{spec}` of the last successful package install into the venv. */
  readonly venvMarker: string;
  readonly models: string;
  /** Shared npm packages (playwright-core), symlinked into each runtime dir. */
  readonly packages: string;
  readonly playwrightPackage: string;
  readonly runtimeRoot: string;
  readonly runtimeHash: string;
  /** runtime/<hash>: the embedded bot runner + transcriber of this plugin version. */
  readonly runtime: string;
  readonly runtimeReady: string;
  readonly botScript: string;
  readonly transcriberScript: string;
  readonly logs: string;
  readonly setupLog: string;
  readonly setupState: string;
  readonly meetings: string;
  readonly profiles: string;
  readonly zoomProfile: string;
  /** `{url, updatedAt}` of the GigaAM server, re-read by running transcribers. */
  readonly gigaamFile: string;
  /** PulseAudio client.conf with autospawn disabled, for the host's own pactl calls. */
  readonly pulseClientConf: string;
}

export function hostPaths(dataDir: string, runtimeHash: string = RUNTIME_HASH): HostPaths {
  const root = path.resolve(dataDir);
  const venv = path.join(root, "venv");
  const runtimeRoot = path.join(root, "runtime");
  const runtime = path.join(runtimeRoot, runtimeHash);
  const logs = path.join(root, "logs");
  const packages = path.join(root, "packages");
  const profiles = path.join(root, "profiles");
  return {
    root,
    bin: path.join(root, "bin"),
    uv: path.join(root, "bin", "uv"),
    pythonInstalls: path.join(root, "python"),
    cache: path.join(root, "cache"),
    downloads: path.join(root, "cache", "downloads"),
    venv,
    venvPython: path.join(venv, "bin", "python"),
    venvMarker: path.join(venv, ".meetings-install.json"),
    models: path.join(root, "models"),
    packages,
    playwrightPackage: path.join(packages, `${PLAYWRIGHT_CORE.name}-${PLAYWRIGHT_CORE.version}`),
    runtimeRoot,
    runtimeHash,
    runtime,
    runtimeReady: path.join(runtime, ".ready"),
    botScript: path.join(runtime, "bot", "bot-runner.mjs"),
    transcriberScript: path.join(runtime, "transcriber", "transcriber.py"),
    logs,
    setupLog: path.join(logs, "setup.log"),
    setupState: path.join(root, "setup.json"),
    meetings: path.join(root, "meetings"),
    profiles,
    zoomProfile: path.join(profiles, "zoom"),
    gigaamFile: path.join(root, "gigaam.json"),
    pulseClientConf: path.join(root, "pulse-client.conf"),
  };
}

/** Files inside a meeting directory (DESIGN §4). */
export const MEETING_FILES = {
  config: "config.json",
  state: "state.json",
  events: "events.jsonl",
  speakers: "speakers.jsonl",
  roster: "roster.json",
  audio: "audio.ogg",
  pcm: "audio.pcm",
  screenshot: "screen.jpg",
  stopRequest: "stop.request",
  debugRequest: "debug.request",
  transcriber: "transcriber.json",
  segments: "segments.jsonl",
  embeddings: "embeddings.jsonl",
  transcript: "transcript.json",
  transcriptMd: "transcript.md",
  transcriptTxt: "transcript.txt",
  botLog: "bot.log",
  transcriberLog: "transcriber.log",
  /** Host-written: pids of the processes the host spawned. */
  pids: "pids.json",
  viewer: "viewer.json",
  control: "control",
} as const;

export const BOT_SCRIPT_NAME = "bot-runner.mjs";
export const TRANSCRIBER_SCRIPT_NAME = "transcriber.py";

export function meetingDir(paths: HostPaths, meetingId: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) throw new Error(`Неверный идентификатор встречи: ${meetingId}`);
  return path.join(paths.meetings, meetingId);
}

export function meetingFile(paths: HostPaths, meetingId: string, name: string): string {
  return path.join(meetingDir(paths, meetingId), name);
}
