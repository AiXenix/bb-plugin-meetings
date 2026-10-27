// The media kick of the deaf-bot recovery (lib/audio-recovery.mjs, DESIGN §6.8)
// in a fake DOM: only the meeting's live streams are touched, never the
// page's file-backed UI sounds.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { KICK_SOURCE, kickPageAudio, recoverPageAudio } from "./audio-recovery.mjs";

function element({ stream = null, src = "", paused = true, sinkId = "", loop = false } = {}) {
  return {
    srcObject: stream,
    currentSrc: src,
    paused,
    loop,
    sinkId,
    plays: 0,
    sinks: [],
    play() {
      this.plays += 1;
      this.paused = false;
      return Promise.resolve();
    },
    setSinkId(id) {
      this.sinks.push(id);
      this.sinkId = id;
      return Promise.resolve();
    },
  };
}
const stream = (...states) => ({ getAudioTracks: () => states.map((readyState) => ({ readyState })) });

function kick(elements) {
  return vm.runInNewContext(KICK_SOURCE, { document: { querySelectorAll: () => elements } });
}

test("the kick restarts paused meeting streams and never plays the page's UI sounds", () => {
  const remote = element({ stream: stream("live") });
  const rerouted = element({ stream: stream("live"), paused: false, sinkId: "speaker-2" });
  const ended = element({ stream: stream("ended") });
  const videoOnly = element({ stream: stream() });
  // Jitsi's SoundCollection: paused <audio src> elements, the ringing one looping.
  const ringing = element({ src: "https://meet.example/sounds/outgoingRinging.mp3", loop: true, sinkId: "speaker-2" });
  const chime = element({ src: "https://meet.example/sounds/joined.mp3" });
  const result = kick([remote, rerouted, ended, videoOnly, ringing, chime]);
  assert.deepEqual({ ...result }, { media: 6, streams: 2, played: 1, rerouted: 1, files: 2 });
  assert.equal(remote.plays, 1);
  assert.deepEqual(rerouted.sinks, [""]);
  for (const el of [ended, videoOnly, ringing, chime]) {
    assert.equal(el.plays, 0);
    assert.deepEqual(el.sinks, []);
  }
});

test("kickPageAudio sums the frames; a frame that does not answer is skipped", async () => {
  const frames = [
    { evaluate: async () => ({ media: 3, streams: 1, played: 1, rerouted: 0 }) },
    { evaluate: () => new Promise(() => {}) },
  ];
  const started = Date.now();
  const result = await kickPageAudio({ frames: () => frames });
  assert.equal(result.ok, true);
  assert.equal(result.frames, 1);
  assert.equal(result.streams, 1);
  assert.match(result.detail, /meeting streams 1/);
  assert.ok(Date.now() - started < 5_000);
});

// Ported from a downstream review (2026-10-27): the kick through kickPageAudio's frame walk.
/** A page with one frame per element list; the kick runs in a fresh context with only `document`. */
function pageWith(...frames) {
  return {
    frames: () => frames.map((elements) => ({ evaluate: async (source) => vm.runInNewContext(source, { document: { querySelectorAll: () => elements } }) })),
  };
}

test("kickPageAudio restarts paused live streams and leaves the page's own sound files alone", async () => {
  const remote = element({ stream: stream("live") });
  const playing = element({ stream: stream("live"), paused: false });
  const ring = element({ src: "https://meet.example/sounds/outgoingRinging.mp3", loop: true });
  const chime = element({ src: "https://meet.example/sounds/joined.mp3" });
  const result = await kickPageAudio(pageWith([remote, ring, chime, playing]));
  assert.equal(remote.plays, 1);
  assert.equal(playing.plays, 0);
  assert.equal(ring.plays + chime.plays, 0);
  assert.equal(result.ok, true);
  assert.equal(result.played, 1);
  assert.equal(result.files, 2);
  assert.match(result.detail, /restarted 1\b.*platform sound files left alone 2/);
});

test("kickPageAudio sums over frames and is not ok when no frame answered", async () => {
  const result = await kickPageAudio(pageWith([element({ stream: stream("live") })], [element({ stream: stream("live") })]));
  assert.equal(result.frames, 2);
  assert.equal(result.played, 2);
  const none = await kickPageAudio({ frames: () => [{ evaluate: async () => { throw new Error("detached"); } }] });
  assert.equal(none.ok, false);
});

test("recoverPageAudio only runs the rejoin step, and logs what it did", async () => {
  const logs = [];
  const ctx = { page: pageWith([element({ stream: stream("live") })]), log: (...args) => logs.push(args) };
  assert.equal((await recoverPageAudio(ctx, "reload")).ok, false);
  const result = await recoverPageAudio(ctx, "rejoin_audio");
  assert.equal(result.played, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0][2]).sort(), ["files", "media", "played", "rerouted", "streams"]);
});
