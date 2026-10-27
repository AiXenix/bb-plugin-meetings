// Zoom web-client adapter (docs/dev/DESIGN.md §6.2, docs/dev/research-zoom.md
// joinFlow / stateMarkers / leaveFlow / participants / activeSpeaker / chat).
// DOM work happens in page/zoom-page.js; this file drives it with trusted
// Playwright input where Zoom needs real events (name keystrokes, Join).
import fs from "node:fs";
import { xdotoolKey } from "./lib/av.mjs";
import { videoIsOn } from "./lib/media.mjs";
import { BotError, StopRequested, sleep, sleepUnless } from "./lib/proc.mjs";

const PAGE_SOURCE = fs.readFileSync(new URL("./page/zoom-page.js", import.meta.url), "utf8").trim();

/** Selectors are data: `speakerSelectors` in config.json overrides any key (arrays replace, objects merge). */
export const DEFAULT_SELECTORS = Object.freeze({
  activeTile: [
    ".speaker-bar-container__video-frame--active",
    ".speaker-active-container__video-frame",
    ".single-main-container__video-frame",
    ".single-suspension-container__video-frame",
    ".gallery-video-container__video-frame--active",
  ],
  tileName: [".video-avatar__avatar-footer span", ".video-avatar__avatar-footer", ".video-avatar__avatar-name"],
  counter: [".footer-button__number-counter", '[class*="number-counter"]'],
  participantsButton: ['button[aria-label*="participants list pane" i]', 'button[aria-label*="manage participants" i]'],
  leave: ['[footer-section="right"] button[aria-label="Leave"]', 'button[aria-label="Leave"]', ".footer__leave-btn", 'button[aria-label="Leave Webinar" i]'],
  /** Candidates only: page/zoom-page.js prefers the "Leave Meeting" text and never clicks "End Meeting for All". */
  leaveConfirm: [
    "button.leave-meeting-options__btn--danger",
    'button.zm-btn--danger[aria-label*="Leave" i]',
    'button[aria-label="Leave Meeting" i]',
  ],
  /** false disables the Redux-store signal. */
  store: true,
  /** Per-signal lag of the speaking indicator behind the audio (ms). */
  lagMs: { track: 100, store: 700, tile: 1200 },
  /** Fusion tuning, see lib/fusion.mjs DEFAULT_FUSION. */
  fusion: {},
  /** Deaf-bot guard tuning, see lib/deaf-guard.mjs DEAF_GUARD_DEFAULTS ({enabled: false} turns it off). */
  deafGuard: {},
});

export function resolveSelectors(override) {
  const out = structuredClone(DEFAULT_SELECTORS);
  if (!override || typeof override !== "object") return out;
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The frame that holds the web client: iframe#webclient (PWA layout) or the top frame. */
export function zoomFrame(page) {
  return page.frames().find((frame) => frame.name() === "webclient") ?? page.mainFrame();
}

/** Run one page/zoom-page.js op in `frame`, bounded by `timeoutMs`. */
export async function pageOp(frame, args, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([
      frame.evaluate(`(${PAGE_SOURCE})(${JSON.stringify(args)})`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`page op ${args.op} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function tryOp(ctx, frame, args, timeoutMs) {
  try {
    return await pageOp(frame, args, timeoutMs);
  } catch (error) {
    ctx.log("debug", `page op ${args.op} failed`, { error: error.message.split("\n")[0] });
    return null;
  }
}

const minutes = (ms) => Math.round(ms / 6000) / 10;
/** Fresh attempts after Zoom's "Automated bots aren't allowed" wall before failing with bot_blocked. */
const BOT_WALL_RETRIES = 2;
/**
 * The join must finish within max(this, waitingTimeoutSec) outside waiting
 * states (waiting room, host not started, 3,001, captcha have their own
 * timeouts); leaving a waiting state grants this much again.
 */
const JOIN_STALL_MS = 240_000;

/** join_failed for a join that stopped making progress, with what the page showed last. */
function joinStalled(m, joinClickedAt) {
  const page = m ? `last page: ${m.title || m.url}${m.text ? `, "${m.text.slice(0, 160)}"` : ""}` : "the page did not answer";
  if (joinClickedAt !== null) return new BotError("join_failed", `Zoom did not let the bot in after it clicked Join (${page})`);
  if (m?.prejoin) {
    const join = !m.prejoin.join ? "has no Join button" : m.prejoin.joinDisabled ? "kept Join disabled" : "did not take the Join click";
    return new BotError("join_failed", `The pre-join form ${join} (${page})`);
  }
  return new BotError("join_failed", `Zoom never showed the join form (${page})`);
}

/** Pages that are not the web client itself (invite/launch pages, personal links, Zoom Events). */
function isLaunchUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)zoom(gov)?\.(us|com)$/i.test(parsed.hostname) && !parsed.pathname.startsWith("/wc/");
  } catch {
    return false;
  }
}

// A direct web-client link skips the regular invite page. If that entry is
// rejected, the bounded retry follows the invite page and its browser link.
// Keep admission parameters in memory; never log the invitation's passcode.
function inviteRetryUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)zoom(gov)?\.(us|com)$/i.test(parsed.hostname)) return url;
    const meeting = parsed.pathname.match(/^\/wc\/(?:join\/)?(\d{8,13})(?:\/|$)/);
    if (!meeting) return url;
    parsed.hostname = parsed.hostname.replace(/^app\./i, "");
    parsed.pathname = `/j/${meeting[1]}`;
    return parsed.toString();
  } catch { return url; }
}

async function gotoMeeting(ctx, url) {
  const launch = isLaunchUrl(url);
  try {
    // /j/ launch pages never reach "load"; Zoom keeps sockets open, so no networkidle either.
    await ctx.page.goto(url, { waitUntil: launch ? "commit" : "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    if (ctx.signal.aborted) throw new StopRequested();
    ctx.log("warn", "Navigation did not finish", { error: error.message.split("\n")[0] });
  }
  if (launch) {
    // A launch page tries to open zoommtg://; Chrome's native dialog would eat all trusted input.
    await sleep(2_500);
    await xdotoolKey(ctx.display, "Escape");
  }
}

/**
 * Put `value` into a form field. fill() (one trusted insertText) comes first:
 * per-key CDP typing at a steady cadence made Zoom answer "Automated bots
 * aren't allowed to join this meeting" in 3 of 3 runs while fill() got in
 * 3 of 3 (2026-10-13, same machine and IP). Humanized keystrokes are only the
 * fallback when fill() leaves the field wrong.
 */
async function typeInto(ctx, frame, selector, value) {
  const field = frame.locator(selector).first();
  try {
    await field.click({ timeout: 4_000 });
  } catch {
    await field.click({ force: true, timeout: 3_000 }).catch(() => {});
  }
  await field.fill(value, { timeout: 4_000 }).catch(() => {});
  let actual = await field.inputValue({ timeout: 2_000 }).catch(() => null);
  if (actual !== value) {
    // Input lost (native dialog?) — dismiss it and type like a person.
    await xdotoolKey(ctx.display, "Escape");
    await field.click({ force: true, timeout: 3_000 }).catch(() => {});
    await ctx.page.keyboard.press("Control+A").catch(() => {});
    await ctx.page.keyboard.press("Backspace").catch(() => {});
    for (const char of value) {
      await ctx.page.keyboard.type(char);
      await sleep(70 + Math.random() * 110);
    }
    actual = await field.inputValue({ timeout: 2_000 }).catch(() => null);
  }
  return actual === value;
}

/** Click with trusted input first, then forced, then a DOM click (research joinFlow §10). */
async function clickJoin(ctx, frame, selectors) {
  const button = frame.locator(selectors.join(", ")).first();
  try {
    await button.click({ timeout: 4_000 });
    return "trusted";
  } catch {
    // intercepted by an overlay or not "stable"
  }
  try {
    await button.click({ force: true, timeout: 3_000 });
    return "force";
  } catch {
    // fall through
  }
  const dom = await tryOp(ctx, frame, { op: "click", selectors });
  return dom ? "dom" : null;
}

/**
 * The join state machine: navigate, pass gates, fill the pre-join form, then
 * poll admission every 2 s until in the meeting (research joinFlow 1–13).
 */
export async function joinFlow(ctx, { launchPage } = {}) {
  const { config, log, setPhase, signal } = ctx;
  const sel = ctx.selectors;
  const waitMs = config.waitingTimeoutSec * 1000;
  let url = config.joinUrl;
  const started = Date.now();
  await gotoMeeting(ctx, url);
  let lastGoto = Date.now();
  let first3001 = null;
  let waitingSince = null;
  let captchaSince = null;
  let nameDone = false;
  let previewDone = false;
  let passcodeDone = false;
  let joinClicks = 0;
  let lastJoinAt = 0;
  let lastKey = "";
  let lastChangeAt = Date.now();
  let reloads = 0;
  let launchClicks = 0;
  let joinClickedAt = null;
  let wallRetries = 0;
  let testJoinRequested = false;
  // One deadline for every non-waiting state (pre-join form whose Join never
  // enables, "Joining…" forever after the click, a page that stopped answering).
  let deadline = started + Math.max(JOIN_STALL_MS, waitMs);
  const progress = () => {
    deadline = Math.max(deadline, Date.now() + JOIN_STALL_MS);
  };
  let last = null;

  for (;;) {
    if (signal.aborted) throw new StopRequested();
    const now = Date.now();
    if (now >= deadline) throw joinStalled(last, joinClickedAt);
    const frame = zoomFrame(ctx.page);
    const m = await tryOp(ctx, frame, { op: "markers", sel }, 10_000);
    if (m === null) {
      await sleepUnless(1_000, signal);
      continue;
    }
    last = m;
    const key = JSON.stringify([m.url, m.title, m.prejoin, m.waitingRoom, m.waitingHost, m.error3001, m.inMeeting, m.loading, m.text.slice(0, 300)]);
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = now;
    }

    // Walls and terminal answers (order: anti-bot and captcha first, research joinFlow §11).
    if (m.registration) throw new BotError("registration_required", "This is a registration-only webinar: register and give the bot the personal join link");
    if (m.botWall) {
      // Zoom's bot score is partly random: a fresh page (and, for guests, fresh
      // cookies) sometimes passes. Retry a little, then give up.
      if (wallRetries < BOT_WALL_RETRIES) {
        wallRetries += 1;
        log("warn", `Zoom answered "Automated bots aren't allowed"; retrying (${wallRetries}/${BOT_WALL_RETRIES})`);
        await ctx.dumpDebug(`bot-wall-${wallRetries}`).catch(() => {});
        if (!config.browserProfileDir && !config.zoomProfileDir) await ctx.context.clearCookies().catch(() => {});
        await sleepUnless(5_000 + Math.random() * 5_000, signal);
        if (signal.aborted) throw new StopRequested();
        nameDone = false;
        previewDone = false;
        passcodeDone = false;
        joinClicks = 0;
        lastJoinAt = 0;
        joinClickedAt = null;
        testJoinRequested = false;
        launchClicks = 0;
        const retryUrl = inviteRetryUrl(url);
        if (retryUrl !== url) log("info", "Retrying through Zoom's invitation page");
        url = retryUrl;
        await gotoMeeting(ctx, url);
        lastGoto = Date.now();
        progress();
        continue;
      }
      throw new BotError(
        "bot_blocked",
        "Zoom отклонил вход гостевого бота. Проверьте, разрешает ли организатор гостевые подключения. Если для встречи нужен вход в Zoom, потребуется подключить аккаунт бота. Запись не началась.",
      );
    }
    if (m.captcha || (m.captchaText && !m.prejoin)) {
      captchaSince ??= now;
      progress();
      setPhase("joining", "Zoom shows a captcha: solve it in the live view (remote control)");
      ctx.wantScreenshot();
      if (now - captchaSince > waitMs) throw new BotError("captcha", `Nobody solved Zoom's captcha within ${minutes(waitMs)} min`);
      await sleepUnless(2_000, signal);
      continue;
    }
    captchaSince = null;
    if (m.browserDisabled) throw new BotError("browser_join_disabled", "The host does not allow joining from a browser");
    if (m.signIn && !m.prejoin) {
      throw new BotError("auth_required", "Эта встреча Zoom доступна только после входа в аккаунт. Подключите Zoom-аккаунт бота или попросите организатора разрешить гостевые подключения. Запись не началась.");
    }
    if (m.ended) throw new BotError("meeting_ended", m.ended.message || "The meeting has ended");
    const zoomSays = m.notice ? ` (Zoom: "${m.notice.slice(0, 160)}")` : "";
    if (m.denied) throw new BotError("denied", `The host denied the bot entry${zoomSays}`);
    if (m.locked) throw new BotError("meeting_locked", `The meeting is locked${zoomSays}`);
    if (m.full) throw new BotError("meeting_full", `The meeting is full${zoomSays}`);
    if (m.wrongPasscode) throw new BotError("wrong_passcode", `Zoom rejected the passcode${zoomSays}`);

    // 3,001 means "not started yet" as often as "invalid": keep retrying.
    if (m.error3001 || (m.errorTitle && !m.prejoin && !m.inMeeting)) {
      first3001 ??= now;
      progress();
      setPhase(
        "waiting_for_host",
        `Zoom says "${m.errorMessage || "This meeting link is invalid (3,001)"}": the meeting has not started yet or the link is wrong; retrying`,
      );
      if (now - first3001 >= waitMs) {
        throw new BotError(
          "invalid_meeting",
          `Zoom kept answering "${m.errorMessage || "This meeting link is invalid (3,001)"}" for ${minutes(waitMs)} min: the meeting id is invalid or the host never started it`,
        );
      }
      if (now - lastGoto >= 15_000) {
        lastGoto = now;
        log("info", "Reloading the meeting link (3,001)");
        await gotoMeeting(ctx, url);
      }
      await sleepUnless(2_000, signal);
      continue;
    }

    // Gates in front of the form.
    if (m.cookie) {
      const clicked = await tryOp(ctx, frame, { op: "click", selectors: ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"] });
      if (clicked) log("info", "Closed the cookie banner", { clicked });
    }
    if (m.disclaimer) {
      const clicked = await tryOp(ctx, frame, { op: "click", selectors: ["#wc_agree1", "#disclaimer_agree"] });
      if (clicked) log("info", "Accepted a disclaimer", { clicked });
    }
    if (m.allow) {
      const allow = frame.getByRole("button", { name: /^(allow|use microphone and camera|use microphone)$/i }).first();
      await allow.click({ timeout: 3_000 }).then(
        () => log("info", "Clicked Zoom's Allow (microphone/camera)"),
        () => tryOp(ctx, frame, { op: "sweep" }),
      );
    }
    if (m.testJoin && !testJoinRequested) {
      await sleepUnless(750, signal);
      testJoinRequested = await frame.locator("#btnJoinTest").click({ timeout: 4000 }).then(() => true, () => false);
      await sleepUnless(2500, signal);
      await xdotoolKey(ctx.display, "Escape");
      if (testJoinRequested) log("info", "Opened Zoom's official test meeting");
      continue;
    }
    if ((launchPage || isLaunchUrl(m.url)) && m.joinFromBrowser && !m.prejoin && launchClicks < 5) {
      launchClicks += 1;
      log("info", 'Clicking "Join from browser"');
      await xdotoolKey(ctx.display, "Escape");
      await frame
        .getByRole("button", { name: /^join from (your |a )?browser$/i })
        .or(frame.getByRole("link", { name: /^join from (your |a )?browser$/i }))
        .first()
        .click({ timeout: 4_000 })
        .catch(() => tryOp(ctx, frame, { op: "click", selectors: ["a.wc-interactive"] }));
      await sleepUnless(3_000, signal);
      continue;
    }

    // Waiting states are checked before in-meeting markers (Zoom renders the waiting room inside .meeting-app).
    if (m.waitingRoom || m.waitingHost) {
      waitingSince ??= now;
      progress();
      if (m.waitingRoom) setPhase("waiting_room", `In the waiting room: ask the host to admit "${config.botName}"`);
      else setPhase("waiting_for_host", "Waiting for the host to start the meeting");
      if (now - waitingSince >= waitMs) {
        throw new BotError("waiting_timeout", `Not admitted within ${minutes(waitMs)} min (${m.waitingRoom ? "waiting room" : "host did not start the meeting"})`);
      }
      await sleepUnless(2_000, signal);
      continue;
    }
    waitingSince = null;

    if (m.inMeeting) {
      log("info", "Admitted to the meeting", { url: m.url, title: m.title, joinClicks });
      break;
    }

    if (m.prejoin) {
      setPhase("joining", joinClicks === 0 ? "Filling in the pre-join form" : "Joining");
      if (m.prejoin.passcode && !passcodeDone) {
        if (!config.passcode) throw new BotError("wrong_passcode", "The meeting asks for a passcode and the link has none");
        passcodeDone = await typeInto(
          ctx,
          frame,
          '#input-for-pwd, #input-for-passcode, #inputpasscode, #inputpwd, input[placeholder*="passcode" i], input[type="password"]',
          config.passcode,
        );
        log("info", passcodeDone ? "Typed the passcode" : "Could not type the passcode");
      }
      if (m.prejoin.name && (!nameDone || m.prejoin.nameValue !== config.botName)) {
        nameDone = await typeInto(ctx, frame, '#input-for-name, #inputname, input[placeholder="Your Name" i]', config.botName);
        log("info", nameDone ? "Typed the bot name" : "Could not type the bot name", { name: config.botName });
        // Allow asynchronous name/media updates to settle on a fast host,
        // then re-read the controls instead of immediately submitting.
        await sleepUnless(1_500, signal);
        continue;
      }
      if (!previewDone) {
        previewDone = true;
        await previewDevices(ctx, frame, m.prejoin);
      }
      if (m.prejoin.join && m.prejoin.joinDisabled === false && now - lastJoinAt > 6_000) {
        if (joinClicks >= 5) throw new BotError("join_failed", "Clicking Join had no effect after 5 attempts");
        if (joinClicks > 0) await xdotoolKey(ctx.display, "Escape");
        const how = await clickJoin(ctx, frame, ["button.preview-join-button", "#joinBtn"]);
        joinClicks += 1;
        lastJoinAt = Date.now();
        joinClickedAt ??= lastJoinAt;
        log("info", `Clicked Join (${how ?? "failed"})`, { attempt: joinClicks });
        setPhase("joining", "Joining the meeting");
        await ctx.dumpDebug("join-clicked").catch(() => {});
      }
    } else if (now - lastChangeAt > 60_000 && reloads < 2) {
      reloads += 1;
      lastChangeAt = now;
      log("warn", "The page has not changed for 60 s; reloading", { url: m.url, text: m.text.slice(0, 200) });
      await ctx.dumpDebug(`stall-${reloads}`).catch(() => {});
      testJoinRequested = false;
      await gotoMeeting(ctx, url);
      lastGoto = Date.now();
    }
    await sleepUnless(2_000, signal);
  }

  await afterAdmission(ctx);
}

/** True when the bot shows its avatar as the camera (bot-runner sets ctx.camera from lib/media.mjs cameraPlan). */
const avatarCamera = (ctx) => ctx.camera === "avatar";

/**
 * Mute the mic on the pre-join screen. The camera: off without an avatar;
 * with one it stays on ("Start Video" is clicked when Zoom offers it off).
 */
export async function previewDevices(ctx, frame, prejoin) {
  const clickPreview = (id) => frame.locator(`#${id}`).click({ timeout: 3_000 }).catch(() => tryOp(ctx, frame, { op: "click", selectors: [`#${id}`] }));
  if (prejoin.mic && /^mute$/i.test(prejoin.mic)) {
    await clickPreview("preview-audio-control-button");
    ctx.log("info", "Muted the microphone in the preview");
  }
  if (avatarCamera(ctx)) {
    if (prejoin.video && /^start video$/i.test(prejoin.video)) {
      await clickPreview("preview-video-control-button");
      ctx.log("info", "Started the camera in the preview (avatar)");
    } else {
      ctx.log("info", "Keeping the camera on in the preview (avatar)", { video: prejoin.video ?? null });
    }
    return;
  }
  if (prejoin.video && /^stop video$/i.test(prejoin.video)) {
    await clickPreview("preview-video-control-button");
    ctx.log("info", "Stopped the camera in the preview");
  }
}

/** Clicks on a camera button that stays off before giving up. */
const MAX_VIDEO_CLICKS = 4;
/**
 * How long after joining the sampler keeps checking an avatar camera that is
 * not on yet (footer loaded late, slow camera start): one check per audio
 * check, then a warning.
 */
const VIDEO_GRACE_MS = 120_000;
/** How often the sampler re-reads Zoom's speaker choice while the avatar camera (fake devices) is used. */
const SPEAKER_CHECK_MS = 60_000;

/** Warn once that the avatar camera is not known to be on (`last`: the last button state read). */
function warnCameraNotOn(ctx, last) {
  const st = ctx.adapterState;
  if (st.videoWarned) return;
  st.videoWarned = true;
  const state = last?.found ? videoIsOn(last) : null;
  ctx.log("warn", state === false ? "The camera did not turn on; the avatar may not be shown" : "Could not tell whether the camera is on", {
    found: !!last?.found,
    label: last?.label ?? null,
    icon: last?.icon ?? null,
    disabled: !!last?.disabled,
  });
}

/**
 * Turn the avatar camera on: read the footer button, click it only when it is
 * known to be off (an unknown state is never toggled); a later check confirms.
 * Returns true (on), false (off or not allowed) or null (unknown). Once the
 * camera was on, a later "off" is left alone: the host (or the user through
 * remote control) turned it off. `checks` reads `pauseMs` apart, with no pause
 * after the last; with `warn` a camera still not on afterwards is logged once.
 * The bot itself makes single checks: before the recorder starts
 * (afterAdmission) and from the sampler (ensureAudio), both of which wait.
 */
export async function ensureVideo(ctx, { checks = 1, pauseMs = 1_500, warn = true } = {}) {
  const st = ctx.adapterState;
  let last = null;
  for (let i = 0; i < checks && !ctx.signal.aborted; i += 1) {
    if (i > 0) await sleepUnless(pauseMs, ctx.signal);
    const frame = zoomFrame(ctx.page);
    const button = await tryOp(ctx, frame, { op: "video", action: "state" }, 4_000);
    last = button;
    st.videoLast = button;
    const on = button?.found ? videoIsOn(button) : null;
    if (on === true) {
      if (st.videoOn !== true) ctx.log("info", "Camera is on (avatar)", { label: button.label, icon: button.icon });
      st.videoOn = true;
      return true;
    }
    if (button?.found && /disallowed/i.test(button.icon)) {
      if (st.videoOn !== false) ctx.log("warn", "Zoom does not let the bot start its camera; the avatar is not shown", { label: button.label, icon: button.icon });
      st.videoOn = false;
      return false;
    }
    // Zoom disables the button for a moment while the camera is starting (measured right after admission).
    if (on === false && !button.disabled) {
      if (st.videoOn === true) {
        if (!st.videoOffLogged) ctx.log("info", "The camera was turned off in the meeting; leaving it off", { label: button.label });
        st.videoOffLogged = true;
        return false;
      }
      if ((st.videoClicks ?? 0) >= MAX_VIDEO_CLICKS) {
        ctx.log("warn", `The camera stayed off after ${st.videoClicks} clicks; giving up, the avatar is not shown`, { label: button.label, icon: button.icon });
        st.videoOn = false;
        return false;
      }
      const clicked = await tryOp(ctx, frame, { op: "video", action: "click" }, 4_000);
      st.videoClicks = (st.videoClicks ?? 0) + 1;
      ctx.log("info", "Starting the camera (avatar)", { label: button.label, icon: button.icon, clicked: !!clicked?.clicked, attempt: st.videoClicks });
    }
  }
  if (warn) warnCameraNotOn(ctx, last);
  return last?.found ? videoIsOn(last) : null;
}

/**
 * With Chrome's fake devices only the "default" output reaches PulseAudio
 * (setSinkId to "Fake Audio Output 1/2" plays into nothing). Zoom picks
 * "default" on a fresh profile (measured 2026-10-13). Logs the choice the
 * first time and whenever it changes (a warning for any non-default output);
 * the sampler re-reads it every SPEAKER_CHECK_MS. Returns the device id or null.
 */
export async function checkSpeaker(ctx) {
  const st = ctx.adapterState;
  const report = await tryOp(ctx, zoomFrame(ctx.page), { op: "store" }, 6_000);
  const speaker = report?.devices?.activeSpeaker ?? null;
  const id = typeof speaker === "string" ? speaker : (speaker?.deviceId ?? null);
  if (id === null) {
    if (!st.speakerUnreadLogged) ctx.log("info", "Could not read Zoom's speaker choice", { found: !!report?.found });
    st.speakerUnreadLogged = true;
    return null;
  }
  const recorded = id === "" || id === "default";
  if (st.speakerId !== id) {
    const label = (report.devices.speakers ?? []).find((d) => d && d.deviceId === id)?.label ?? null;
    if (recorded) ctx.log("info", "Zoom plays the meeting to the default output (recorded)", { speaker: label ?? id });
    else ctx.log("warn", "Zoom plays the meeting to a non-default output; with the avatar camera only the default output is recorded", { speaker: label ?? id });
  }
  st.speakerId = id;
  return id;
}

/** After admission: make sure computer audio is joined (else nothing is recorded), re-mute, camera (off, or on with the avatar), popups. */
async function afterAdmission(ctx) {
  const deadline = Date.now() + 30_000;
  let state = null;
  while (Date.now() < deadline && !ctx.signal.aborted) {
    const frame = zoomFrame(ctx.page);
    state = await tryOp(ctx, frame, { op: "audio", action: "join" });
    if (state?.joined) break;
    if (state?.clicked) ctx.log("info", "Joining computer audio", { via: state.clicked, label: state.label });
    await tryOp(ctx, frame, { op: "sweep" });
    await sleepUnless(1_500, ctx.signal);
  }
  if (state?.joined) ctx.log("info", "Computer audio joined", { label: state.label });
  else ctx.log("warn", "Computer audio does not look joined; the recording may be silent", { label: state?.label ?? null });
  ctx.adapterState.audioJoined = !!state?.joined;
  for (let i = 0; i < 5 && state?.joined && !state.muted; i += 1) {
    state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "mute" });
    if (state?.muted) break;
    await sleep(800);
    state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "state" });
  }
  if (state?.muted) ctx.log("info", "Microphone muted");
  if (avatarCamera(ctx)) {
    // One check (and at most one click), no waiting: the recorder starts only after this
    // returns. The sampler confirms the camera and reads the speaker choice (ensureAudio).
    await ensureVideo(ctx, { warn: false });
  } else {
    const video = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "videoOff" });
    if (video?.clicked) ctx.log("info", "Camera stopped");
  }
  const swept = await tryOp(ctx, zoomFrame(ctx.page), { op: "sweep" });
  if (swept?.length) ctx.log("info", "Dismissed popups", { clicked: swept });
}

/**
 * The avatar camera while recording (each audio check; the sampler waits, so
 * nothing here pauses): one camera check until it is on or VIDEO_GRACE_MS
 * after joining (then a warning if it never came on), and Zoom's speaker
 * choice every SPEAKER_CHECK_MS.
 */
export async function avatarChecks(ctx) {
  const st = ctx.adapterState;
  const now = Date.now();
  if (st.videoOn === undefined && !st.videoWarned) {
    if (now - (ctx.joinedAt ?? now) < VIDEO_GRACE_MS) await ensureVideo(ctx, { warn: false });
    else warnCameraNotOn(ctx, st.videoLast ?? null);
  }
  if (now - (st.speakerCheckedAt ?? -Infinity) >= SPEAKER_CHECK_MS) {
    st.speakerCheckedAt = now;
    await checkSpeaker(ctx);
  }
}

/**
 * Keep computer audio joined while recording (every few seconds). Zoom may
 * offer it only after afterAdmission gave up, or drop it mid-meeting (network,
 * webinar promotion, breakout rooms); the popup sweep leaves the audio dialog
 * to this op. Returns { joined, needsJoin }, or null when the page did not answer.
 */
export async function ensureAudio(ctx) {
  const st = ctx.adapterState;
  if (avatarCamera(ctx)) await avatarChecks(ctx);
  const frame = zoomFrame(ctx.page);
  const state = await tryOp(ctx, frame, { op: "audio", action: "join" }, 4_000);
  if (state === null) return null;
  if (state.joined) {
    if (st.audioJoined === false) ctx.log("info", "Computer audio joined", { label: state.label });
    st.audioJoined = true;
    if (!state.muted) {
      const muted = await tryOp(ctx, frame, { op: "audio", action: "mute" }, 4_000);
      if (muted?.clicked) ctx.log("info", "Muted the microphone");
    }
    return { joined: true, needsJoin: false };
  }
  // Only a visible "Join Audio" means it is really off (webinar attendees may have no audio button).
  const needsJoin = !!state.clicked || /join audio|^audio$/.test(state.label);
  if (needsJoin && st.audioJoined !== false) ctx.log("warn", "Computer audio is not joined; joining it again", { label: state.label });
  if (state.clicked) ctx.log("info", "Joining computer audio", { via: state.clicked, label: state.label });
  if (needsJoin) st.audioJoined = false;
  return { joined: false, needsJoin };
}

/** The audio menu op ("open" | "close" | "leave" | "speaker"), null when the page did not answer. */
const audioMenu = (ctx, action) => tryOp(ctx, zoomFrame(ctx.page), { op: "audioMenu", action }, 4_000);

/** Open the "More audio controls" menu, run `action` in it, and close it again when it stayed open. */
async function inAudioMenu(ctx, action) {
  const opened = await audioMenu(ctx, "open");
  if (!opened?.toggle) return { opened, result: null };
  await sleep(opened.wasOpen ? 100 : 500);
  const result = await audioMenu(ctx, action);
  await sleep(300);
  await audioMenu(ctx, "close");
  return { opened, result };
}

/**
 * Deaf-bot recovery (DESIGN §6.8), step "rejoin_audio": make Zoom play to the
 * default output (the only one that is recorded), then "More audio controls"
 * → "Leave Computer Audio" and join computer audio again through the regular
 * audio join op, and mute. Only the audio menu and the audio button are
 * pressed, never Leave/End. The recording keeps running. Other steps
 * (the page reload) are the runner's. Returns {ok, detail, ...}.
 */
export async function recoverAudio(ctx, step) {
  if (step !== "rejoin_audio") return { ok: false, detail: `unsupported step ${step}` };
  const st = ctx.adapterState;
  // Reveal the auto-hidden footer (its menu is not clickable while hidden).
  await ctx.page.mouse.move(640, 300).catch(() => {});
  await ctx.page.mouse.move(640, 690).catch(() => {});

  // ctx.signal also fires when the runner calls an overrunning step off: every wait and loop
  // below watches it, so nothing keeps clicking after the step has returned. A step called off
  // between leaving and rejoining leaves audioJoined false: ensureAudio joins (and mutes) again.
  st.speakerCheckedAt = Date.now();
  const speakerBefore = await checkSpeaker(ctx);
  let speaker = null;
  if (!ctx.signal.aborted && speakerBefore !== null && speakerBefore !== "" && speakerBefore !== "default") {
    const { result } = await inAudioMenu(ctx, "speaker");
    speaker = result?.clicked ?? (result?.already ? "already default" : null);
    ctx.log(result?.clicked ? "info" : "warn", result?.clicked ? `Picked the default speaker in Zoom's audio menu: ${result.clicked}` : "Could not pick the default speaker in Zoom's audio menu", {
      before: speakerBefore,
      items: result?.items ?? null,
    });
    await sleepUnless(800, ctx.signal);
  }

  let left = null;
  let items = null;
  for (let attempt = 0; attempt < 2 && left === null && !ctx.signal.aborted; attempt += 1) {
    const { opened, result } = await inAudioMenu(ctx, "leave");
    if (!opened?.toggle) break;
    items = result?.items ?? opened.items ?? null;
    left = result?.clicked ?? null;
  }
  if (left === null) {
    ctx.log("warn", "Could not find \"Leave Computer Audio\" in Zoom's audio menu", { items });
  } else {
    ctx.log("info", "Left computer audio (deaf-bot recovery)", { via: left });
    for (let i = 0; i < 10 && !ctx.signal.aborted; i += 1) {
      const state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "state" }, 3_000);
      if (state && !state.joined) break;
      await sleepUnless(400, ctx.signal);
    }
    st.audioJoined = false;
    await sleepUnless(1_000, ctx.signal);
  }

  let state = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !ctx.signal.aborted) {
    state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "join" }, 4_000);
    if (state?.joined) break;
    if (state?.clicked) ctx.log("info", "Joining computer audio", { via: state.clicked, label: state.label });
    await sleepUnless(1_200, ctx.signal);
  }
  // Re-mute even when called off (once then): the bot must not stay unmuted.
  for (let i = 0; i < (ctx.signal.aborted ? 1 : 5) && state?.joined && !state.muted; i += 1) {
    state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "mute" }, 4_000);
    if (state?.muted || ctx.signal.aborted) break;
    await sleepUnless(800, ctx.signal);
    state = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "state" }, 4_000);
  }
  st.audioJoined = !!state?.joined;
  ctx.log(state?.joined ? "info" : "warn", state?.joined ? "Computer audio joined again" : "Computer audio did not come back", { label: state?.label ?? null, muted: !!state?.muted });
  const parts = [left === null ? "no Leave Computer Audio item" : "left computer audio", state?.joined ? "joined it again" : "could not join it again"];
  if (speaker !== null) parts.unshift(`speaker: ${speaker}`);
  return { ok: left !== null && !!state?.joined, detail: parts.join("; "), left, joined: !!state?.joined, muted: !!state?.muted, speaker: speakerBefore };
}

/** One sampling tick: raw signals + roster + end markers. */
export async function sampleMeeting(ctx) {
  const st = ctx.adapterState;
  const frame = zoomFrame(ctx.page);
  const s = await pageOp(frame, { op: "sample", sel: ctx.selectors }, 4_000);
  const now = Date.now();
  let ended = s.ended;
  if (!ended) {
    if (st.meetingOrigin === undefined) {
      try {
        const u = new URL(s.url);
        st.meetingOrigin = u.origin;
        st.meetingRoot = u.pathname.split("/").filter(Boolean)[0] ?? "";
      } catch {
        st.meetingOrigin = null;
      }
    }
    if (s.leave) st.leaveMissingSince = null;
    else st.leaveMissingSince ??= now;
    const sinceJoin = now - (ctx.joinedAt ?? now);
    if (st.leaveMissingSince !== null && now - st.leaveMissingSince >= 6_000 && sinceJoin > 20_000) {
      ended = { reason: "meeting_ended", message: "The meeting controls disappeared (Leave button gone)" };
    } else if (/^error - zoom$/i.test(s.title)) {
      ended = { reason: "meeting_ended", message: "Zoom showed an error page" };
    } else if (st.meetingOrigin) {
      try {
        const u = new URL(s.url);
        const root = u.pathname.split("/").filter(Boolean)[0] ?? "";
        if (u.origin !== st.meetingOrigin || root !== st.meetingRoot) {
          ended = { reason: "meeting_ended", message: `The page left the meeting (${u.origin}${u.pathname})` };
        }
      } catch {
        // about:blank and friends while navigating
      }
    }
  }
  const store = s.store;
  const tileNames = s.tile?.all ?? [];
  return {
    signals: {
      store: store ? store.speakers : null,
      tile: tileNames.length > 0 || (s.tile?.active?.length ?? 0) > 0 ? s.tile.active : null,
      tracks: s.tracks ?? [],
    },
    roster: store && store.names.length > 0 ? store.names : tileNames.length > 0 ? tileNames : null,
    count: s.count ?? (store ? store.count : null),
    ended,
    raw: {
      asn: store?.asn ?? null,
      asnUser: store?.asnUser ?? null,
      hasAsn: store?.hasAsn ?? null,
      lastSpoken: store?.lastSpoken ?? null,
      storeCount: store?.count ?? null,
      footerCount: s.count,
      tier: s.tile?.tier ?? null,
      self: store?.self ?? null,
    },
  };
}

/** Dismiss harmless popups (every few seconds while in the meeting). */
export async function sweepPopups(ctx) {
  const clicked = await tryOp(ctx, zoomFrame(ctx.page), { op: "sweep" });
  if (clicked?.length) ctx.log("info", "Dismissed popups", { clicked });
  return clicked ?? [];
}

/** Post a chat message to everyone (research chat): open the panel, focus the editor, insertText, Enter. */
export async function sendChat(ctx, text) {
  const frame = zoomFrame(ctx.page);
  const opened = await pageOp(frame, { op: "chat", step: "open" });
  if (!opened) throw new Error("chat button not found");
  let focused = null;
  for (let i = 0; i < 12 && !focused; i += 1) {
    await sleep(400);
    focused = await tryOp(ctx, frame, { op: "chat", step: "focus" });
  }
  if (!focused) throw new Error("chat editor not found");
  // One ProseMirror transaction; per-key typing drops characters.
  await ctx.page.keyboard.insertText(text);
  await sleep(300);
  await ctx.page.keyboard.press("Enter");
  let check = null;
  for (let i = 0; i < 8 && !check?.inList; i += 1) {
    await sleep(400);
    check = await tryOp(ctx, frame, { op: "chat", step: "check", text });
  }
  if (opened === "opened") await tryOp(ctx, frame, { op: "chat", step: "close" });
  if (!check?.inList && !check?.editorEmpty) throw new Error("the message did not show up in the chat");
  return { verified: !!check?.inList };
}

/** Leave politely: Leave → "Leave Meeting" (never "End Meeting for All"), wait for WebRTC to hang up, then about:blank. */
export async function leaveMeeting(ctx) {
  const frame = zoomFrame(ctx.page);
  await tryOp(ctx, frame, { op: "sweep" }, 3_000);
  const opened = await tryOp(ctx, frame, { op: "leave", step: "open", sel: ctx.selectors }, 3_000);
  let confirmed = null;
  for (let i = 0; i < 6 && opened && !confirmed; i += 1) {
    await sleep(250);
    confirmed = await tryOp(ctx, frame, { op: "leave", step: "confirm", sel: ctx.selectors }, 2_000);
  }
  if (opened && !confirmed) {
    // Reveal the auto-hidden footer and use a trusted click.
    await ctx.page.mouse.move(640, 300).catch(() => {});
    await ctx.page.mouse.move(640, 690).catch(() => {});
    await frame.locator(ctx.selectors.leave.join(", ")).first().click({ timeout: 2_000, force: true }).catch(() => {});
    for (let i = 0; i < 6 && !confirmed; i += 1) {
      await sleep(250);
      confirmed = await tryOp(ctx, frame, { op: "leave", step: "confirm", sel: ctx.selectors }, 2_000);
    }
  }
  ctx.log(confirmed ? "info" : "warn", confirmed ? "Left the meeting" : "Leave confirmation not found; closing the page", { opened, confirmed });
  await sleep(confirmed ? 2_500 : 500);
  await ctx.page.goto("about:blank", { timeout: 5_000 }).catch(() => {});
}

export default {
  name: "zoom",
  join: (ctx) => joinFlow(ctx, {}),
  sample: sampleMeeting,
  sweep: sweepPopups,
  ensureAudio,
  recoverAudio,
  sendChat,
  leave: leaveMeeting,
};
