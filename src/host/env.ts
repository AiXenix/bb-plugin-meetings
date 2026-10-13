// env.check: one report of everything the bot and transcriber need on this
// machine, with Russian labels for the Meetings page and, where env.setup
// cannot help, the command that fixes it.
import type { EnvItem, EnvReport } from "../shared/contract.js";
import { discoverGigaam } from "./gigaam.js";
import { checkModel } from "./models.js";
import type { HostPaths } from "./paths.js";
import {
  APT_PACKAGES,
  MIN_NODE_MAJOR,
  MODELS,
  PLAYWRIGHT_CORE,
  PYTHON_VERSION,
  chromeInstallCommand,
  platformProblem,
  uvDownload,
} from "./platform.js";
import { probeRuntime, probeSudo, probeSystem, probeVenv, type BinaryProbe } from "./probes.js";
import { run } from "./exec.js";
import { errorMessage, statOrNull } from "./fsutil.js";
import { setupSummary } from "./setup-state.js";

/** env.check is called with a 30 s deadline: every probe has to answer well within it. */
const VENV_CHECK_TIMEOUT_MS = 20_000;

export interface EnvCheckInput {
  readonly chromePath: string;
  readonly gigaamUrl: string;
}

function item(fields: Omit<EnvItem, "fix"> & { fix?: string | null }): EnvItem {
  return { ...fields, fix: fields.ok ? null : (fields.fix ?? null) };
}

function aptFix(sudo: boolean, packages: readonly string[]): string | null {
  return sudo ? null : `sudo apt-get install -y ${[...new Set(packages)].join(" ")}`;
}

function located(probe: BinaryProbe, missing: string): string {
  return probe.path ?? missing;
}

async function uvVersion(paths: HostPaths): Promise<string | null> {
  if ((await statOrNull(paths.uv)) === null) return null;
  const result = await run(paths.uv, ["--version"], { timeoutMs: 10_000 }).catch(() => null);
  return /uv (\S+)/.exec(result?.stdout ?? "")?.[1] ?? null;
}

export async function checkEnv(paths: HostPaths, input: EnvCheckInput): Promise<EnvReport> {
  const unsupported = platformProblem();
  const [sudo, system, runtime, venv, uv, gigaam, setup, ...models] = await Promise.all([
    probeSudo(),
    probeSystem(input.chromePath),
    probeRuntime(paths),
    probeVenv(paths, { timeoutMs: VENV_CHECK_TIMEOUT_MS }),
    uvVersion(paths),
    discoverGigaam(paths, input.gigaamUrl),
    setupSummary(paths),
    ...MODELS.map((spec) => checkModel(paths, spec).catch((error: unknown) => ({ ok: false, detail: errorMessage(error) }))),
  ]);
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const sudoHint = sudo ? null : "нет sudo без пароля — выполните команду вручную";

  const items: EnvItem[] = [
    item({
      id: "chrome",
      label: "Google Chrome",
      ok: system.chrome.path !== null && system.chrome.version !== null,
      required: true,
      version: system.chrome.version,
      detail: system.chrome.detail,
      fix: system.chrome.configured
        ? "Исправьте путь в настройке chromePath или очистите её для автопоиска"
        : sudo
          ? null
          : chromeInstallCommand(),
    }),
    item({
      id: "xvfb",
      label: "Виртуальный дисплей Xvfb",
      ok: system.xvfb.path !== null,
      required: true,
      version: system.xvfb.version,
      detail: located(system.xvfb, "Xvfb не найден"),
      fix: aptFix(sudo, [APT_PACKAGES.Xvfb]),
    }),
    item({
      id: "pulseaudio",
      label: "PulseAudio (захват звука)",
      ok: system.pulseaudio.path !== null && system.pactl.path !== null,
      required: true,
      version: system.pulseaudio.version,
      detail:
        system.pulseaudio.path === null
          ? "pulseaudio не найден"
          : system.pactl.path === null
            ? "pactl не найден (пакет pulseaudio-utils)"
            : `${system.pulseaudio.path}, ${system.pactl.path}`,
      fix: aptFix(sudo, [APT_PACKAGES.pulseaudio, APT_PACKAGES.pactl]),
    }),
    item({
      id: "ffmpeg",
      label: "ffmpeg с кодеком Opus",
      ok: system.ffmpeg.path !== null && system.ffmpeg.libopus && system.ffprobe.path !== null,
      required: true,
      version: system.ffmpeg.version,
      detail:
        system.ffmpeg.path === null
          ? "ffmpeg не найден"
          : !system.ffmpeg.libopus
            ? `${system.ffmpeg.path}: нет кодировщика libopus`
            : system.ffprobe.path === null
              ? "ffprobe не найден"
              : system.ffmpeg.path,
      fix: aptFix(sudo, [APT_PACKAGES.ffmpeg]),
    }),
    item({
      id: "xdotool",
      label: "xdotool (закрывает системные диалоги Chrome)",
      ok: system.xdotool.path !== null,
      required: false,
      version: system.xdotool.version,
      detail: located(system.xdotool, "Не найден: бот не сможет закрыть диалог «Open xdg-open?»"),
      fix: aptFix(sudo, [APT_PACKAGES.xdotool]),
    }),
    item({
      id: "node",
      label: `Node.js ${MIN_NODE_MAJOR}+ для бота`,
      ok: nodeMajor >= MIN_NODE_MAJOR,
      required: true,
      version: nodeVersion,
      detail: process.execPath,
      fix: `Обновите bb: бот запускается тем же Node.js, что и bb (нужен ${MIN_NODE_MAJOR}+)`,
    }),
    item({
      id: "runtime",
      label: "Файлы бота и транскрибатора",
      ok: runtime.ready,
      required: true,
      version: paths.runtimeHash,
      detail: runtime.ready ? paths.runtime : "Не установлены",
    }),
    item({
      id: "playwright",
      label: `playwright-core ${PLAYWRIGHT_CORE.version}`,
      ok: runtime.playwright === PLAYWRIGHT_CORE.version,
      required: true,
      version: runtime.playwright ?? runtime.sharedPlaywright,
      detail:
        runtime.playwright === PLAYWRIGHT_CORE.version
          ? "Установлен"
          : runtime.sharedPlaywright !== null
            ? "Скачан, но не подключён к текущей версии бота"
            : runtime.playwright !== null
              ? `Версия ${runtime.playwright} вместо ${PLAYWRIGHT_CORE.version}`
              : "Не установлен",
    }),
    item({
      id: "uv",
      label: "Менеджер пакетов uv",
      ok: uv !== null,
      required: true,
      version: uv,
      detail: uv !== null ? paths.uv : uvDownload() === null ? `Нет сборки uv для ${process.platform}-${process.arch}` : "Не установлен",
    }),
    item({
      id: "venv",
      label: `Python ${PYTHON_VERSION} для транскрибатора`,
      ok: venv.python !== null,
      required: true,
      version: venv.python,
      detail: venv.python !== null ? paths.venv : (venv.error ?? "Не установлен"),
    }),
    item({
      id: "sherpa-onnx",
      label: "sherpa-onnx (VAD и голоса спикеров)",
      ok: venv.sherpa !== null && venv.specOk,
      required: true,
      version: venv.sherpa,
      detail:
        venv.sherpa === null
          ? venv.python === null
            ? "Нет Python-окружения"
            : `Не импортируется: ${venv.error ?? "неизвестная ошибка"}`
          : venv.specOk
            ? `numpy ${venv.numpy ?? "?"}`
            : "Пакеты устарели: нужна повторная установка",
    }),
    ...MODELS.map((spec, index) =>
      item({
        id: spec.id,
        label: spec.label,
        ok: models[index]!.ok,
        required: true,
        version: null,
        detail: models[index]!.detail,
      }),
    ),
    item({
      id: "gigaam",
      label: "Распознавание речи GigaAM",
      ok: gigaam.ready,
      required: true,
      version: null,
      detail: gigaam.detail,
      fix: "Установите плагин gigaam и дождитесь готовности (bb gigaam status) или укажите адрес сервера в настройке gigaamUrl",
    }),
  ];

  if (unsupported !== null) {
    for (const [index, entry] of items.entries()) items[index] = { ...entry, ok: false, detail: unsupported, fix: null };
  }
  if (sudoHint !== null) {
    for (const [index, entry] of items.entries()) {
      if (!entry.ok && entry.fix?.includes("sudo ")) items[index] = { ...entry, detail: `${entry.detail}; ${sudoHint}` };
    }
  }

  return {
    ready: items.every((entry) => entry.ok || !entry.required),
    items,
    setup,
    runtimeHash: paths.runtimeHash,
    hostDataDir: paths.root,
    sudo,
    gigaam,
    chromePath: system.chrome.path,
  };
}
