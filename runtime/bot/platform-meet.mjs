// Google Meet web-client adapter (meet.google.com).
// Unified with the Zoom/Telemost bot-runner contract:
//   join(ctx), sample(ctx), sweep(ctx), ensureAudio(ctx), recoverAudio(ctx, step), sendChat(ctx, text), leave(ctx).
import { recoverPageAudio } from "./lib/audio-recovery.mjs";
import { BotError, StopRequested, sleep, sleepUnless } from "./lib/proc.mjs";
import { classifyMeetPage, MEET_ERRORS } from "./lib/meet-state.mjs";

const avatarCamera = (ctx) => ctx.camera === "avatar";
// Always add this connection. Transferring the call would evict another worker
// sharing the service account, including one owned by a different portal user.
const JOIN_BUTTON = /^(?:add_to_queue\s*)?(ask to join|join now|join here too|join on this device too|присоединиться|подать заявку на участие|войти сейчас|присоединиться и здесь|подключиться также на этом устройстве)$/i;
const TRANSFER_BUTTON = /^(switch here|switch to this device|переключиться на это устройство|переключиться без использования микрофона и камеры)$/i;

export const MEET_OP = `((args) => {
  const vis = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const txt = (el) => (el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() : "");
  const attr = (el, k) => (el ? (el.getAttribute(k) || "").trim() : "");

  const findBtn = (matchers) => {
    const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const m of matchers) {
      for (const el of nodes) {
        if (!vis(el)) continue;
        const t = txt(el).toLowerCase();
        const al = attr(el, "aria-label").toLowerCase();
        const tid = attr(el, "data-testid").toLowerCase();
        if (m({ el, t, al, tid })) return el;
      }
    }
    return null;
  };

  if (args.op === "probe") {
    const bodyText = (document.body ? document.body.innerText || "" : "").replace(/\\s+/g, " ").trim();

    const pageState = location.hostname === "accounts.google.com"
      ? "auth_required" : (${classifyMeetPage.toString()})(bodyText);

    const continueNoMediaBtn = findBtn([
      ({ t, al }) => /continue without microphone|продолжить без микрофона/i.test(t + " " + al),
    ]);

    const nameInput = Array.from(document.querySelectorAll("input[type='text'], input[placeholder*='name' i], input[aria-label*='name' i], input[placeholder*='имя' i], input[aria-label*='имя' i]"))
      .find((el) => vis(el) && !el.disabled && !el.readOnly);

    const joinBtn = findBtn([
      ({ t, al }) => (${JOIN_BUTTON.toString()}).test(t) || (${JOIN_BUTTON.toString()}).test(al),
    ]);

    const leaveBtn = findBtn([
      ({ al, t }) => /leave call|покинуть (?:видео)?встречу|завершить звонок/i.test(al + " " + t),
    ]);
    const transferBtn = findBtn([({ t, al }) => (${TRANSFER_BUTTON.toString()}).test(t) || (${TRANSFER_BUTTON.toString()}).test(al)]);
    const otherWaysBtn = findBtn([({ t, al }) => /other ways to join|другие способы присоединиться/i.test(t + " " + al)]);

    const inMeeting = Boolean(leaveBtn && !joinBtn && !transferBtn && !pageState);

    // Extract participants & active speakers from Meet participant tiles
    const names = new Set();
    const active = new Set();
    const participantIds = new Set();
    const tiles = document.querySelectorAll("[data-participant-id], [data-requested-participant-id]");
    for (const tile of tiles) {
      if (!vis(tile)) continue;
      const id = attr(tile, "data-participant-id") || attr(tile, "data-requested-participant-id");
      participantIds.add(id);
      // Account names can differ from the configured bot name. The local tile
      // exposes self-view controls; exclude it by identity, not a name guess.
      const isSelf = attr(tile, "data-is-self") === "true" || Array.from(tile.querySelectorAll("button[aria-label]")).some(el => /show (?:my|your) (?:video|tile)|hide (?:my|your) (?:video|tile)|показать мою картинку|скрыть мою картинку/i.test(attr(el, "aria-label")));
      if (isSelf) continue;
      let rawName = "";
      // Parent divs contain both the visible name and its tooltip, producing
      // "Name Name". Read only the actual text badge and skip icon glyphs.
      const nameBadges = tile.querySelectorAll("[data-self-name], span.notranslate:not([aria-hidden='true'])");
      for (const b of nameBadges) {
        if (!vis(b)) continue;
        const bt = txt(b);
        if (bt && bt.length >= 2 && bt.length <= 50 && !/^(you|вы|mute|unmute|pin|more options|микрофон|камера)$/i.test(bt) && !bt.includes("\\n")) {
          rawName = bt;
          break;
        }
      }
      if (!rawName) continue;
      names.add(rawName);
      // Google Meet renders a 3-bar sound wave indicator inside the tile when a participant is speaking
      const indicators = tile.querySelectorAll("[aria-label*='speaking' i], [aria-label*='говорит' i]");
      const isSpeaking = Array.from(indicators).some(vis);
      if (isSpeaking) active.add(rawName);
    }

    const tracksKey = Symbol.for("mtg.audio");
    const tracks = window[tracksKey] && typeof window[tracksKey].levels === "function" ? window[tracksKey].levels() : [];
    // In a two-person call, measured remote audio can only be the one remote
    // participant. Never apply this to a larger or incompletely visible room.
    if (participantIds.size === 2 && names.size === 1 && tracks.some(t => Number(t.lvl ?? t.level ?? 0) > 0.012)) {
      active.add(Array.from(names)[0]);
    }

    return {
      url: location.href,
      title: document.title || "",
      text: bodyText.slice(0, 400),
      pageState: inMeeting ? null : pageState,
      ended: pageState === "meeting_ended" && !inMeeting,
      waitingRoom: pageState === "waiting_room" && !inMeeting,
      hasContinueNoMedia: Boolean(continueNoMediaBtn),
      hasNameInput: Boolean(nameInput),
      nameValue: nameInput ? nameInput.value || "" : "",
      hasJoinBtn: Boolean(joinBtn),
      hasTransferBtn: Boolean(transferBtn),
      hasOtherWaysBtn: Boolean(otherWaysBtn),
      joinDisabled: joinBtn ? Boolean(joinBtn.disabled || attr(joinBtn, "aria-disabled") === "true") : false,
      inMeeting,
      hasLeaveBtn: Boolean(leaveBtn),
      names: Array.from(names),
      active: Array.from(active),
      count: participantIds.size || null,
      tracks,
    };
  }

  if (args.op === "clickContinueNoMedia") {
    const btn = findBtn([
      ({ t, al }) => /continue without microphone|продолжить без микрофона/i.test(t + " " + al),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  if (args.op === "setMedia") {
    const actions = [];
    const micOffBtn = findBtn([
      ({ al }) => /turn off microphone|выключить микрофон/i.test(al),
      ({ el }) => attr(el, "data-is-muted") === "false" && /microphone|микрофон/i.test(attr(el, "aria-label")),
    ]);
    if (args.muteMic && micOffBtn) {
      micOffBtn.click();
      actions.push("muted_mic");
    }
    if (args.wantCamera) {
      const camOnBtn = findBtn([
        ({ al }) => /turn on camera|включить камеру/i.test(al),
        ({ el }) => attr(el, "data-is-muted") === "true" && /camera|камер/i.test(attr(el, "aria-label")),
      ]);
      if (camOnBtn) {
        camOnBtn.click();
        actions.push("enabled_cam");
      }
    } else {
      const camOffBtn = findBtn([
        ({ al }) => /turn off camera|выключить камеру/i.test(al),
        ({ el }) => attr(el, "data-is-muted") === "false" && /camera|камер/i.test(attr(el, "aria-label")),
      ]);
      if (camOffBtn) {
        camOffBtn.click();
        actions.push("disabled_cam");
      }
    }
    return { actions };
  }

  if (args.op === "clickJoin") {
    const btn = findBtn([
      ({ t, al }) => (${JOIN_BUTTON.toString()}).test(t) || (${JOIN_BUTTON.toString()}).test(al),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true, text: txt(btn) };
    }
    return { clicked: false };
  }

  if (args.op === "sweep") {
    const dismissed = [];
    const btn = findBtn([
      ({ t }) => /^(got it|dismiss|close|понятно|закрыть|ок)$/i.test(t),
    ]);
    if (btn) {
      btn.click();
      dismissed.push(txt(btn) || "popup");
    }
    for (const el of document.querySelectorAll("audio, video")) {
      if (el.paused) el.play().catch(() => {});
    }
    return dismissed;
  }

  if (args.op === "leave") {
    const btn = findBtn([
      ({ al, t }) => /leave call|покинуть (?:видео)?встречу|завершить звонок/i.test(al + " " + t),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  return null;
})`;

async function evalOp(page, args, timeoutMs = 6000) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(`${MEET_OP}(${JSON.stringify(args)})`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`meet op ${args.op} timed out`)), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fillGuestName(page, botName) {
  try {
    const input = page
      .locator("input[placeholder*='name' i], input[aria-label*='name' i], input[placeholder*='имя' i], input[aria-label*='имя' i], input[type='text']")
      .first();
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
      await input.click({ timeout: 2000 });
      await page.keyboard.press("Control+KeyA");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(botName);
      return (await input.inputValue()).trim() === botName.trim();
    }
  } catch {}
  return false;
}

export async function joinFlow(ctx) {
  const { page, context, config, signal, log, setPhase } = ctx;
  const url = config.joinUrl;

  await context.grantPermissions(["microphone", "camera"], { origin: "https://meet.google.com" }).catch(() => {});

  setPhase("joining", "Открытие ссылки Google Meet");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (err) {
    if (signal.aborted) throw new StopRequested();
    log("warn", "Google Meet navigation warning", { error: err.message });
  }

  const startMs = Date.now();
  const maxWaitMs = Math.max(180_000, (config.waitingTimeoutSec || 600) * 1000);
  let lastJoinClick = 0;
  let joinClicks = 0;

  while (Date.now() - startMs < maxWaitMs) {
    if (signal.aborted) throw new StopRequested();

    const p = await evalOp(page, { op: "probe" });
    if (!p) {
      await sleepUnless(1500, signal);
      continue;
    }

    if (p.inMeeting) {
      log("info", "Admitted to Google Meet call", { url: p.url, participants: p.names });
      await evalOp(page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });
      return;
    }

    if (p.pageState && MEET_ERRORS[p.pageState]) {
      throw new BotError(p.pageState, MEET_ERRORS[p.pageState]);
    }

    if (p.waitingRoom) {
      setPhase("waiting_room", "Ожидание подтверждения входа организатором в Google Meet (Ask to join)");
      await sleepUnless(2000, signal);
      continue;
    }

    if (p.hasContinueNoMedia) {
      await evalOp(page, { op: "clickContinueNoMedia" });
      await sleepUnless(1000, signal);
    }

    // First-use tips can cover the join/transfer button on signed-in accounts.
    await evalOp(page, { op: "sweep" });
    await evalOp(page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });

    if (p.hasTransferBtn && !p.hasJoinBtn && p.hasOtherWaysBtn) {
      const menu = page.getByRole("button", { name: /^(other ways to join|другие способы присоединиться)$/i }).first();
      await menu.click({ timeout: 2500 }).catch(() => {});
      await sleepUnless(700, signal);
      continue;
    }

    if (p.hasNameInput && p.nameValue.trim() !== config.botName.trim()) {
      const typed = await fillGuestName(page, config.botName);
      log("info", "Typed bot name in Google Meet pre-join", { name: config.botName, typed });
      await sleepUnless(800, signal);
      if (!typed) continue;
    }

    if (p.hasJoinBtn && !p.joinDisabled && Date.now() - lastJoinClick > 6000) {
      // Use a real browser input event so Meet's pre-join form submits normally.
      const button = page.getByRole("button", { name: JOIN_BUTTON }).first();
      const clicked = await button.click({ timeout: 2500 }).then(() => true, () => false);
      const res = { clicked };
      if (!clicked) { await sleepUnless(1000, signal); continue; }
      lastJoinClick = Date.now();
      joinClicks += 1;
      log("info", "Clicked Ask to join / Join now in Google Meet", { attempt: joinClicks, res });
      setPhase("joining", "Запрос на подключение к Google Meet отправлен...");
    }

    await sleepUnless(1800, signal);
  }

  throw new BotError("waiting_timeout", MEET_ERRORS.waiting_timeout);
}

export async function sampleMeeting(ctx) {
  const p = await evalOp(ctx.page, { op: "probe" });
  const now = Date.now();
  const st = ctx.adapterState;

  if (!p) {
    return {
      signals: { store: null, tile: null, tracks: [] },
      roster: null,
      count: null,
      ended: null,
      raw: {},
    };
  }

  let ended = null;
  if (p.ended) {
    ended = { reason: "meeting_ended", message: "Google Meet: встреча завершена" };
  } else if (!p.hasLeaveBtn && !p.inMeeting) {
    st.leaveMissingSince ??= now;
    if (now - st.leaveMissingSince > 10_000 && now - (ctx.joinedAt ?? now) > 20_000) {
      ended = { reason: "meeting_ended", message: "Панель управления Google Meet закрылась" };
    }
  } else {
    st.leaveMissingSince = null;
  }

  const names = Array.isArray(p.names) ? p.names : [];
  const active = Array.isArray(p.active) ? p.active : [];

  return {
    signals: {
      store: active.length > 0 ? active : null,
      tile: active.length > 0 ? active : null,
      tracks: Array.isArray(p.tracks) ? p.tracks : [],
    },
    roster: names.length > 0 ? names : null,
    count: p.count ?? null,
    ended,
    raw: { platform: "meet", active, count: p.count ?? null },
  };
}

export async function sweepPopups(ctx) {
  return (await evalOp(ctx.page, { op: "sweep" })) || [];
}

export async function ensureAudio(ctx) {
  await evalOp(ctx.page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });
  await evalOp(ctx.page, { op: "sweep" });
  return { joined: true, needsJoin: false };
}

export async function sendChat(ctx, text) {
  try {
    const chatBtn = ctx.page.locator("button[aria-label*='Chat with everyone' i], button[aria-label*='чат' i]").first();
    if (await chatBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await chatBtn.click();
      await sleep(500);
      const input = ctx.page.locator("textarea[aria-label*='Send a message' i], textarea[placeholder*='message' i], textarea").first();
      if (await input.isVisible({ timeout: 2500 }).catch(() => false)) {
        await input.click();
        await ctx.page.keyboard.insertText(text);
        await sleep(200);
        await ctx.page.keyboard.press("Enter");
        return { verified: true };
      }
    }
  } catch {}
  return { verified: false };
}

export async function leaveMeeting(ctx) {
  await evalOp(ctx.page, { op: "leave" });
  await sleep(500);
  await ctx.page.goto("about:blank", { timeout: 4000 }).catch(() => {});
}

export default {
  name: "meet",
  join: joinFlow,
  sample: sampleMeeting,
  sweep: sweepPopups,
  ensureAudio,
  recoverAudio: recoverPageAudio,
  sendChat,
  leave: leaveMeeting,
};
