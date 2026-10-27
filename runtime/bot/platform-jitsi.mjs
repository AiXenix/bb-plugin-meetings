// Jitsi Meet web-client adapter (meet.jit.si / self-hosted Jitsi).
// Unified with the Zoom/Meet/Telemost bot-runner contract.
import { recoverPageAudio } from "./lib/audio-recovery.mjs";
import { BotError, StopRequested, sleep, sleepUnless } from "./lib/proc.mjs";

const avatarCamera = (ctx) => ctx.camera === "avatar";

export const JITSI_OP = `((args) => {
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
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], a"));
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
    const endedRe = /you have been disconnected|meeting has ended|вы отключились|встреча завершена/i;

    const nameInput = Array.from(document.querySelectorAll("input[placeholder*='name' i], input[placeholder*='имя' i], input[data-testid*='prejoin.input'], input[type='text']"))
      .find((el) => vis(el) && !el.disabled && !el.readOnly);

    const joinBtn = findBtn([
      ({ tid }) => tid === "prejoin.joinmeeting",
      ({ t, al }) => /^(join meeting|присоединиться к встрече|войти во встречу|join in browser|продолжить в браузере)$/i.test(t) || /join meeting/i.test(al),
    ]);

    const leaveBtn = findBtn([
      ({ al, tid }) => /leave the meeting|hangup|покинуть встречу|завершить/i.test(al + " " + tid),
    ]);

    const inMeeting = Boolean(leaveBtn && !joinBtn);

    const names = new Set();
    const active = new Set();
    for (const tile of document.querySelectorAll(".videocontainer, [id^='participant_'], [class*='tile-view']")) {
      if (!vis(tile)) continue;
      const nm = txt(tile.querySelector(".displayname, [class*='displayName'], [data-testid*='name']"));
      if (nm && nm.length >= 2 && nm.length <= 50) {
        names.add(nm);
        if (tile.classList.contains("dominant-speaker") || tile.querySelector(".dominant-speaker, [class*='active-speaker']")) {
          active.add(nm);
        }
      }
    }

    const tracksKey = Symbol.for("mtg.audio");
    const tracks = window[tracksKey] && typeof window[tracksKey].levels === "function" ? window[tracksKey].levels() : [];

    return {
      url: location.href,
      ended: endedRe.test(bodyText) && !inMeeting,
      hasNameInput: Boolean(nameInput),
      nameValue: nameInput ? nameInput.value || "" : "",
      hasJoinBtn: Boolean(joinBtn),
      inMeeting,
      hasLeaveBtn: Boolean(leaveBtn),
      names: Array.from(names),
      active: Array.from(active),
      tracks,
    };
  }

  if (args.op === "clickJoin") {
    const btn = findBtn([
      ({ tid }) => tid === "prejoin.joinmeeting",
      ({ t, al }) => /^(join meeting|присоединиться к встрече|войти во встречу|join in browser|продолжить в браузере)$/i.test(t) || /join meeting/i.test(al),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  if (args.op === "leave") {
    const btn = findBtn([
      ({ al, tid }) => /leave the meeting|hangup|покинуть встречу|завершить/i.test(al + " " + tid),
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
      page.evaluate(`${JITSI_OP}(${JSON.stringify(args)})`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`jitsi op ${args.op} timed out`)), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function joinFlow(ctx) {
  const { page, config, signal, log, setPhase } = ctx;
  const raw = new URL(config.joinUrl);
  raw.hash = `config.prejoinConfig.enabled=false&config.startWithAudioMuted=true&config.startWithVideoMuted=${!avatarCamera(ctx)}&userInfo.displayName=${encodeURIComponent(JSON.stringify(config.botName))}`;

  setPhase("joining", "Открытие ссылки Jitsi Meet");
  await page.goto(raw.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});

  const startMs = Date.now();
  while (Date.now() - startMs < 120_000) {
    if (signal.aborted) throw new StopRequested();
    const p = await evalOp(page, { op: "probe" });
    if (p?.inMeeting) {
      log("info", "Admitted to Jitsi Meet", { url: p.url });
      return;
    }
    if (p?.hasNameInput && p.nameValue.trim() !== config.botName.trim()) {
      const input = page.locator("input[type='text']").first();
      if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
        await input.fill(config.botName).catch(() => {});
      }
    }
    if (p?.hasJoinBtn) {
      await evalOp(page, { op: "clickJoin" });
    }
    await sleepUnless(1500, signal);
  }
  throw new BotError("join_failed", "Превышено время ожидания входа в Jitsi Meet");
}

export async function sampleMeeting(ctx) {
  const p = await evalOp(ctx.page, { op: "probe" });
  if (!p) return { signals: { store: null, tile: null, tracks: [] }, roster: null, count: null, ended: null, raw: {} };
  const names = Array.isArray(p.names) ? p.names : [];
  const active = Array.isArray(p.active) ? p.active : [];
  return {
    signals: { store: active.length ? active : null, tile: active.length ? active : null, tracks: p.tracks || [] },
    roster: names.length ? names : null,
    count: names.length ? names.length + 1 : null,
    ended: p.ended ? { reason: "meeting_ended", message: "Jitsi: встреча завершена" } : null,
    raw: { platform: "jitsi", active, count: names.length },
  };
}

export default {
  name: "jitsi",
  join: joinFlow,
  sample: sampleMeeting,
  sweep: async () => [],
  ensureAudio: async () => ({ joined: true, needsJoin: false }),
  recoverAudio: recoverPageAudio,
  sendChat: async () => ({ verified: false }),
  leave: async (ctx) => {
    await evalOp(ctx.page, { op: "leave" });
    await sleep(500);
    await ctx.page.goto("about:blank", { timeout: 3000 }).catch(() => {});
  },
};
