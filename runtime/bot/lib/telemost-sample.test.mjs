// Telemost sample(): what the outlined tiles and the mixed audio slots become for the runner.
// The probe itself (DOM) is tested in Chrome by platform-adapters.browser.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleMeeting } from "../platform-telemost.mjs";
import { SpeakerFusion } from "./fusion.mjs";

/** A page whose only frame answers the probe with `probe` (a function of the call number, or a value). */
function fakeCtx(probe) {
  let calls = 0;
  const frame = {
    url: () => "https://telemost.yandex.ru/j/1",
    evaluate: async () => {
      calls += 1;
      const value = typeof probe === "function" ? probe(calls) : probe;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { page: { frames: () => [frame], mainFrame: () => frame }, config: { botName: "Test Bot" }, adapterState: {}, joinedAt: Date.now() };
}

const probe = (active, levels) => ({
  inMeeting: true,
  hasLeaveBtn: true,
  ended: false,
  names: ["Alice Example", "Гость"],
  active,
  totalParticipants: 4,
  tracks: levels.map((level, i) => ({ id: `goloom_mid_audio_${i}`, level, muted: false })),
});

test("outlined tiles become the store and tile signals; the mixed slots give levels without an identity", async () => {
  const sample = await sampleMeeting(fakeCtx(probe(["Alice Example"], [0.2, 0, 0])));
  assert.deepEqual(sample.signals.store, ["Alice Example"]);
  assert.deepEqual(sample.signals.tile, ["Alice Example"]);
  assert.deepEqual(sample.signals.tracks, [{ level: 0.2 }, { level: 0 }, { level: 0 }]);
  assert.deepEqual(sample.roster, ["Alice Example", "Гость"]);
  assert.equal(sample.count, 4);
  assert.deepEqual(sample.raw.levels, [0.2, 0, 0], "signals.jsonl keeps the levels");
  // The runner gives the deaf-bot guard exactly these levels.
  assert.deepEqual(sample.signals.tracks.map((track) => Number(track?.level) || 0), [0.2, 0, 0]);

  const quiet = await sampleMeeting(fakeCtx(probe([], [0.002, 0, 0])));
  assert.equal(quiet.signals.store, null);
  assert.equal(quiet.signals.tile, null);
  assert.deepEqual(quiet.signals.tracks, [{ level: 0.002 }, { level: 0 }, { level: 0 }]);

  const failed = await sampleMeeting(fakeCtx(new Error("frame detached")));
  assert.deepEqual(failed.signals, { store: null, tile: null, tracks: [] });
});

test("turn-taking over one mixed audio slot: the fusion follows the outline and never names the slot", async () => {
  // Alice and the guest take turns of 8 s; the first slot is loud whoever speaks (as recorded).
  const turns = ["Alice Example", "Гость", "Alice Example", "Гость", "Alice Example", "Гость"];
  const fusion = new SpeakerFusion({ botName: "Test Bot" });
  const t0 = 1_000_000;
  let wrong = 0;
  let speaking = 0;
  for (let i = 0; i < turns.length * 40; i += 1) {
    const t = t0 + i * 200;
    const who = turns[Math.floor(i / 40)];
    const sample = await sampleMeeting(fakeCtx(probe([who], [0.15, 0, 0])));
    const { fused } = fusion.push(t, sample.signals);
    assert.notEqual(fused.src, "track");
    if (i % 40 >= 4) {
      speaking += 1;
      if (fused.speakers.join("|") !== who) wrong += 1;
    }
  }
  assert.equal(wrong, 0, `fused speaker differs from the outline in ${wrong} of ${speaking} samples`);
  assert.deepEqual(fusion.resolver.mapping(), {});
});
