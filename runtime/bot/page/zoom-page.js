// Evaluated inside the Zoom web-client frame (and the mock meeting page) as
// `(<this file>)({op, sel, ...})`. One expression, no imports, no globals
// except two symbol-keyed caches on window. Every op returns plain JSON.
//
// Ops: markers (join-flow state), sample (speaker/roster signals), sweep
// (dismiss harmless popups), audio (computer audio / mute / camera), leave,
// chat, click, forensics, store (discovery report).
(args) => {
  const sel = args.sel || {};
  const STORE_KEY = Symbol.for("mtg.store");
  const STORE_MISS_KEY = Symbol.for("mtg.storeMiss");

  // ------------------------------------------------------------ DOM helpers
  const qa = (selector, root) => {
    try {
      return Array.from((root || document).querySelectorAll(selector));
    } catch {
      return [];
    }
  };
  const q = (selector, root) => {
    try {
      return (root || document).querySelector(selector);
    } catch {
      return null;
    }
  };
  const visible = (el) => {
    if (!el || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el ? el.innerText || el.textContent : "");
  const label = (el) => clean(el ? el.getAttribute("aria-label") : "");
  const firstVisible = (selectors) => {
    for (const selector of selectors || []) for (const el of qa(selector)) if (visible(el)) return el;
    return null;
  };
  const firstAny = (selectors) => {
    for (const selector of selectors || []) {
      const el = q(selector);
      if (el) return el;
    }
    return null;
  };
  const unique = (list) => Array.from(new Set(list.filter(Boolean)));
  const press = (el) => {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {}
    el.click();
    return true;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  /** Visible buttons (or role=button) whose text or aria-label matches. */
  const buttonsMatching = (pattern, root) =>
    qa('button, [role="button"], a.zm-btn', root).filter((el) => {
      if (!visible(el)) return false;
      const t = textOf(el);
      const a = label(el);
      return pattern.test(t) || (a !== "" && pattern.test(a));
    });

  const MODALS =
    '.zm-modal, .zm-modal-legacy, [role="dialog"], [role="alertdialog"], .ReactModal__Content, [class*="meeting-ended"], [class*="ended-meeting"], [class*="end-screen"], [class*="leave-page"], [aria-label="Meeting is end now"], [aria-label="You have been removed"]';
  const CHAT =
    '[aria-label="Chat Message List"], .chat-virtuoso-wrapper, #chat-list-content, .chat-container__chat-list, #chat, .chat-container, .chat-rtf-box__editor-outer, [class*="new-chat"]';

  /** Visible modal texts, never chat content (a chat line "you have been removed…" must not end the meeting). */
  const modalTexts = () => {
    const out = [];
    for (const el of qa(MODALS)) {
      if (!visible(el) || el.closest(CHAT) || q(CHAT, el)) continue;
      const t = textOf(el);
      if (t !== "" && t.length <= 800) out.push({ el, text: t, lower: t.toLowerCase() });
    }
    return out;
  };

  const ENDED = /meeting has been ended|ended by (the )?host|host (has )?ended (the|this) meeting|this meeting has ended|the meeting has ended|meeting is end now/;
  const REMOVED = /you have been removed|removed you from (the|this) meeting|host (has )?removed you|been removed from (the|this) meeting/;

  const endedState = () => {
    for (const m of modalTexts()) {
      if (REMOVED.test(m.lower)) return { reason: "removed", message: m.text.slice(0, 200) };
      if (ENDED.test(m.lower)) return { reason: "meeting_ended", message: m.text.slice(0, 200) };
    }
    return null;
  };

  // ------------------------------------------------------------ Redux store
  const isStore = (x) =>
    !!x && typeof x === "object" && typeof x.getState === "function" && typeof x.subscribe === "function" && typeof x.dispatch === "function";
  const stateOf = (store) => {
    try {
      return store.getState();
    } catch {
      return null;
    }
  };
  const looksLikeZoom = (state) => !!state && typeof state === "object" && ("attendeesList" in state || "meeting" in state);

  /** Breadth-first search of the React fiber tree for the Redux <Provider store>. */
  const searchFibers = (start) => {
    const queue = [start];
    const seen = new Set();
    let visited = 0;
    while (queue.length > 0 && visited < 30000) {
      const fiber = queue.shift();
      if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
      seen.add(fiber);
      visited += 1;
      const props = fiber.memoizedProps;
      const candidates = [
        props && props.store,
        props && props.value && props.value.store,
        props && props.value,
        fiber.stateNode && fiber.stateNode.store,
        fiber.stateNode && fiber.stateNode.props && fiber.stateNode.props.store,
      ];
      for (const candidate of candidates) {
        if (isStore(candidate) && looksLikeZoom(stateOf(candidate))) return candidate;
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  };

  const findStore = () => {
    const cached = window[STORE_KEY];
    if (isStore(cached)) return cached;
    if (sel.store === false) return null;
    // Rediscover at most every 5 s while missing (the walk is not free).
    if (Date.now() - (window[STORE_MISS_KEY] || 0) < 5000) return null;
    const roots = [];
    for (const selector of ["#root", "#meeting-app", "#zmmtg-root", "#app", "body > div"]) roots.push(...qa(selector));
    for (const el of roots) {
      for (const key of Object.keys(el)) {
        let fiber = null;
        if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) fiber = el[key];
        else if (key === "_reactRootContainer") fiber = el[key] && el[key]._internalRoot && el[key]._internalRoot.current;
        if (!fiber) continue;
        const store = searchFibers(fiber);
        if (store) {
          Object.defineProperty(window, STORE_KEY, { value: store, configurable: true, enumerable: false });
          return store;
        }
      }
    }
    Object.defineProperty(window, STORE_MISS_KEY, { value: Date.now(), configurable: true, enumerable: false, writable: true });
    return null;
  };

  const idOf = (x) => (x && typeof x === "object" ? (x.userId ?? x.nodeId ?? x.id ?? x.userID ?? null) : x);

  /** Speakers, roster and count from Zoom's Redux state. */
  const readStore = () => {
    const store = findStore();
    if (!store) return null;
    const state = stateOf(store);
    if (!state) return null;
    const list = state.attendeesList && state.attendeesList.attendeesList;
    const attendees = Array.isArray(list) ? list : [];
    const byId = new Map();
    for (const a of attendees) if (a && a.userId !== undefined && a.userId !== null) byId.set(a.userId, a);
    const attendeeFor = (id) => {
      if (id === null || id === undefined) return null;
      if (byId.has(id)) return byId.get(id);
      // Audio node ids can differ from user ids in the low bits.
      if (typeof id === "number") {
        for (const [key, value] of byId) if (typeof key === "number" && key >> 10 === id >> 10) return value;
      }
      return null;
    };
    const audio = state.audio || {};
    // 2026 web client: asnIds = {asn1, asn2, asn3, asnUser}, 0 = empty slot.
    const rawAsn = audio.asnIds;
    let asn = [];
    if (Array.isArray(rawAsn)) asn = rawAsn;
    else if (rawAsn && typeof rawAsn === "object") asn = Object.keys(rawAsn).filter((k) => /^asn\d+$/i.test(k)).sort().map((k) => rawAsn[k]);
    asn = asn.map(idOf).filter((id) => id !== 0 && id !== null && id !== undefined && id !== "");
    const speakers = unique(asn.map(attendeeFor).map((a) => (a ? clean(a.displayName) : "")));
    const present = attendees.filter((a) => a && !a.bHold && !a.isHold && a.bInWaitingRoom !== true);
    const meeting = state.meeting || {};
    const currentUser = meeting.currentUser || null;
    return {
      speakers,
      names: unique(present.map((a) => clean(a.displayName))),
      count: present.length,
      self: currentUser ? clean(currentUser.displayName) || null : null,
      asn: asn.slice(0, 8),
      // Raw extras for offline tuning (signals.jsonl).
      asnUser: rawAsn && typeof rawAsn === "object" && !Array.isArray(rawAsn) ? idOf(rawAsn.asnUser) : null,
      hasAsn: unique(present.filter((a) => a.hasAsn === true).map((a) => clean(a.displayName))),
      lastSpoken: present
        .filter((a) => typeof a.lastSpokenTime === "number" && a.lastSpokenTime > 0)
        .sort((a, b) => b.lastSpokenTime - a.lastSpokenTime)
        .slice(0, 3)
        .map((a) => [clean(a.displayName), a.lastSpokenTime]),
    };
  };

  // ------------------------------------------------------------ tiles / count
  const readTiles = () => {
    const nameSelectors = sel.tileName || [".video-avatar__avatar-footer span", ".video-avatar__avatar-footer"];
    const nameIn = (frame) => {
      for (const selector of nameSelectors) {
        for (const el of qa(selector, frame)) {
          const t = textOf(el);
          if (t !== "") return t;
        }
      }
      return "";
    };
    let active = [];
    let tier = null;
    for (const selector of sel.activeTile || []) {
      const names = qa(selector).filter(visible).map(nameIn).filter(Boolean);
      if (names.length > 0) {
        active = unique(names);
        tier = selector;
        break;
      }
    }
    const all = unique(qa(nameSelectors.join(", ")).map(textOf));
    return { active, all, tier };
  };

  const readCount = () => {
    const counter = firstAny(sel.counter || [".footer-button__number-counter"]);
    if (counter) {
      const n = parseInt(textOf(counter).replace(/\D+/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
    for (const selector of sel.participantsButton || []) {
      for (const el of qa(selector)) {
        const m = /\[(\d+)\]|(\d+)\s*particip/i.exec(label(el));
        if (m) return Number(m[1] || m[2]);
      }
    }
    return null;
  };

  const leaveButton = () => firstAny(sel.leave || ['button[aria-label="Leave"]']);

  // ------------------------------------------------------------ join markers
  const has = (lower, patterns) => patterns.some((p) => (typeof p === "string" ? lower.includes(p) : p.test(lower)));

  const markers = () => {
    const bodyText = document.body ? clean(document.body.innerText) : "";
    const lower = bodyText.toLowerCase();
    const title = document.title || "";
    const nameInput = firstVisible(["#input-for-name", "#inputname", 'input[placeholder="Your Name" i]']);
    const joinButton = firstVisible(["button.preview-join-button", "#joinBtn"]);
    const passcode = firstVisible([
      "#input-for-pwd",
      "#input-for-passcode",
      "#inputpasscode",
      "#inputpwd",
      'input[placeholder*="passcode" i]',
      'input[type="password"]',
    ]);
    const captchaEl = firstVisible([
      ".component_smart_captcha",
      'input[placeholder*="captcha" i]',
      'iframe[src*="recaptcha"][src*="bframe"]',
      'iframe[title*="challenge" i]',
    ]);
    const smartCaptchaText = has(lower, ["type the characters you see", "verify you're human", "verify you are human", "i'm not a robot", "complete the captcha"]);
    const audioBtn = q("button.join-audio-container__btn");
    const inMeetingMarker =
      !!leaveButton() ||
      !!firstVisible([".single-main-container__video-frame", ".single-suspension-container__video-frame", "#video-share-layout video-player"]);
    const prejoinPresent = !!nameInput || !!joinButton;
    const allowButton = buttonsMatching(/^(allow|use microphone and camera|use microphone)$/i).find(
      (el) => !el.closest("#onetrust-banner-sdk, #onetrust-consent-sdk"),
    );
    return {
      url: location.href,
      title,
      text: bodyText.slice(0, 600),
      error3001: /invalid \(3,?001\)/.test(lower) || (/^error - zoom$/i.test(title) && lower.includes("meeting link is invalid")),
      errorTitle: /^error - zoom$/i.test(title),
      errorMessage: textOf(q("#global-error .error-message")) || null,
      registration: /\/webinar\/register\//.test(location.pathname),
      botWall: has(lower, ["we detected you may be a bot", "automated bots aren't allowed", "automated bots aren’t allowed", "must use zoom rtms"]),
      signIn: has(lower, [
        "sign in to join this meeting",
        "only authenticated users can join",
        "this meeting requires authentication",
        "authentication is required",
        "authorized attendees only",
        "the host requires authentication",
      ]),
      browserDisabled: has(lower, [
        /joining from (a )?browser is (disabled|not allowed)/,
        "can't join from a browser",
        "cannot join from a browser",
        "disabled access to zoom from the browser",
        /host (has )?disabled .{0,40}browser/,
      ]),
      captcha: !!captchaEl || (smartCaptchaText && !!firstVisible(['[class*="captcha" i] input', 'input[placeholder*="code" i]', ".CaptchaContainer img", '[class*="captcha" i] img'])),
      captchaText: smartCaptchaText,
      waitingRoom: has(lower, [
        "please wait, the meeting host will let you in soon",
        "will let you in soon",
        "we've let them know you're here",
        "host has joined. we've let them know",
        "someone will let you in shortly",
        "waiting for someone to let you in",
        "when someone admits you",
        "you're in the lobby",
        "know you're waiting",
        "host has been notified",
      ]),
      waitingHost: has(lower, ["waiting for the host to start", "host to start the meeting", "host to start this meeting", "host has another meeting"]),
      wrongPasscode:
        has(lower, [/(incorrect|invalid|wrong)[\s\S]{0,32}(passcode|password)/, "passcode wrong"]) ||
        !!firstVisible(["#error-for-pwd", "#error-for-passcode"]) ||
        (!!passcode && passcode.getAttribute("aria-invalid") === "true"),
      denied: has(lower, ["host has denied", "denied your request", "you have been denied", "not allowed to join this meeting", "kicked out of the waiting room"]),
      locked: has(lower, ["meeting is locked", "this meeting has been locked"]),
      full: has(lower, ["meeting is full", "meeting capacity", "reached the maximum"]),
      ended: endedState(),
      notice: (modalTexts()[0] || { text: null }).text,
      loading: has(lower, ["joining meeting", "connecting to the meeting", "preparing the meeting", "your meeting is loading"]),
      cookie: !!firstVisible(["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"]),
      disclaimer: !!firstVisible(["#wc_agree1", "#disclaimer_agree"]),
      allow: !!allowButton,
      joinFromBrowser: buttonsMatching(/^join from (your |a )?browser$/i).length > 0,
      prejoin: prejoinPresent
        ? {
            name: !!nameInput,
            nameValue: nameInput ? nameInput.value : null,
            join: !!joinButton,
            joinDisabled: joinButton ? joinButton.disabled || joinButton.classList.contains("disabled") || joinButton.classList.contains("zm-btn--disabled") : null,
            passcode: !!passcode,
            mic: label(q("#preview-audio-control-button")) || null,
            video: label(q("#preview-video-control-button")) || null,
          }
        : null,
      inMeeting: inMeetingMarker && !prejoinPresent,
      audio: audioBtn ? label(audioBtn) : null,
    };
  };

  // ------------------------------------------------------------ popups
  const SAFE_BUTTON = /^(ok|okay|got it|i agree|agree|accept|continue|close|dismiss|i understand|allow)$/i;
  const DANGER_TEXT = /\bleave\b|\bend\b|end meeting|end for all|switch to|download|sign in|start video|unmute|remove/i;

  const sweep = () => {
    const clicked = [];
    for (const m of modalTexts()) {
      // The computer-audio dialog belongs to the audio op; end/removal
      // notices are for the sampler to see, not to be dismissed.
      if (/computer audio|join audio/.test(m.lower) || ENDED.test(m.lower) || REMOVED.test(m.lower)) continue;
      // Never touch a dialog that offers to leave or end the meeting.
      if (/leave meeting|end meeting|end for all|leave the meeting/.test(m.lower)) {
        const okay = buttonsMatching(/^(got it|ok|okay|continue|i agree|agree|accept)$/i, m.el).find((el) => !DANGER_TEXT.test(textOf(el)));
        if (okay && press(okay)) clicked.push(textOf(okay));
        continue;
      }
      const button = buttonsMatching(SAFE_BUTTON, m.el).find((el) => !DANGER_TEXT.test(textOf(el)) && !DANGER_TEXT.test(label(el)));
      if (button && press(button)) clicked.push(`${textOf(button) || label(button)} @ ${m.text.slice(0, 60)}`);
    }
    for (const el of qa(".relative-tooltip, .settings-feature-tips, .zm-popover, .global-popover, [class*='new-feature']")) {
      if (!visible(el)) continue;
      const button = buttonsMatching(/^(got it|ok|okay|close|dismiss)$/i, el)[0];
      if (button && press(button)) clicked.push(`${textOf(button)} @ tip`);
    }
    const testClose = firstVisible(["button.test-meeting-close"]);
    if (testClose && press(testClose)) clicked.push("test-meeting-close");
    for (const wrap of qa(".notification-message-wrap")) {
      if (!visible(wrap)) continue;
      const close = q('.notification-message-wrap__btns button, [aria-label="close" i][role="button"], i.notification-message-wrap__close', wrap);
      if (close && visible(close) && !/learn more/i.test(textOf(close)) && press(close)) clicked.push("notification");
    }
    for (const el of qa('button[aria-label="Close notification"]')) if (visible(el) && press(el)) clicked.push("Close notification");
    return clicked;
  };

  // ------------------------------------------------------------ audio / video
  const audioState = () => {
    const button = q("button.join-audio-container__btn") || firstAny(['#foot-bar button[aria-label*="microphone" i]', '#foot-bar button[aria-label*="audio" i]']);
    const a = label(button).toLowerCase();
    const joined = /mute my microphone|^mute$|^unmute$|unmute my microphone/.test(a);
    return { button, label: a, joined, muted: joined && /unmute/.test(a) };
  };

  const audio = (action) => {
    const state = audioState();
    let clicked = null;
    if (action === "join" && !state.joined) {
      const dialogButton =
        buttonsMatching(/^(join audio by computer|join with computer audio|join computer audio|computer audio|join audio)$/i).find(
          (el) => !el.classList.contains("join-audio-container__btn"),
        ) || firstVisible([".join-audio-by-voip__join-btn", "button.join-audio-by-computer"]);
      if (dialogButton) clicked = press(dialogButton) && "dialog";
      else if (state.button && /join audio|^audio$/.test(state.label)) clicked = press(state.button) && "footer";
    } else if (action === "mute" && state.joined && !state.muted && state.button) {
      clicked = press(state.button) && "mute";
    } else if (action === "videoOff") {
      const video = q("button.send-video-container__btn");
      if (video && /stop video/i.test(label(video))) clicked = press(video) && "video";
      return { video: label(video) || null, clicked };
    }
    return { label: state.label, joined: state.joined, muted: state.muted, clicked };
  };

  // ------------------------------------------------------------ actions
  const click = (selectors, mode) => {
    const el = mode === "any" ? firstAny(selectors) : firstVisible(selectors);
    if (!el) return null;
    press(el);
    return textOf(el) || label(el) || el.id || el.tagName.toLowerCase();
  };

  // A host bot (signed-in account, or host handed over) gets "End Meeting for
  // All" next to "Leave Meeting", and End is the red one. Never click End.
  const END_FOR_ALL = /\bend\b|end for all|заверш/i;
  const LEAVE_EXACT = /^(leave (the )?(meeting|webinar)|выйти из (конференции|встречи|вебинара))$/i;
  const LEAVE_WORD = /\bleave\b|выйти|покинуть/i;
  const says = (el, pattern) => pattern.test(textOf(el)) || pattern.test(label(el));

  const leave = (step) => {
    if (step === "open") {
      const button = leaveButton();
      if (!button) return null;
      press(button);
      return label(button) || textOf(button);
    }
    const candidates = unique([
      ...buttonsMatching(LEAVE_EXACT),
      ...(sel.leaveConfirm || []).flatMap((selector) => qa(selector).filter(visible)),
    ]);
    const safe = candidates.filter((el) => !says(el, END_FOR_ALL));
    // With more than one choice (host popover, any UI language) only a button that says Leave will do.
    const siblings = (el) => (el.parentElement ? qa('button, [role="button"]', el.parentElement).filter(visible).length : 1);
    const choices = candidates.length > 1 || candidates.some((el) => siblings(el) > 1) || buttonsMatching(/end (meeting )?for all|завершить/i).length > 0;
    const confirm = safe.find((el) => says(el, LEAVE_EXACT)) || (choices ? safe.find((el) => says(el, LEAVE_WORD)) : safe[0]);
    if (!confirm) return null;
    press(confirm);
    return textOf(confirm) || label(confirm);
  };

  const EDITORS = [
    'div.tiptap.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'div.chat-rtf-box__editor[contenteditable="true"]',
    '.chat-rtf-box__editor-outer [contenteditable="true"]',
    "textarea.chat-box__chat-textarea",
    'textarea[placeholder*="message" i]',
  ];
  const chat = (step) => {
    if (step === "open") {
      if (firstVisible(EDITORS)) return "ready";
      const button =
        q('button[aria-label="open the chat panel"]') ||
        qa("button[aria-label]").find((el) => /chat/i.test(label(el)) && !/setting|close/i.test(label(el)));
      if (!button) return null;
      press(button);
      return "opened";
    }
    if (step === "focus") {
      const editor = firstVisible(EDITORS);
      if (!editor) return null;
      editor.focus();
      return editor.tagName.toLowerCase();
    }
    if (step === "check") {
      // Did the message reach the chat list? (rows carry the text in aria-label or content)
      const needle = clean(args.text).toLowerCase().slice(0, 60);
      const lists = qa('[aria-label="Chat Message List"], .chat-virtuoso-wrapper, #chat-list-content, .chat-container__chat-list, [class*="chat-list"]');
      const inList = lists.some((list) => textOf(list).toLowerCase().includes(needle) || qa("[aria-label]", list).some((el) => label(el).toLowerCase().includes(needle)));
      const editor = firstVisible(EDITORS);
      return { inList, editorEmpty: editor ? textOf(editor) === "" && !(editor.value || "") : null };
    }
    if (step === "close") {
      const button = q('button[aria-label="close the chat panel"]');
      if (button) press(button);
      return button ? "closed" : null;
    }
    return null;
  };

  // ------------------------------------------------------------ diagnostics
  const storeReport = () => {
    const store = findStore();
    if (!store) return { found: false };
    const state = stateOf(store) || {};
    const primitives = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = typeof v === "string" ? v.slice(0, 60) : v;
        else out[k] = Array.isArray(v) ? `[array ${v.length}]` : `{${typeof v}}`;
      }
      return out;
    };
    const list = state.attendeesList && state.attendeesList.attendeesList;
    return {
      found: true,
      topKeys: Object.keys(state).slice(0, 200),
      audioKeys: Object.keys(state.audio || {}).slice(0, 100),
      asnIds: state.audio ? state.audio.asnIds : undefined,
      attendeesListKeys: Object.keys(state.attendeesList || {}).slice(0, 50),
      attendeesCount: Array.isArray(list) ? list.length : null,
      attendees: Array.isArray(list) ? list.slice(0, 4).map(primitives) : null,
      meetingKeys: Object.keys(state.meeting || {}).slice(0, 100),
      currentUser: state.meeting && state.meeting.currentUser ? primitives(state.meeting.currentUser) : null,
      videoKeys: Object.keys(state.video || {}).slice(0, 100),
    };
  };

  const forensics = () => {
    const chain = (el) => {
      const out = [];
      for (let node = el, i = 0; node && node !== document.body && i < 10; node = node.parentElement, i += 1) {
        const cls = typeof node.className === "string" ? node.className : node.getAttribute("class") || "";
        out.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${cls ? `.${cls.trim().split(/\s+/).join(".")}` : ""}`);
      }
      return out;
    };
    const footers = qa(".video-avatar__avatar-footer").slice(0, 40).map((el) => ({ name: textOf(el), visible: visible(el), box: box(el), chain: chain(el) }));
    const classes = new Set();
    for (const el of qa("[class]")) {
      const list = el.classList ? Array.from(el.classList) : [];
      for (const c of list) if (/speak|talk|active|audio|volume|voice/i.test(c)) classes.add(c);
      if (classes.size > 400) break;
    }
    const audioHook = window[Symbol.for("mtg.audio")];
    return {
      url: location.href,
      title: document.title,
      footers,
      classes: Array.from(classes),
      tiles: readTiles(),
      count: readCount(),
      store: storeReport(),
      tracks: audioHook ? audioHook.info() : null,
      modals: modalTexts().map((m) => m.text.slice(0, 200)),
    };
  };

  // ------------------------------------------------------------ sample
  const sample = () => {
    let store = null;
    try {
      store = readStore();
    } catch {
      store = null;
    }
    const tiles = readTiles();
    const audioHook = window[Symbol.for("mtg.audio")];
    return {
      url: location.href,
      title: document.title,
      store,
      tile: tiles,
      count: readCount(),
      leave: !!leaveButton(),
      ended: endedState(),
      tracks: audioHook ? audioHook.levels() : [],
    };
  };

  switch (args.op) {
    case "markers":
      return markers();
    case "sample":
      return sample();
    case "sweep":
      return sweep();
    case "audio":
      return audio(args.action);
    case "leave":
      return leave(args.step);
    case "chat":
      return chat(args.step);
    case "click":
      return click(args.selectors, args.mode);
    case "forensics":
      return forensics();
    case "store":
      return storeReport();
    default:
      throw new Error(`unknown op ${args.op}`);
  }
}
