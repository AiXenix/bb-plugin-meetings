// Mock Zoom meeting for the bot's end-to-end test and `bb meetings selftest`
// (docs/dev/DESIGN.md §6.3). It copies the Zoom web-client DOM the bot reads
// (pre-join form, tiles, footer, end modal), exposes a Redux-like store
// through a React-style container key, and plays a script of utterances. Each
// participant's audio goes through an in-page WebRTC loopback, so the bot's
// track hook sees one remote audio track per participant, like in Zoom.
//
// Query parameters:
//   script=<url>       JSON array [{speaker, clip?: "a.wav", tone?: {freq, durationSec}, gapSec?}]
//   end=ended|removed|alone|none   what happens after the script (default ended)
//   store=0            no Redux-like store (tile signal only)
//   webrtc=0           plain WebAudio playback (no per-participant tracks)
//   storeLagMs, tileLagMs   indicator lag behind the audio (default 700 / 1200)
//   startDelaySec, endDelaySec, waitingSec, audioJoin=auto|dialog, popup=0
//   host=1             the bot is host: the Leave popover also offers a red "End Meeting for All"
//   audioDropSec=N     Zoom drops the bot's computer audio N s after it entered
//   log=<url>          where events are POSTed (default ./log next to this page)
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const num = (name, fallback) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isFinite(value) ? value : fallback;
  };
  const opt = {
    script: params.get("script"),
    end: params.get("end") || "ended",
    store: params.get("store") !== "0",
    webrtc: params.get("webrtc") !== "0",
    storeLagMs: num("storeLagMs", 700),
    tileLagMs: num("tileLagMs", 1200),
    startDelaySec: num("startDelaySec", 3),
    endDelaySec: num("endDelaySec", 2),
    waitingSec: num("waitingSec", 0),
    audioJoin: params.get("audioJoin") || "auto",
    popup: params.get("popup") !== "0",
    host: params.get("host") === "1",
    audioDropSec: num("audioDropSec", 0),
    logUrl: params.get("log") || new URL("log", location.href).href,
  };

  const DEFAULT_SCRIPT = [
    { speaker: "Анна Смирнова", tone: { freq: 220, durationSec: 4 }, gapSec: 1 },
    { speaker: "Борис Петров", tone: { freq: 330, durationSec: 4 }, gapSec: 1 },
    { speaker: "Вера Иванова", tone: { freq: 440, durationSec: 4 }, gapSec: 1 },
    { speaker: "Анна Смирнова", tone: { freq: 220, durationSec: 3 }, gapSec: 1 },
    { speaker: "Борис Петров", tone: { freq: 330, durationSec: 3 }, gapSec: 1 },
    { speaker: "Вера Иванова", tone: { freq: 440, durationSec: 3 }, gapSec: 1 },
  ];

  const $ = (selector) => document.querySelector(selector);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function report(type, data = {}) {
    const body = JSON.stringify({ type, t: Date.now(), ...data });
    try {
      fetch(opt.logUrl, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
    } catch {
      // the selftest server may not accept POSTs
    }
  }

  function status(text) {
    $("#status").textContent = text;
  }

  // ------------------------------------------------------------ Redux-like store

  function createStore() {
    let state = {
      meeting: { meetingTopic: "Mock Meeting", currentUser: null },
      attendeesList: { attendeesList: [] },
      // Same shape as Zoom's 2026 web client: three slots, 0 = empty.
      audio: { asnIds: { asn1: 0, asn2: 0, asn3: 0, asnUser: null } },
    };
    const listeners = new Set();
    return {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispatch(action) {
        if (action && action.type === "mock/patch") {
          state = { ...state, ...action.patch };
          for (const listener of listeners) listener();
        }
        return action;
      },
    };
  }

  const store = createStore();
  if (opt.store) {
    // What the bot looks for: a React root container whose fiber tree holds a
    // context provider with { store }.
    const fiber = { tag: 3, memoizedProps: null, sibling: null, child: { tag: 10, memoizedProps: { value: { store } }, child: null, sibling: null } };
    Object.defineProperty($("#root"), "__reactContainer$mock", { value: fiber, enumerable: true });
  }

  // ------------------------------------------------------------ pre-join

  const nameInput = $("#input-for-name");
  const joinButton = $(".preview-join-button");
  let typedByUser = false;
  let botName = "";

  function updateJoinButton() {
    // Like Zoom: a value set by script without real input events keeps Join disabled.
    const enabled = nameInput.value.trim() !== "" && typedByUser;
    joinButton.classList.toggle("disabled", !enabled);
    joinButton.classList.toggle("zm-btn--disabled", !enabled);
    joinButton.tabIndex = enabled ? 0 : -1;
  }
  nameInput.addEventListener("input", (event) => {
    typedByUser = event.isTrusted;
    updateJoinButton();
  });

  function toggleLabel(button, a, b) {
    const next = button.getAttribute("aria-label") === a ? b : a;
    button.setAttribute("aria-label", next);
    button.textContent = next;
  }
  $("#preview-audio-control-button").addEventListener("click", (e) => toggleLabel(e.currentTarget, "Mute", "Unmute"));
  $("#preview-video-control-button").addEventListener("click", (e) => toggleLabel(e.currentTarget, "Stop Video", "Start Video"));

  joinButton.addEventListener("click", () => {
    if (joinButton.classList.contains("disabled")) return;
    botName = nameInput.value.trim();
    report("joined", { name: botName, previewMic: $("#preview-audio-control-button").getAttribute("aria-label") });
    enterMeeting().catch((error) => report("error", { error: String(error) }));
  });

  // ------------------------------------------------------------ meeting UI

  const BOT_ID = 16778240;
  let participants = [];
  let speakingIds = new Set();
  let engine = null;
  let left = false;

  function idFor(name) {
    return BOT_ID + 1024 * (participants.indexOf(name) + 1);
  }

  function renderTiles() {
    const gallery = $("#gallery");
    gallery.textContent = "";
    for (const name of [botName, ...participants]) {
      const frame = document.createElement("div");
      frame.className = "gallery-video-container__video-frame";
      frame.dataset.name = name;
      const avatar = document.createElement("div");
      avatar.className = "video-avatar__avatar";
      avatar.textContent = name.slice(0, 1);
      const player = document.createElement("video-player");
      player.setAttribute("node-id", String(name === botName ? BOT_ID : idFor(name)));
      const footer = document.createElement("div");
      footer.className = "video-avatar__avatar-footer";
      const span = document.createElement("span");
      span.setAttribute("role", "none");
      span.textContent = name;
      footer.append(span);
      frame.append(player, avatar, footer);
      gallery.append(frame);
    }
  }

  function updateRoster() {
    const count = participants.length + 1;
    $("#participants-count").textContent = String(count);
    $("#participants-button").setAttribute("aria-label", `open the participants list pane,[${count}] particpants`);
    const attendees = [
      { userId: BOT_ID, displayName: botName, isHost: opt.host, isGuest: !opt.host, muted: true, bVideoOn: false },
      ...participants.map((name, i) => ({ userId: idFor(name), displayName: name, isHost: !opt.host && i === 0, isGuest: opt.host || i !== 0, muted: false, bVideoOn: false })),
    ];
    store.dispatch({
      type: "mock/patch",
      patch: { attendeesList: { attendeesList: attendees }, meeting: { meetingTopic: "Mock Meeting", currentUser: attendees[0] } },
    });
  }

  function setAudioButton(state) {
    const button = $("#audio-button");
    const labels = { none: ["audio", "Join Audio"], live: ["mute my microphone", "Mute"], muted: ["unmute my microphone", "Unmute"] };
    const [aria, text] = labels[state];
    button.dataset.state = state;
    button.setAttribute("aria-label", aria);
    button.querySelector(".footer-button-base__button-label").textContent = text;
  }

  $("#audio-button").addEventListener("click", (e) => {
    const state = e.currentTarget.dataset.state;
    if (state === "none") showAudioDialog();
    else setAudioButton(state === "live" ? "muted" : "live");
    report("audio-button", { state: $("#audio-button").dataset.state });
  });

  function showModal(html, { onButton } = {}) {
    const modal = document.createElement("div");
    modal.className = "zm-modal";
    modal.setAttribute("role", "dialog");
    modal.innerHTML = `<div class="zm-modal-content">${html}</div>`;
    modal.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      modal.remove();
      onButton?.(button.textContent.trim());
    });
    $("#modal-root").append(modal);
    return modal;
  }

  function showAudioDialog() {
    showModal('<div class="zm-modal-body-title">Join audio</div><button type="button" class="zm-btn zm-btn--primary join-audio-by-voip__join-btn">Join Audio by Computer</button>', {
      onButton: () => {
        setAudioButton("live");
        report("audio-joined", {});
      },
    });
  }

  $("#chat-button").addEventListener("click", (e) => {
    const panel = $("#wc-container-right");
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute("aria-label", panel.hidden ? "open the chat panel" : "close the chat panel");
  });
  $("#chat-editor").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const editor = event.currentTarget;
    const text = editor.innerText.trim();
    if (text === "") return;
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    row.setAttribute("aria-label", `${botName} to Everyone, ${new Date().toLocaleTimeString()}, ${text}`);
    row.textContent = `${botName}: ${text}`;
    $("#chat-list").append(row);
    editor.textContent = "";
    report("chat", { text });
  });

  $("#leave-button").addEventListener("click", () => {
    $("#leave-popover").hidden = !$("#leave-popover").hidden;
  });
  $("#leave-confirm").addEventListener("click", () => leaveMeeting("left"));
  if (opt.host) {
    // Like Zoom for a host: "End Meeting for All" comes first and is the red one.
    const end = document.createElement("button");
    end.type = "button";
    end.id = "end-for-all";
    end.className = "zm-btn leave-meeting-options__btn leave-meeting-options__btn--danger zm-btn--danger";
    end.textContent = "End Meeting for All";
    end.addEventListener("click", () => {
      report("ended-for-all", {});
      leaveMeeting("ended-for-all");
    });
    $("#leave-popover").prepend(end);
    $("#leave-confirm").className = "zm-btn leave-meeting-options__btn leave-meeting-options__btn--default";
  }

  function leaveMeeting(why) {
    if (left) return;
    left = true;
    report(why === "left" ? "left" : "closed", { why });
    $("#meeting-app").hidden = true;
    $("#left-page").hidden = false;
    document.title = "Zoom";
    if (engine) engine.ctx.close().catch(() => {});
  }

  // ------------------------------------------------------------ speaking indicators

  function setSpeaking(name, on) {
    const id = idFor(name);
    setTimeout(() => {
      if (on) speakingIds.add(id + 1);
      else speakingIds.delete(id + 1);
      // Audio node ids may differ from user ids in the low bits.
      const [asn1 = 0, asn2 = 0, asn3 = 0] = [...speakingIds];
      store.dispatch({ type: "mock/patch", patch: { audio: { asnIds: { asn1, asn2, asn3, asnUser: null } } } });
    }, opt.storeLagMs);
    setTimeout(() => {
      for (const frame of document.querySelectorAll(".gallery-video-container__video-frame")) {
        if (frame.dataset.name === name) frame.classList.toggle("gallery-video-container__video-frame--active", on);
      }
    }, opt.tileLagMs);
  }

  // ------------------------------------------------------------ audio

  async function waitFor(check, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await sleep(50);
    }
    return false;
  }

  async function setupAudio(names) {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const outs = new Map();
    let mode = "webaudio";
    if (opt.webrtc) {
      try {
        // Granting the mic also makes Chrome expose host candidates instead of mDNS names.
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          report("mic", { label: mic.getAudioTracks()[0]?.label ?? null });
          for (const track of mic.getTracks()) track.stop();
        } catch (error) {
          report("mic", { error: String(error) });
        }
        const sender = new RTCPeerConnection();
        const receiver = new RTCPeerConnection();
        sender.onicecandidate = (e) => e.candidate && receiver.addIceCandidate(e.candidate).catch(() => {});
        receiver.onicecandidate = (e) => e.candidate && sender.addIceCandidate(e.candidate).catch(() => {});
        const players = [];
        receiver.ontrack = (event) => {
          const player = new Audio();
          player.srcObject = new MediaStream([event.track]);
          player.play().catch(() => {});
          players.push(player);
        };
        for (const name of names) {
          const gain = ctx.createGain();
          const destination = ctx.createMediaStreamDestination();
          gain.connect(destination);
          sender.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
          outs.set(name, gain);
        }
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(sender.localDescription);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription);
        const connected = await waitFor(() => ["connected", "completed"].includes(receiver.iceConnectionState), 10000);
        if (!connected) throw new Error(`WebRTC loopback did not connect (${receiver.iceConnectionState})`);
        mode = "webrtc";
        engine = { ctx, outs, mode, sender, receiver, players };
      } catch (error) {
        report("webrtc-failed", { error: String(error) });
        outs.clear();
      }
    }
    if (mode === "webaudio") {
      for (const name of names) {
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        outs.set(name, gain);
      }
      engine = { ctx, outs, mode };
    }
    report("audio-mode", { mode, tracks: names.length });
    return engine;
  }

  async function loadClip(url, ctx) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`clip ${url}: HTTP ${response.status}`);
    return ctx.decodeAudioData(await response.arrayBuffer());
  }

  function playTone(ctx, out, { freq = 300, durationSec = 3 }, when) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    amp.gain.value = 0.25;
    // 4 Hz amplitude modulation: syllable-like energy.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4;
    const depth = ctx.createGain();
    depth.gain.value = 0.15;
    lfo.connect(depth).connect(amp.gain);
    osc.connect(amp).connect(out);
    osc.start(when);
    lfo.start(when);
    osc.stop(when + durationSec);
    lfo.stop(when + durationSec);
  }

  function playClip(ctx, out, buffer, when) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    source.start(when);
  }

  // ------------------------------------------------------------ script

  async function loadScript() {
    if (!opt.script) return { items: DEFAULT_SCRIPT, base: location.href };
    const url = new URL(opt.script, location.href).href;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`script ${url}: HTTP ${response.status}`);
    const items = await response.json();
    if (!Array.isArray(items) || items.length === 0) throw new Error("script must be a non-empty JSON array");
    return { items, base: url };
  }

  /**
   * Plan the timeline: each utterance starts `gapSec` after the previous one
   * ends (negative = overlap), scheduled on the audio clock; indicators and
   * reports follow on the wall clock.
   */
  async function runScript(items, base) {
    const buffers = new Map();
    for (const item of items) {
      if (item.clip && !buffers.has(item.clip)) buffers.set(item.clip, await loadClip(new URL(item.clip, base).href, engine.ctx));
    }
    await sleep(opt.startDelaySec * 1000);
    if (left) return;
    const ctx = engine.ctx;
    const audioZero = ctx.currentTime + 0.2;
    const epochZero = Date.now() + 200;
    let cursor = 0;
    const plan = items.map((item) => {
      const durationSec = item.clip ? buffers.get(item.clip).duration : (item.tone && item.tone.durationSec) || 3;
      const startSec = Math.max(0, cursor);
      cursor = startSec + durationSec + (Number.isFinite(item.gapSec) ? item.gapSec : 1);
      return { item, startSec, durationSec };
    });
    let speaking = 0;
    for (const { item, startSec, durationSec } of plan) {
      const out = engine.outs.get(item.speaker);
      if (item.clip) playClip(ctx, out, buffers.get(item.clip), audioZero + startSec);
      else playTone(ctx, out, item.tone || {}, audioZero + startSec);
      const start = epochZero + startSec * 1000;
      const end = start + durationSec * 1000;
      setTimeout(() => {
        if (left) return;
        speaking += 1;
        setSpeaking(item.speaker, true);
        status(`${engine.mode}: ${item.speaker}`);
      }, start - Date.now());
      setTimeout(() => {
        if (left) return;
        speaking -= 1;
        setSpeaking(item.speaker, false);
        if (speaking === 0) status(`${engine.mode}: —`);
        report("utterance", { speaker: item.speaker, start: Math.round(start), end: Math.round(end), clip: item.clip ?? null, durationSec });
      }, end - Date.now());
    }
    const last = Math.max(...plan.map((p) => p.startSec + p.durationSec));
    await sleep(epochZero + last * 1000 - Date.now() + 300);
    if (left) return;
    report("script-done", {});
    await sleep(opt.endDelaySec * 1000);
    finish();
  }

  function finish() {
    if (left) return;
    if (opt.end === "ended") {
      const modal = showModal(
        '<div class="zm-modal-body-title">This meeting has been ended by host</div><button type="button" class="zm-btn zm-btn-legacy zm-btn--primary zm-btn__outline--blue">OK</button>',
        { onButton: () => leaveMeeting("ended-ok") },
      );
      modal.setAttribute("aria-label", "Meeting is end now");
      report("end", { how: "ended" });
    } else if (opt.end === "removed") {
      showModal('<div class="zm-modal-body-title">You have been removed from this meeting by the host</div><button type="button" class="zm-btn zm-btn--primary">OK</button>', {
        onButton: () => leaveMeeting("removed-ok"),
      });
      report("end", { how: "removed" });
    } else if (opt.end === "alone") {
      (async () => {
        for (const name of [...participants]) {
          participants = participants.filter((p) => p !== name);
          renderTiles();
          updateRoster();
          await sleep(500);
        }
        report("end", { how: "alone" });
      })();
    }
  }

  async function enterMeeting() {
    $("#prejoin").hidden = true;
    if (opt.waitingSec > 0) {
      $("#waiting-room").hidden = false;
      await sleep(opt.waitingSec * 1000);
      $("#waiting-room").hidden = true;
    }
    const { items, base } = await loadScript();
    participants = [...new Set(items.map((item) => item.speaker))];
    document.title = "Mock Meeting";
    $("#meeting-app").hidden = false;
    renderTiles();
    updateRoster();
    setAudioButton("none");
    if (opt.audioJoin === "auto") setTimeout(() => setAudioButton("live"), 500);
    else showAudioDialog();
    if (opt.audioDropSec > 0) {
      setTimeout(() => {
        if (left) return;
        setAudioButton("none");
        report("audio-dropped", {});
      }, opt.audioDropSec * 1000);
    }
    if (opt.popup) {
      const tip = document.createElement("div");
      tip.className = "relative-tooltip";
      tip.innerHTML = '<div>Introducing My Notes</div><button type="button" class="zm-btn zm-btn--primary">Got it</button>';
      tip.querySelector("button").addEventListener("click", () => {
        tip.remove();
        report("popup-dismissed", {});
      });
      document.body.append(tip);
    }
    await setupAudio(participants);
    status(`${engine.mode}: ready`);
    await runScript(items, base);
  }

  status("pre-join");
})();
