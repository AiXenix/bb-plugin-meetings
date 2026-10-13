// Google Chrome for the bot: profile preparation (fresh, or a copy of the
// signed-in Zoom profile), launch through playwright-core on the bot's Xvfb
// display with its PulseAudio devices, and process cleanup.
import fs from "node:fs";
import path from "node:path";
import { BotError, findProcesses, isAlive, killPid, sleep } from "./proc.mjs";

/**
 * Xvfb screen and Chrome window. Tabs + toolbar take 87 px and the
 * "unsupported command-line flag" infobar (--disable-blink-features,
 * --use-fake-ui-for-media-stream) 56 px, leaving a 1280x720 viewport.
 */
export const SCREEN = Object.freeze({ width: 1280, height: 864 });
export const WINDOW = Object.freeze({ width: 1280, height: 863 });

const BLOCKED_SCHEMES = ["zoommtg", "zoomus", "zoomusm"];

/** Profile entries never copied from the persistent Zoom profile (locks, caches, crash state). */
const SKIP_COPY = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "CacheStorage",
  "ScriptCache",
  "Crashpad",
  "BrowserMetrics",
  "component_crx_cache",
  "optimization_guide_model_store",
  "Safe Browsing",
  "segmentation_platform",
  "OnDeviceHeadSuggestModel",
  "screen_ai",
  "WasmTtsEngine",
]);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Create (or patch) a Chrome profile: block the Zoom desktop hand-off schemes,
 * mark the last exit clean (no "restore pages" bubble), allow mic/camera,
 * silence translate/password prompts. `copyFrom` seeds it from the signed-in
 * Zoom profile.
 */
export function prepareProfile(profileDir, { copyFrom = null, log } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  if (copyFrom) {
    if (!fs.existsSync(copyFrom)) {
      log?.("warn", "The signed-in Zoom profile does not exist; joining as a guest", { zoomProfileDir: copyFrom });
    } else {
      fs.cpSync(copyFrom, profileDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter: (src) => !SKIP_COPY.has(path.basename(src)),
      });
      log?.("info", "Copied the signed-in Zoom profile", { from: copyFrom });
    }
  }
  const prefsFile = path.join(profileDir, "Default", "Preferences");
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  const prefs = deepMerge(readJsonFile(prefsFile), {
    protocol_handler: { excluded_schemes: Object.fromEntries(BLOCKED_SCHEMES.map((s) => [s, true])) },
    profile: {
      exit_type: "Normal",
      exited_cleanly: true,
      default_content_setting_values: { media_stream_mic: 1, media_stream_camera: 1, notifications: 2, geolocation: 2 },
      password_manager_enabled: false,
    },
    credentials_enable_service: false,
    translate: { enabled: false },
    intl: { accept_languages: "en-US,en" },
    browser: { has_seen_welcome_page: true },
    session: { restore_on_startup: 5 },
  });
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  const localStateFile = path.join(profileDir, "Local State");
  const localState = deepMerge(readJsonFile(localStateFile), {
    browser: { enabled_labs_experiments: [] },
    protocol_handler: { excluded_schemes: Object.fromEntries(BLOCKED_SCHEMES.map((s) => [s, true])) },
  });
  fs.writeFileSync(localStateFile, JSON.stringify(localState));
}

/** Find a Chrome binary when the config does not name one. */
export function resolveChromePath(configured) {
  const candidates = [
    configured,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  throw new BotError("dependency_missing", `Google Chrome not found (looked at ${candidates.join(", ")})`);
}

async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch (error) {
    throw new BotError("dependency_missing", `playwright-core is not installed next to the bot runtime: ${error.message}`);
  }
}

/**
 * Launch headed Chrome on `display` with a persistent profile. Returns
 * { context, page }. `initScripts` are page-script sources installed before
 * any page script runs (every frame).
 */
export async function launchChrome({ chromePath, profileDir, display, pulse, initScripts = [], log }) {
  const { chromium } = await loadPlaywright();
  const env = { ...process.env, DISPLAY: display };
  if (pulse) {
    env.PULSE_SINK = pulse.sink;
    env.PULSE_SOURCE = pulse.mic;
  }
  // Chrome must not reuse the bot's own D-Bus/desktop session for anything.
  delete env.DBUS_SESSION_BUS_ADDRESS;
  const args = [
    "--lang=en-US",
    "--accept-lang=en-US,en",
    "--disable-blink-features=AutomationControlled",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    "--window-position=0,0",
    // --in-process-gpu (suggested by the research) crashes Chrome 155 at start
    // with SIGTRAP on this setup; --disable-gpu alone is fine.
    "--disable-gpu",
    "--password-store=basic",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-crash-restore-bubble",
  ];
  // The bot handles SIGTERM/SIGINT/SIGHUP itself (leave politely, stop ffmpeg,
  // clean up). Playwright's defaults would close Chrome at once on SIGTERM
  // (before the bot can click Leave) and process.exit(130) on SIGINT.
  const signals = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: false,
      // Without the sandbox Chrome shows an "unsupported command-line flag"
      // infobar (a bot tell that also shrinks the viewport).
      chromiumSandbox: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args,
      env,
      locale: "en-US",
      viewport: null,
      permissions: ["microphone", "camera"],
      timeout: 60_000,
      ...signals,
    });
  } catch (error) {
    if (!/sandbox/i.test(error.message)) throw new BotError("browser_crashed", `Chrome did not start: ${error.message.split("\n")[0]}`);
    log("warn", "Chrome failed with the sandbox; retrying without it", { error: error.message.split("\n")[0] });
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: false,
      chromiumSandbox: false,
      ignoreDefaultArgs: ["--enable-automation"],
      args,
      env,
      locale: "en-US",
      viewport: null,
      permissions: ["microphone", "camera"],
      timeout: 60_000,
      ...signals,
    });
  }
  for (const content of initScripts) await context.addInitScript({ content });
  // The desktop-app hand-off never reaches the network stack, but abort it if it does.
  await context.route(/^(zoommtg|zoomus|zoomusm):/i, (route) => route.abort()).catch(() => {});
  const page = context.pages()[0] ?? (await context.newPage());
  for (const extra of context.pages().slice(1)) await extra.close().catch(() => {});
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
  log("info", "Chrome started", { chromePath, display, viewport });
  return { context, page };
}

/** Signal a Chrome process and, when it leads one, its process group (renderers, GPU, zygote). */
function signalChrome(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // not a group leader
  }
  killPid(pid, signal);
}

/**
 * Kill any Chrome still using `profileDir`. Playwright starts Chrome in its
 * own process group, so killing the bot's group does not reach it.
 */
export async function killChromeForProfile(profileDir) {
  const procs = findProcesses(`--user-data-dir=${profileDir}`);
  for (const { pid } of procs) signalChrome(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && procs.some(({ pid }) => isAlive(pid))) await sleep(100);
  for (const { pid } of procs) if (isAlive(pid)) signalChrome(pid, "SIGKILL");
  return procs.length;
}

/** Synchronous variant for the watchdog. */
export function killChromeForProfileSync(profileDir) {
  for (const { pid } of findProcesses(`--user-data-dir=${profileDir}`)) signalChrome(pid, "SIGKILL");
}
