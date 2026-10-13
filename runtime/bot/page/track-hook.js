// Init script (runs in every frame before page scripts): measure the level of
// every remote WebRTC audio track. Zoom in Chrome receives one audio track per
// participant, so per-track levels tell who is talking ~0.1 s after the sound
// (docs/dev/DESIGN.md §6.4 "track"). The bot polls
// window[Symbol.for("mtg.audio")].levels() a few times per second.
(() => {
  const KEY = Symbol.for("mtg.audio");
  if (window[KEY] || typeof RTCPeerConnection !== "function") return;

  const tracks = new Map();
  const peers = new Set();
  let audioContext = null;

  function context() {
    if (audioContext === null) audioContext = new AudioContext();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
  }

  function addTrack(track) {
    if (!track || track.kind !== "audio" || tracks.has(track.id)) return;
    try {
      const stream = new MediaStream([track]);
      // Chrome only feeds remote WebRTC audio into WebAudio while the stream
      // is also attached to a media element; keep a muted one.
      const element = new Audio();
      element.muted = true;
      element.srcObject = stream;
      element.play().catch(() => {});
      const ctx = context();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      tracks.set(track.id, {
        track,
        element,
        source,
        analyser,
        buffer: new Float32Array(analyser.fftSize),
        max: 0,
        addedAt: Date.now(),
      });
      track.addEventListener("ended", () => {
        const state = tracks.get(track.id);
        if (!state) return;
        try {
          state.source.disconnect();
        } catch {}
        state.element.srcObject = null;
        tracks.delete(track.id);
      });
    } catch {
      // A failing track must never break the meeting page.
    }
  }

  function watch(pc) {
    if (peers.has(pc)) return;
    peers.add(pc);
    pc.addEventListener("track", (event) => addTrack(event.track));
  }

  const proto = RTCPeerConnection.prototype;
  const originalSetRemote = proto.setRemoteDescription;
  proto.setRemoteDescription = function setRemoteDescription(...args) {
    try {
      watch(this);
    } catch {}
    return originalSetRemote.apply(this, args);
  };

  // Transceivers created up front (recvonly) may never fire "track" for us.
  setInterval(() => {
    for (const pc of peers) {
      if (pc.connectionState === "closed") {
        peers.delete(pc);
        continue;
      }
      try {
        for (const receiver of pc.getReceivers()) {
          if (receiver.track && receiver.track.kind === "audio" && receiver.track.readyState === "live") addTrack(receiver.track);
        }
      } catch {}
    }
  }, 1000);

  // 20 Hz RMS; the bot reads the maximum since its previous poll.
  setInterval(() => {
    for (const state of tracks.values()) {
      if (state.track.readyState !== "live") continue;
      state.analyser.getFloatTimeDomainData(state.buffer);
      let sum = 0;
      for (let i = 0; i < state.buffer.length; i += 1) sum += state.buffer[i] * state.buffer[i];
      const rms = Math.sqrt(sum / state.buffer.length);
      if (rms > state.max) state.max = rms;
    }
  }, 50);

  Object.defineProperty(window, KEY, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      levels() {
        const out = [];
        for (const [id, state] of tracks) {
          out.push({ id, level: Math.round(state.max * 10000) / 10000, muted: state.track.muted });
          state.max = 0;
        }
        return out;
      },
      info() {
        return { peers: peers.size, tracks: tracks.size, context: audioContext ? audioContext.state : null };
      },
    }),
  });
})();
