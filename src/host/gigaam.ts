// Find the GigaAM ASR server: the configured URL, else the gigaam bb plugin's
// managed server (`bb gigaam status --json` → port). The result is cached for
// 30 s and persisted to <hostData>/gigaam.json, which running transcribers
// re-read so a GigaAM restart on a new port does not stall them.
import os from "node:os";
import path from "node:path";
import type { GigaamStatus } from "../shared/contract.js";
import { run, which } from "./exec.js";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import type { HostPaths } from "./paths.js";

const CACHE_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** With the health check this stays inside gigaam.discover's 15 s call deadline. */
const BB_STATUS_TIMEOUT_MS = 10_000;

const cache = new Map<string, { at: number; status: GigaamStatus }>();

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The bb CLI: PATH first, then the usual npm-global location. */
export async function findBb(): Promise<string | null> {
  return (await which("bb")) ?? (await which(path.join(os.homedir(), ".npm-global", "bin", "bb")));
}

interface Located {
  readonly url: string | null;
  readonly detail: string;
}

async function locateViaPlugin(): Promise<Located> {
  const bb = await findBb();
  if (bb === null) return { url: null, detail: "Команда bb не найдена: не удаётся найти сервер GigaAM" };
  const result = await run(bb, ["gigaam", "status", "--json"], { timeoutMs: BB_STATUS_TIMEOUT_MS }).catch(
    (error: unknown) => ({ code: -1, stdout: "", stderr: String(error), timedOut: false, signal: null }),
  );
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`;
    return {
      url: null,
      detail: /unknown command|not found|no plugin|Unknown/i.test(text)
        ? "Плагин gigaam не установлен (bb plugin install gigaam)"
        : `bb gigaam status завершился с ошибкой: ${text.trim().split("\n").slice(-1)[0] ?? ""}`.trim(),
    };
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { url: null, detail: "bb gigaam status вернул не JSON" };
  }
  if (status.mode === "external" && typeof status.serverUrl === "string") {
    return { url: normalizeUrl(status.serverUrl), detail: "Внешний сервер GigaAM" };
  }
  if (status.phase === "ready" && typeof status.port === "number") {
    return { url: `http://127.0.0.1:${status.port}`, detail: "Сервер плагина gigaam" };
  }
  const message = typeof status.message === "string" ? status.message : "";
  return {
    url: null,
    detail: `GigaAM ещё не готов (${String(status.phase ?? "unknown")}${message ? `: ${message}` : ""})`,
  };
}

async function health(url: string): Promise<{ ready: boolean; detail: string }> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return { ready: false, detail: `${url}/health ответил HTTP ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { ready?: unknown; model?: unknown };
    if (body.ready === false) return { ready: false, detail: "Сервер GigaAM загружает модель" };
    return { ready: true, detail: typeof body.model === "string" ? `Готов (${body.model})` : "Готов" };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "не ответил за 3 с" : "недоступен";
    return { ready: false, detail: `Сервер GigaAM ${url} ${reason}` };
  }
}

/** Persist the URL for running transcribers, only when it changed. */
async function persist(paths: HostPaths, url: string): Promise<void> {
  const current = (await readJson(paths.gigaamFile)) as { url?: unknown } | null;
  if (current?.url === url) return;
  await writeJsonAtomic(paths.gigaamFile, { url, updatedAt: Date.now() });
}

export async function discoverGigaam(
  paths: HostPaths,
  configuredUrl: string,
  options: { readonly fresh?: boolean } = {},
): Promise<GigaamStatus> {
  const configured = normalizeUrl(configuredUrl);
  const key = `${paths.root}\0${configured}`;
  const cached = cache.get(key);
  if (!options.fresh && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.status;

  const located: Located = configured !== "" ? { url: configured, detail: "Адрес из настроек" } : await locateViaPlugin();
  let status: GigaamStatus;
  if (located.url === null) {
    status = { url: null, ready: false, detail: located.detail };
  } else {
    const checked = await health(located.url);
    status = { url: located.url, ready: checked.ready, detail: `${checked.detail} — ${located.detail.toLowerCase()}` };
    await persist(paths, located.url).catch(() => undefined);
  }
  cache.set(key, { at: Date.now(), status });
  return status;
}

/** Test hook: forget cached discoveries. */
export function clearGigaamCache(): void {
  cache.clear();
}
