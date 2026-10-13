// Pinned toolchain for the plugin-managed runtime: uv (same release and
// checksums as the gigaam plugin), the transcriber's Python packages, the
// playwright-core tarball and the sherpa-onnx models. Changing a pin changes
// the install spec, so existing installs update on the next setup.
import { createHash } from "node:crypto";
import { RUNTIME_FILES } from "../generated/runtime-files.js";

export const UV_VERSION = "0.13.0";
export const PYTHON_VERSION = "3.12";

interface UvAsset {
  readonly target: string;
  readonly sha256: string;
}

// SHA-256 sums from the uv release's .sha256 files, checked after download.
const UV_ASSETS: Readonly<Record<string, UvAsset>> = {
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "b0828fc4cdc47d65951e94b5f0a15a5364420e8dcd88723f3b21e7a2eb30bbc3",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "281ca6cf43f4e26e35474839ad4861be86de42af2682f74134460f5b2071b96d",
  },
};

export interface UvDownload extends UvAsset {
  readonly url: string;
}

export function uvDownload(platform: NodeJS.Platform = process.platform, arch: string = process.arch): UvDownload | null {
  const asset = UV_ASSETS[`${platform}-${arch}`];
  if (asset === undefined) return null;
  return {
    ...asset,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${asset.target}.tar.gz`,
  };
}

/** Bots need Linux (Xvfb + PulseAudio); x64 and arm64 are supported. */
export function platformProblem(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform !== "linux") return `Запись встреч поддерживается только на Linux (сейчас ${platform}-${arch})`;
  if (arch !== "x64" && arch !== "arm64") return `Архитектура ${arch} не поддерживается (нужна x64 или arm64)`;
  return null;
}

export const PLAYWRIGHT_CORE = {
  name: "playwright-core",
  version: "1.64.0",
  url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.0.tgz",
  /** dist.integrity from https://registry.npmjs.org/playwright-core/1.64.0 (the package has no dependencies). */
  integrity: "sha512-T9r+MZkTECl2+oUcZ26YgZzTrYidTsIhYYkJix+6iDOymOb1FB2RLLSOxRGnZGv5DStt+aduIVbt+E8WygXYpg==",
} as const;

/** Used when the runtime does not ship transcriber/requirements.txt. */
const FALLBACK_REQUIREMENTS = "sherpa-onnx==1.13.8\nnumpy==2.5.4\n";

export function transcriberRequirements(files: Readonly<Record<string, string>> = RUNTIME_FILES): string {
  return files["transcriber/requirements.txt"] ?? FALLBACK_REQUIREMENTS;
}

/** Identity of the venv contents: reinstall packages when it changes. */
export function venvSpec(requirements: string = transcriberRequirements()): string {
  return createHash("sha256")
    .update(JSON.stringify({ uv: UV_VERSION, python: PYTHON_VERSION, requirements }))
    .digest("hex")
    .slice(0, 16);
}

export interface ModelSpec {
  readonly id: "vad-model" | "speaker-model";
  readonly label: string;
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

// docs/dev/research-sherpa.md §models
export const MODELS: readonly ModelSpec[] = [
  {
    id: "vad-model",
    label: "Модель VAD (Silero v5)",
    file: "silero_vad_v5.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx",
    bytes: 2313101,
    sha256: "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396",
  },
  {
    id: "speaker-model",
    label: "Модель голосов (TitaNet small)",
    file: "nemo_en_titanet_small.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
    bytes: 40257283,
    sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
  },
];

export const CHROME_DEB_URL = "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb";
export const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"] as const;

/** apt package that provides each system binary. */
export const APT_PACKAGES = {
  Xvfb: "xvfb",
  pulseaudio: "pulseaudio",
  pactl: "pulseaudio-utils",
  ffmpeg: "ffmpeg",
  ffprobe: "ffmpeg",
  xdotool: "xdotool",
} as const;

export function chromeInstallCommand(arch: string = process.arch): string {
  return arch === "arm64"
    ? "sudo apt-get install -y chromium"
    : `wget -O /tmp/chrome.deb ${CHROME_DEB_URL} && sudo apt-get install -y /tmp/chrome.deb`;
}

export const MIN_NODE_MAJOR = 22;
