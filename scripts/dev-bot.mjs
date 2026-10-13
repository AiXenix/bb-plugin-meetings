#!/usr/bin/env node
// Dev harness for the meeting bot: mirrors what the host does without bb.
//   1. copies runtime/ to .e2e/runtime/ and installs playwright-core there once
//      (the host layout: <runtime>/bot/*.mjs + <runtime>/node_modules),
//   2. creates .e2e/meetings/<id>/config.json for a link,
//   3. runs bot-runner.mjs detached with stdout/stderr in bot.log, echoing it.
// --avatar <image> stores the image as the avatar of a dev host data dir
// (.e2e/hostdata) and renders the camera video with the host's own code
// (src/host/avatar.ts), like meeting.start does (DESIGN §14); --avatar test
// uses a generated image.
//
// Usage: node scripts/dev-bot.mjs <url> [--name Notetaker] [--alone 120] [--waiting 600]
//          [--max 3600] [--silence 0] [--shots 5] [--chat "text"] [--mode meeting|login]
//          [--profile <dir>] [--selectors '<json>'] [--avatar <image>|test] [--id-prefix dev] [--quiet]
// Ctrl+C sends SIGTERM to the bot (graceful leave).
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const E2E = path.join(ROOT, ".e2e");
export const RUNTIME = path.join(E2E, "runtime");
export const MEETINGS = path.join(E2E, "meetings");
export const PLAYWRIGHT_VERSION = "1.64.0";
/** Host data dir of the dev harness (avatar, renders). */
export const DEV_HOST_DATA = path.join(E2E, "hostdata");
/** The generated test avatar's fill color (RGB), for e2e color checks. */
export const TEST_AVATAR_RGB = [255, 122, 26];

/** Copy runtime/ into .e2e/runtime (keeping its node_modules) and install playwright-core once. */
export function prepareRuntime({ quiet = false } = {}) {
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const entry of fs.readdirSync(path.join(ROOT, "runtime"))) {
    const target = path.join(RUNTIME, entry);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "runtime", entry), target, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules") && !src.split(path.sep).includes("__pycache__"),
    });
  }
  const pkg = path.join(RUNTIME, "node_modules", "playwright-core", "package.json");
  let installed = null;
  try {
    installed = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    // not installed
  }
  if (installed !== PLAYWRIGHT_VERSION) {
    if (!quiet) console.log(`installing playwright-core@${PLAYWRIGHT_VERSION} into ${RUNTIME}`);
    fs.writeFileSync(path.join(RUNTIME, "package.json"), JSON.stringify({ name: "meetings-runtime", private: true, type: "module" }));
    execFileSync("npm", ["install", "--prefix", RUNTIME, `playwright-core@${PLAYWRIGHT_VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"], {
      stdio: quiet ? "ignore" : "inherit",
    });
  }
  return RUNTIME;
}

let hostHooks = false;

/**
 * Import a host module (src/host/<name>.ts) under Node's type stripping:
 * src/ uses ".js" specifiers (bundler style), so a resolve hook maps them to
 * the .ts sources, like scripts/dev-host-setup.mts.
 */
export async function importHost(name) {
  if (!hostHooks) {
    const { registerHooks } = await import("node:module");
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
          throw error;
        }
      },
    });
    hostHooks = true;
  }
  return import(path.join(ROOT, "src", "host", name));
}

/** A test avatar: an orange square with white initials (600x600 PNG). */
export function makeTestAvatar(file, initials = "NT") {
  const [r, g, b] = TEST_AVATAR_RGB.map((v) => v.toString(16).padStart(2, "0"));
  const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((f) => fs.existsSync(f));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = font ? `,drawtext=fontfile=${font}:text=${initials}:fontcolor=white:fontsize=220:x=(w-text_w)/2:y=(h-text_h)/2` : "";
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${r}${g}${b}:s=600x600${text}`, "-frames:v", "1", file]);
  return file;
}

/**
 * Store `image` as the avatar of `dataDir` and render the camera video for
 * `botName` with the host's code (src/host/avatar.ts). Returns the .mjpeg path.
 */
export async function prepareAvatar(image, botName, { dataDir = DEV_HOST_DATA } = {}) {
  const { hostPaths } = await importHost("paths.ts");
  const avatar = await importHost("avatar.ts");
  const paths = hostPaths(dataDir);
  const source = image === "test" ? makeTestAvatar(path.join(E2E, "tmp", "test-avatar.png")) : path.resolve(image);
  const bytes = fs.readFileSync(source);
  const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[avatar.sniffImage(bytes)] ?? "image/png";
  await avatar.setAvatar(paths, bytes.toString("base64"), mime);
  const video = await avatar.renderAvatarVideo(paths, botName);
  if (!video) throw new Error("the avatar video was not rendered");
  return video;
}

export function newMeetingId(prefix = "dev") {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `mtg_${prefix}${suffix}`.slice(0, 36);
}

/** Write a meeting directory with config.json (BotConfig, src/shared/runtime-files.ts). */
export async function createMeeting(url, options = {}) {
  const { parseMeetingUrl } = await import(path.join(ROOT, "src", "shared", "meeting-url.ts"));
  const mode = options.mode ?? "meeting";
  const parsed = mode === "login" ? { platform: "zoom", url, joinUrl: url, meetingNumber: null, passcode: null } : parseMeetingUrl(url);
  const meetingId = options.meetingId ?? newMeetingId(options.idPrefix);
  const dir = path.join(MEETINGS, meetingId);
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    version: 1,
    meetingId,
    mode,
    platform: parsed.platform,
    url: parsed.url,
    joinUrl: parsed.joinUrl,
    meetingNumber: parsed.meetingNumber,
    passcode: parsed.passcode,
    botName: options.botName ?? "Notetaker",
    maxDurationSec: options.maxDurationSec ?? 3600,
    aloneTimeoutSec: options.aloneTimeoutSec ?? 120,
    waitingTimeoutSec: options.waitingTimeoutSec ?? 600,
    silenceTimeoutSec: options.silenceTimeoutSec ?? 0,
    screenshotIntervalSec: options.screenshotIntervalSec ?? 5,
    chatAnnouncement: options.chatAnnouncement ?? "",
    speakerSelectors: options.speakerSelectors ?? null,
    chromePath: options.chromePath ?? "/usr/bin/google-chrome-stable",
    zoomProfileDir: options.zoomProfileDir ?? null,
    avatar: options.avatarVideo != null,
    avatarVideo: options.avatarVideo ?? null,
    liveTranscription: false,
    transcriber: { gigaamUrl: null, diarization: "ui+acoustic", speakerLagMs: 700, keepRawAudio: true, threads: 0 },
    createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return { dir, config };
}

/**
 * Spawn the bot like the host does (detached, own process group, output in
 * bot.log). Returns { child, exited: Promise<{code, signal}>, stopTail() }.
 */
export function runBot(dir, { echo = true } = {}) {
  const logFile = path.join(dir, "bot.log");
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(RUNTIME, "bot", "bot-runner.mjs"), "--meeting-dir", dir], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  let offset = 0;
  const pump = () => {
    try {
      const size = fs.statSync(logFile).size;
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        const handle = fs.openSync(logFile, "r");
        fs.readSync(handle, buffer, 0, buffer.length, offset);
        fs.closeSync(handle);
        offset = size;
        if (echo) process.stdout.write(buffer.toString("utf8"));
      }
    } catch {
      // not yet created
    }
  };
  const timer = setInterval(pump, 300);
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        pump();
        clearInterval(timer);
        resolve({ code, signal });
      }, 300);
    });
  });
  return { child, exited };
}

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function ffprobeDuration(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
    return Number(out.trim());
  } catch {
    return null;
  }
}

function parseCli(argv) {
  const options = {};
  let url = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--name":
        options.botName = next();
        break;
      case "--alone":
        options.aloneTimeoutSec = Number(next());
        break;
      case "--waiting":
        options.waitingTimeoutSec = Number(next());
        break;
      case "--max":
        options.maxDurationSec = Number(next());
        break;
      case "--silence":
        options.silenceTimeoutSec = Number(next());
        break;
      case "--shots":
        options.screenshotIntervalSec = Number(next());
        break;
      case "--chat":
        options.chatAnnouncement = next();
        break;
      case "--mode":
        options.mode = next();
        break;
      case "--profile":
        options.zoomProfileDir = path.resolve(next());
        break;
      case "--selectors":
        options.speakerSelectors = JSON.parse(next());
        break;
      case "--avatar":
        options.avatarImage = next();
        break;
      case "--id-prefix":
        options.idPrefix = next();
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
        url = arg;
    }
  }
  if (options.mode === "login") url ??= "https://zoom.us/signin";
  if (!url) throw new Error("usage: node scripts/dev-bot.mjs <meeting url> [options]");
  return { url, options };
}

async function main() {
  const { url, options } = parseCli(process.argv.slice(2));
  prepareRuntime({ quiet: options.quiet });
  if (options.avatarImage) {
    options.avatarVideo = await prepareAvatar(options.avatarImage, options.botName ?? "Notetaker");
    console.log(`avatar video: ${options.avatarVideo}`);
  }
  const { dir, config } = await createMeeting(url, options);
  console.log(`meeting dir: ${dir}\njoinUrl: ${config.joinUrl}`);
  const { child, exited } = runBot(dir, { echo: !options.quiet });
  let lastPhase = null;
  const watch = setInterval(() => {
    const state = readJsonSafe(path.join(dir, "state.json"));
    if (state && `${state.phase}|${state.detail}` !== lastPhase) {
      lastPhase = `${state.phase}|${state.detail}`;
      if (options.quiet) console.log(`[state] ${state.phase}: ${state.detail}`);
    }
  }, 500);
  const forward = () => {
    console.log("\nsending SIGTERM to the bot (graceful stop)…");
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const { code, signal } = await exited;
  clearInterval(watch);
  const state = readJsonSafe(path.join(dir, "state.json"));
  const roster = readJsonSafe(path.join(dir, "roster.json"));
  const speakers = fs.existsSync(path.join(dir, "speakers.jsonl")) ? fs.readFileSync(path.join(dir, "speakers.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0;
  const ogg = path.join(dir, "audio.ogg");
  console.log(
    JSON.stringify(
      {
        exit: { code, signal },
        phase: state?.phase,
        endReason: state?.endReason,
        error: state?.error,
        detail: state?.detail,
        joinedAt: state?.joinedAt,
        recordingStartedAt: state?.recordingStartedAt,
        audio: state?.audio,
        oggDurationSec: fs.existsSync(ogg) ? ffprobeDuration(ogg) : null,
        roster,
        speakerLines: speakers,
        dir,
      },
      null,
      2,
    ),
  );
  process.exit(code ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
