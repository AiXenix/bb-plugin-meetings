// Zoom web-client adapter (docs/dev/DESIGN.md §6.2, docs/dev/research-zoom.md
// joinFlow / stateMarkers / leaveFlow / participants / activeSpeaker / chat).
// DOM work happens in page/zoom-page.js; this file drives it with trusted
// Playwright input where Zoom needs real events (name keystrokes, Join).
import fs from "node:fs";
import { xdotoolKey } from "./lib/av.mjs";
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
  const url = config.joinUrl;
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
        if (!config.zoomProfileDir) await ctx.context.clearCookies().catch(() => {});
        await sleepUnless(5_000 + Math.random() * 5_000, signal);
        if (signal.aborted) throw new StopRequested();
        nameDone = false;
        previewDone = false;
        passcodeDone = false;
        joinClicks = 0;
        lastJoinAt = 0;
        joinClickedAt = null;
        await gotoMeeting(ctx, url);
        lastGoto = Date.now();
        progress();
        continue;
      }
      throw new BotError(
        "bot_blocked",
        'Zoom blocked the guest bot ("Automated bots aren\'t allowed to join this meeting"). Sign the bot in to a Zoom account (bb meetings zoom-login) or ask the host to allow it',
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
      throw new BotError("auth_required", "The meeting requires signed-in Zoom users: sign the bot in (bb meetings zoom-login) and enable useZoomAccount");
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
        continue; // re-read the form: the Join button enables ~1 s after a valid name
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
      await gotoMeeting(ctx, url);
      lastGoto = Date.now();
    }
    await sleepUnless(2_000, signal);
  }

  await afterAdmission(ctx);
}

/** Mute the mic and stop the camera on the pre-join screen. */
async function previewDevices(ctx, frame, prejoin) {
  if (prejoin.mic && /^mute$/i.test(prejoin.mic)) {
    await frame.locator("#preview-audio-control-button").click({ timeout: 3_000 }).catch(() => tryOp(ctx, frame, { op: "click", selectors: ["#preview-audio-control-button"] }));
    ctx.log("info", "Muted the microphone in the preview");
  }
  if (prejoin.video && /^stop video$/i.test(prejoin.video)) {
    await frame.locator("#preview-video-control-button").click({ timeout: 3_000 }).catch(() => tryOp(ctx, frame, { op: "click", selectors: ["#preview-video-control-button"] }));
    ctx.log("info", "Stopped the camera in the preview");
  }
}

/** After admission: make sure computer audio is joined (else nothing is recorded), re-mute, camera off, popups. */
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
  const video = await tryOp(ctx, zoomFrame(ctx.page), { op: "audio", action: "videoOff" });
  if (video?.clicked) ctx.log("info", "Camera stopped");
  const swept = await tryOp(ctx, zoomFrame(ctx.page), { op: "sweep" });
  if (swept?.length) ctx.log("info", "Dismissed popups", { clicked: swept });
}

/**
 * Keep computer audio joined while recording (every few seconds). Zoom may
 * offer it only after afterAdmission gave up, or drop it mid-meeting (network,
 * webinar promotion, breakout rooms); the popup sweep leaves the audio dialog
 * to this op. Returns { joined, needsJoin }, or null when the page did not answer.
 */
export async function ensureAudio(ctx) {
  const st = ctx.adapterState;
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
  sendChat,
  leave: leaveMeeting,
};
