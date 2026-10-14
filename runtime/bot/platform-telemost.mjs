// Yandex Telemost web-client adapter (telemost.yandex.ru / telemost.360.yandex.ru).
// Unified with the Zoom/Meet/Jitsi bot-runner contract:
//   join(ctx), sample(ctx), sweep(ctx), ensureAudio(ctx), sendChat(ctx, text), leave(ctx).
import { BotError, StopRequested, sleep, sleepUnless } from "./lib/proc.mjs";

const avatarCamera = (ctx) => ctx.camera === "avatar";

export function telemostFrame(page) {
  const frames = page.frames();
  const priv = frames.find(
    (f) => f !== page.mainFrame() && /private-join/i.test(f.url())
  );
  if (priv) return priv;
  const sub = frames.find(
    (f) => f !== page.mainFrame() && /telemost\./i.test(f.url())
  );
  return sub ?? page.mainFrame();
}

export const TELEMOST_OP = `((args) => {
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
        const cls = typeof el.className === "string" ? el.className : "";
        if (m({ el, t, al, tid, cls })) return el;
      }
    }
    return null;
  };

  if (args.op === "probe") {
    const bodyText = (document.body ? document.body.innerText || "" : "").replace(/\\s+/g, " ").trim();

    const leaveBtn = findBtn([
      ({ tid, al, t }) =>
        tid === "end-call-alt-button" ||
        tid === "participants-button" ||
        tid === "chat-alt-button" ||
        tid === "start-demonstration-button" ||
        tid === "hand-up-button" ||
        /выйти из встречи|покинуть встречу|завершить звонок|leave meeting|hang up/i.test(al + " " + t),
    ]);

    const inMeeting = Boolean(leaveBtn);

    const ended =
      !inMeeting &&
      /встреча завершена|конференция завершена|звонок завершён|вы вышли из встречи|ссылка недействительна|такой встречи нет|встреча не найдена|meeting has ended/i.test(
        bodyText
      );

    const waitingRoom =
      !inMeeting &&
      /организатор скоро|ждём разрешения|ожидание подтверждения|подождите, пока организатор|в комнате ожидания|waiting for the host|host will let you in/i.test(
        bodyText
      );

    const nameInput = Array.from(
      document.querySelectorAll(
        "input[data-testid='orb-textinput-input'], input.Orb-Textinput-input, input[placeholder*='имя' i], input[placeholder*='name' i], input[aria-label*='имя' i], input[type='text']"
      )
    ).find(vis);

    const joinBtn = findBtn([
      ({ tid, cls, t }) =>
        tid === "enter-conference-button" ||
        cls.includes("joinMeetingButton") ||
        (/^(подключиться|присоединиться|войти во встречу|продолжить в браузере|join|join meeting)$/i.test(t) &&
          !/по ссылке или номеру|к звонку/i.test(t)),
    ]);

    // Extract participant count from participants-button ("Участники 2")
    let totalParticipants = null;
    const partBtn = document.querySelector("[data-testid='participants-button']");
    if (partBtn) {
      const m = /(\\d+)/.exec(txt(partBtn));
      if (m) totalParticipants = Number(m[1]);
    }

    // Extract participant names & active speaker
    const names = [];
    const active = [];
    const seen = new Set();
    const botNameLower = (args.botName || "").toLowerCase().trim();
    const isNoise = (n) =>
      !n ||
      n.length < 2 ||
      n.length > 60 ||
      /^(вы|you|гость|guest|демонстрация|участники.*|чат|ещё|подключиться.*|выйти.*|13.*|\\+1 тб|яндекс.*|телемост.*|частые вопросы.*|тариф.*)$/i.test(
        n
      ) ||
      (botNameLower && (n.toLowerCase() === botNameLower || n.toLowerCase().includes(botNameLower) || botNameLower.includes(n.toLowerCase())));

    // Check participant tiles in Telemost
    const placeholders = Array.from(
      document.querySelectorAll(
        "[data-testid='participant-video-placeholder'], [data-testid*='participant' i], [class*='Participant' i], [class*='VideoItem' i]"
      )
    );
    // The current Telemost 360 client renders the display name in a titled
    // badge. Read badges separately so multiple names never become one string.
    for (const badge of document.querySelectorAll("[class*='TextName_'][title], [data-testid='participant-name']")) {
      if (!vis(badge)) continue;
      const candidate = attr(badge, "title") || txt(badge);
      if (isNoise(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      names.push(candidate);
      const tile = badge.closest("[class*='newGridItem_'], [class*='Participant']") || badge.parentElement;
      if (tile && (/speaking|talking/i.test(tile.className) || tile.querySelector("[aria-label*='speaking' i], [aria-label*='говорит' i]"))) active.push(candidate);
    }
    for (const ph of placeholders) {
      if (document.querySelector("[class*='TextName_'][title], [data-testid='participant-name']")) break;
      const card = ph.closest("[class*='tile' i], [class*='item' i], [class*='cell' i], [class*='video' i]") || ph.parentElement || ph;
      const candidate = txt(card);
      if (!isNoise(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        names.push(candidate);
        const cls = (typeof card.className === "string" ? card.className : "") + " " + (typeof ph.className === "string" ? ph.className : "");
        if (/speaking|talking/i.test(cls)) {
          active.push(candidate);
        }
      }
    }

    // Also check bodyText before "Демонстрация" toolbar in Telemost conference view
    if (inMeeting && names.length === 0) {
      const toolbarIdx = bodyText.indexOf("Демонстрация");
      if (toolbarIdx > 0) {
        let headerChunk = bodyText
          .slice(0, toolbarIdx)
          .replace(/^13\\s*\\+1\\s*ТБ\\s*/i, "")
          .trim();
        if (args.botName) {
          headerChunk = headerChunk.split(args.botName).join(" ").replace(/\\s+/g, " ").trim();
        }
        if (!isNoise(headerChunk) && !seen.has(headerChunk)) {
          seen.add(headerChunk);
          names.push(headerChunk);
        }
      }
    }

    // The shared fusion engine consumes remote-track RMS samples, not labels.
    // A lone participant is not necessarily speaking.
    const meter = window[Symbol.for("mtg.audio")];
    const tracks = meter && typeof meter.levels === "function" ? meter.levels() : [];

    return {
      url: location.href,
      inMeeting,
      hasLeaveBtn: Boolean(leaveBtn),
      ended,
      waitingRoom,
      hasNameInput: Boolean(nameInput),
      nameValue: nameInput ? nameInput.value || "" : "",
      hasJoinBtn: Boolean(joinBtn),
      joinDisabled: joinBtn ? Boolean(joinBtn.disabled || attr(joinBtn, "aria-disabled") === "true") : false,
      names,
      active,
      totalParticipants,
      tracks,
    };
  }

  if (args.op === "setMedia") {
    const actions = [];
    if (args.muteMic) {
      const micOffBtn = findBtn([
        ({ tid, al }) =>
          tid === "turn-off-mic-button" ||
          /выключить микрофон|отключить микрофон|turn off mic|^mute(?: microphone)?$/i.test(al),
      ]);
      if (micOffBtn) {
        micOffBtn.click();
        actions.push("muted_mic");
      }
    }
    if (args.wantCamera) {
      const camOnBtn = findBtn([
        ({ tid, al }) =>
          tid === "turn-on-camera-button" ||
          /включить камеру|turn on camera|^start video$/i.test(al),
      ]);
      if (camOnBtn) {
        camOnBtn.click();
        actions.push("enabled_cam");
      }
    } else {
      const camOffBtn = findBtn([
        ({ tid, al }) =>
          tid === "turn-off-camera-button" ||
          /выключить камеру|отключить камеру|turn off camera/i.test(al),
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
      ({ tid, cls, t }) =>
        tid === "enter-conference-button" ||
        cls.includes("joinMeetingButton") ||
        (/^(подключиться|присоединиться|войти во встречу|продолжить в браузере|join|join meeting)$/i.test(t) &&
          !/по ссылке или номеру|к звонку/i.test(t)),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true, text: txt(btn) || attr(btn, "data-testid") };
    }
    return { clicked: false };
  }

  if (args.op === "sweep") {
    const dismissed = [];
    for (const el of document.querySelectorAll("audio, video")) {
      if (el.paused) el.play().catch(() => {});
    }
    return dismissed;
  }

  if (args.op === "leave") {
    const btn = findBtn([
      ({ tid, al, t }) =>
        tid === "end-call-alt-button" ||
        /выйти из встречи|покинуть встречу|завершить звонок|leave/i.test(al + " " + t),
    ]);
    if (btn) {
      btn.click();
      return { clicked: true };
    }
    return { clicked: false };
  }

  return null;
})`;

async function ensureOuterShellClean(page) {
  try {
    const hasPrivateJoin = page.frames().some((f) => /private-join/i.test(f.url()));
    if (hasPrivateJoin) {
      // If outer yamb shell has "Номер звонка или ссылка на него" dialog open, close that dialog (never the lightbox!)
      await page
        .evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[data-testid="orb-modal2"], [role="dialog"]'));
          for (const m of modals) {
            const text = (m.innerText || m.textContent || "");
            if (/Номер звонка или ссылка/i.test(text)) {
              const closeBtn = m.querySelector('[data-testid="orb-button-close"], button[aria-label="Закрыть"]');
              if (closeBtn) closeBtn.click();
            }
          }
        })
        .catch(() => {});
      return;
    }
    // If the call widget is minimized in the left sidebar, click it to reopen the lightbox
    const widget = page.locator('.yamb-call-widget__content[aria-label="Открыть экран звонка"]').first();
    if (await widget.count().catch(() => 0)) {
      await widget.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {}
}

async function evalOp(page, args, timeoutMs = 6000) {
  let timer;
  try {
    const frame = telemostFrame(page);
    return await Promise.race([
      frame.evaluate(`${TELEMOST_OP}(${JSON.stringify(args)})`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`telemost op ${args.op} timed out`)), timeoutMs);
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
    const frame = telemostFrame(page);
    const input = frame
      .locator(
        "input[data-testid='orb-textinput-input'], input.Orb-Textinput-input, input[placeholder*='имя' i], input[placeholder*='name' i], input[type='text']"
      )
      .first();
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
      await input.fill(botName, { timeout: 2000 }).catch(async () => {
        await input.click({ timeout: 1500 });
        await page.keyboard.press("Control+KeyA");
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText(botName);
      });
      return (await input.inputValue()).trim() === botName.trim();
    }
  } catch {}
  return false;
}

export async function joinFlow(ctx) {
  const { page, context, config, signal, log, setPhase } = ctx;
  const url = config.joinUrl;

  await context.grantPermissions(["microphone", "camera"], { origin: "https://telemost.yandex.ru" }).catch(() => {});
  await context.grantPermissions(["microphone", "camera"], { origin: "https://telemost.360.yandex.ru" }).catch(() => {});

  setPhase("joining", "Открытие ссылки Яндекс Телемост");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (err) {
    if (signal.aborted) throw new StopRequested();
    log("warn", "Telemost navigation warning", { error: err.message });
  }

  // Wait briefly for the private-join iframe to mount
  await sleepUnless(2500, signal);

  const startMs = Date.now();
  const maxWaitMs = Math.max(180_000, (config.waitingTimeoutSec || 600) * 1000);
  let lastJoinClick = 0;
  let joinClicks = 0;

  while (Date.now() - startMs < maxWaitMs) {
    if (signal.aborted) throw new StopRequested();

    await ensureOuterShellClean(page);

    const p = await evalOp(page, { op: "probe", botName: config.botName });
    if (!p) {
      await sleepUnless(1200, signal);
      continue;
    }

    if (p.inMeeting) {
      log("info", "Joined Yandex Telemost conference", { url: p.url, participants: p.names, totalParticipants: p.totalParticipants });
      await evalOp(page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });
      return;
    }

    if (p.ended) {
      throw new BotError("meeting_ended", "Встреча в Яндекс Телемосте завершена или ссылка недействительна");
    }

    if (p.waitingRoom) {
      setPhase("waiting_room", "Ожидание подтверждения организатора в Яндекс Телемосте");
      await sleepUnless(2000, signal);
      continue;
    }

    // Keep the microphone muted and show the configured avatar camera.
    await evalOp(page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });

    if (p.hasNameInput && p.nameValue.trim() !== config.botName.trim()) {
      const typed = await fillGuestName(page, config.botName);
      log("info", "Typed bot name in Yandex Telemost pre-join", { name: config.botName, typed });
      await sleepUnless(600, signal);
      if (!typed) continue;
    }

    if (p.hasJoinBtn && !p.joinDisabled && Date.now() - lastJoinClick > 4500) {
      const res = await evalOp(page, { op: "clickJoin" });
      lastJoinClick = Date.now();
      joinClicks += 1;
      log("info", "Clicked Join in Yandex Telemost", { attempt: joinClicks, res, frameUrl: p.url });
      setPhase("joining", "Подключение к комнате Яндекс Телемост...");
    }

    await sleepUnless(1500, signal);
  }

  throw new BotError("waiting_timeout", "Превышено время ожидания входа в Яндекс Телемост");
}

export async function sampleMeeting(ctx) {
  const p = await evalOp(ctx.page, { op: "probe", botName: ctx.config?.botName });
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
    ended = { reason: "meeting_ended", message: "Яндекс Телемост: встреча завершена" };
  } else if (!p.hasLeaveBtn && !p.inMeeting) {
    st.leaveMissingSince ??= now;
    if (now - st.leaveMissingSince > 12_000 && now - (ctx.joinedAt ?? now) > 20_000) {
      ended = { reason: "meeting_ended", message: "Окно звонка Яндекс Телемост закрылось" };
    }
  } else {
    st.leaveMissingSince = null;
  }

  const names = Array.isArray(p.names) ? p.names : [];
  const active = Array.isArray(p.active) ? p.active : [];
  const count = Number.isFinite(p.totalParticipants)
    ? p.totalParticipants
    : names.length > 0
      ? names.length + 1
      : null;

  return {
    signals: {
      store: active.length > 0 ? active : null,
      tile: active.length > 0 ? active : null,
      tracks: Array.isArray(p.tracks) ? p.tracks : [],
    },
    roster: names.length > 0 ? names : null,
    count,
    ended,
    raw: { platform: "telemost", active, count, names },
  };
}

export async function sweepPopups(ctx) {
  await ensureOuterShellClean(ctx.page);
  return (await evalOp(ctx.page, { op: "sweep" })) || [];
}

export async function ensureAudio(ctx) {
  await evalOp(ctx.page, { op: "setMedia", muteMic: true, wantCamera: avatarCamera(ctx) });
  await evalOp(ctx.page, { op: "sweep" });
  return { joined: true, needsJoin: false };
}

export async function sendChat(ctx, text) {
  try {
    const frame = telemostFrame(ctx.page);
    const chatBtn = frame.locator("[data-testid='chat-alt-button'], button[aria-label*='чат' i]").first();
    if (await chatBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await chatBtn.click();
      await sleep(600);
      const input = ctx.page.locator("textarea, input[placeholder*='сообщ' i]").first();
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
  name: "telemost",
  join: joinFlow,
  sample: sampleMeeting,
  sweep: sweepPopups,
  ensureAudio,
  sendChat,
  leave: leaveMeeting,
};
