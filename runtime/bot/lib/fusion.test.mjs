// Unit tests for speaker fusion, track voting, debounce and the leave rules.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmsS16le } from "./av.mjs";
import {
  AloneDetector,
  Debouncer,
  SilenceDetector,
  SpeakerFusion,
  TrackResolver,
  cleanNames,
  normalizeName,
  sameSet,
} from "./fusion.mjs";

describe("names", () => {
  it("strips Zoom role suffixes and whitespace", () => {
    assert.equal(normalizeName("  Анна   Смирнова (Host) "), "Анна Смирнова");
    assert.equal(normalizeName("Bob (Host, me)"), "Bob");
    assert.equal(normalizeName("Carol (Co-host)"), "Carol");
    assert.equal(normalizeName("Dan (Guest)"), "Dan");
    assert.equal(normalizeName("Eve (Me)"), "Eve");
    assert.equal(normalizeName("Team (Marketing)"), "Team (Marketing)");
    assert.equal(normalizeName("Notetaker connected to audio"), "Notetaker");
    assert.equal(normalizeName("Анна (Host) disconnected from computer audio"), "Анна");
    assert.equal(normalizeName("Bob has joined the meeting"), "Bob");
    assert.equal(normalizeName(null), "");
  });

  it("excludes the bot, dedupes and sorts", () => {
    assert.deepEqual(cleanNames(["Bob", "notetaker", "Anna (Host)", "Bob ", ""], "Notetaker"), ["Anna", "Bob"]);
    assert.ok(sameSet(["a", "b"], ["b", "a"]));
    assert.ok(!sameSet(["a"], ["a", "b"]));
  });
});

describe("Debouncer", () => {
  it("emits after two equal samples with the first observation time", () => {
    const d = new Debouncer(2);
    assert.equal(d.push(1000, ["A"], "store"), null);
    assert.deepEqual(d.push(1250, ["A"], "track"), { t: 1000, speakers: ["A"], src: "store" });
    assert.equal(d.push(1500, ["A"], "store"), null, "no event without a change");
  });

  it("ignores single-sample flicker and reports the change to []", () => {
    const d = new Debouncer(2);
    d.push(0, ["A"], "tile");
    d.push(250, ["A"], "tile");
    assert.equal(d.push(500, ["B"], "tile"), null);
    assert.equal(d.push(750, ["A"], "tile"), null, "back to the current set cancels the pending one");
    assert.equal(d.push(1000, ["B"], "tile"), null);
    assert.equal(d.push(1250, ["C"], "tile"), null, "a different pending set restarts the count");
    assert.equal(d.push(1500, [], "tile"), null);
    assert.deepEqual(d.push(1750, [], "tile"), { t: 1500, speakers: [], src: "tile" });
  });
});

describe("TrackResolver", () => {
  it("adopts a name after enough votes with a margin", () => {
    const r = new TrackResolver({ minVotes: 3, voteMargin: 2 });
    r.vote("t1", "A");
    r.vote("t1", "A");
    assert.equal(r.resolve("t1"), null);
    r.vote("t1", "A");
    assert.equal(r.resolve("t1"), "A");
    r.vote("t1", "A");
    r.vote("t1", "A");
    r.vote("t1", "B");
    assert.equal(r.resolve("t1"), "A", "one stray vote does not flip it");
    assert.equal(r.resolve("unknown"), null);
  });

  it("relearns a reassigned track, unresolved in between", () => {
    const r = new TrackResolver({ minVotes: 3, voteMargin: 2, maxVotes: 20 });
    for (let i = 0; i < 40; i += 1) r.vote("t1", "A");
    const seen = new Set();
    let flipped = null;
    for (let i = 1; i <= 60 && flipped === null; i += 1) {
      r.vote("t1", "B");
      seen.add(r.resolve("t1"));
      if (r.resolve("t1") === "B") flipped = i;
    }
    assert.ok(flipped !== null && flipped <= 30, `flipped after ${flipped} votes`);
    assert.ok(seen.has(null), "passes through 'unknown' instead of jumping");
  });

  it("does not trust a track that carries two voices", () => {
    const r = new TrackResolver({ minVotes: 3, voteMargin: 2, maxVotes: 20 });
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 8; i += 1) r.vote("mixed", "A");
      for (let i = 0; i < 8; i += 1) r.vote("mixed", "B");
      if (round > 0) assert.equal(r.resolve("mixed"), null, `round ${round}`);
    }
  });
});

/** Drive the fusion at 4 Hz with a scenario function t → sample. */
function simulate(fusion, fromMs, toMs, sample, stepMs = 250) {
  const events = [];
  for (let t = fromMs; t < toMs; t += stepMs) {
    const out = fusion.push(t, sample(t));
    if (out.event) events.push(out.event);
  }
  return events;
}

describe("SpeakerFusion", () => {
  it("uses the store with its lag and never reports the bot", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    const events = simulate(f, 0, 3000, (t) => ({
      store: t < 1000 ? ["Notetaker"] : ["Анна"],
      tile: ["Борис"],
      tracks: [],
    }));
    assert.deepEqual(events, [{ t: 1000, speakers: ["Анна"], src: "store", lagMs: 700 }]);
  });

  it("falls back to the tile when the store is unavailable", () => {
    const f = new SpeakerFusion({ botName: "Notetaker", lagMs: { tile: 1500 } });
    const events = simulate(f, 0, 1000, () => ({ store: null, tile: ["Вера (Host)"], tracks: [] }));
    assert.deepEqual(events, [{ t: 0, speakers: ["Вера"], src: "tile", lagMs: 1500 }]);
  });

  it("learns which track is whose and then reports precise track timing", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    // A talks 0–6 s on track tA; the store lights A from 0.7 s (lag) to 6.7 s.
    const phase1 = simulate(f, 0, 8000, (t) => ({
      store: t >= 700 && t < 6700 ? ["A"] : [],
      tile: null,
      tracks: [
        { id: "tA", level: t < 6000 ? 0.1 : 0.0 },
        { id: "tB", level: 0.0 },
      ],
    }));
    assert.equal(f.resolver.resolve("tA"), "A");
    assert.equal(f.resolver.resolve("tB"), null);
    assert.equal(phase1[0].src, "store");
    // A talks again at 10 s: the track reports it at once, long before the store.
    const phase2 = simulate(f, 8000, 12000, (t) => ({
      store: t >= 10700 ? ["A"] : [],
      tile: null,
      tracks: [
        { id: "tA", level: t >= 10000 ? 0.1 : 0.0 },
        { id: "tB", level: 0.0 },
      ],
    }));
    assert.deepEqual(phase2[0], { t: 10000, speakers: ["A"], src: "track", lagMs: 100 });
  });

  it("does not let a sticky indicator of the previous speaker vote for the next one", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    // The tile keeps showing A while B talks on track tB for 4 s.
    simulate(f, 0, 4000, () => ({ store: null, tile: ["A"], tracks: [{ id: "tA", level: 0.1 }] }));
    simulate(f, 4000, 8000, () => ({ store: null, tile: ["A"], tracks: [{ id: "tA", level: 0 }, { id: "tB", level: 0.1 }] }));
    assert.equal(f.resolver.resolve("tA"), "A");
    assert.notEqual(f.resolver.resolve("tB"), "A");
  });

  it("reports overlapping speech from two resolved tracks", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    simulate(f, 0, 4000, () => ({ store: ["A"], tile: null, tracks: [{ id: "tA", level: 0.1 }, { id: "tB", level: 0 }] }));
    simulate(f, 4000, 6000, () => ({ store: [], tile: null, tracks: [{ id: "tA", level: 0 }, { id: "tB", level: 0 }] }));
    simulate(f, 6000, 10000, () => ({ store: ["B"], tile: null, tracks: [{ id: "tA", level: 0 }, { id: "tB", level: 0.1 }] }));
    simulate(f, 10000, 12000, () => ({ store: [], tile: null, tracks: [{ id: "tA", level: 0 }, { id: "tB", level: 0 }] }));
    assert.deepEqual(f.resolver.mapping(), { tA: "A", tB: "B" });
    const events = simulate(f, 12000, 13000, () => ({ store: ["A"], tile: null, tracks: [{ id: "tA", level: 0.1 }, { id: "tB", level: 0.1 }] }));
    assert.deepEqual(events[0].speakers, ["A", "B"]);
    assert.equal(events[0].src, "track");
  });

  it("stops trusting a track when the store keeps showing someone else on it", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    // A talks 8 s on track t1: learned as A.
    simulate(f, 0, 8000, (t) => ({ store: t >= 700 ? ["A"] : [], tile: null, tracks: [{ id: "t1", level: 0.1 }] }));
    simulate(f, 8000, 10000, () => ({ store: [], tile: null, tracks: [{ id: "t1", level: 0 }] }));
    assert.equal(f.resolver.resolve("t1"), "A");
    // Zoom reuses t1 for B: the store lights B while t1 is loud.
    const events = simulate(f, 10000, 14000, (t) => ({ store: t >= 10700 ? ["B"] : [], tile: null, tracks: [{ id: "t1", level: 0.1 }] }));
    const last = events.at(-1);
    assert.deepEqual(last.speakers, ["B"], JSON.stringify(events));
    assert.ok(last.t <= 12300, `switched to B at ${last.t}`);
    assert.notEqual(f.resolver.resolve("t1"), "A");
  });

  /** A and B take 4 s turns with 1 s gaps; the tile follows 1.2 s late and sticks; the store follows 0.7 s late unless broken. */
  const turns = (storeWorks) => (t) => {
    const k = Math.floor(t / 5000);
    const within = t % 5000;
    const who = (i) => (i % 2 === 0 ? "A" : "B");
    const tile = within >= 1200 ? [who(k)] : k > 0 ? [who(k - 1)] : [];
    const store = storeWorks && within >= 700 && within < 4700 ? [who(k)] : [];
    const talking = within < 4000 ? who(k) : null;
    return { store, tile, tracks: [{ id: "tA", level: talking === "A" ? 0.1 : 0 }, { id: "tB", level: talking === "B" ? 0.1 : 0 }] };
  };

  it("uses the tile when a found store never names a speaker", () => {
    // Zoom changed its active-speaker state: the store keeps the roster but its speaker set stays empty.
    const f = new SpeakerFusion({ botName: "Notetaker" });
    const events = simulate(f, 0, 40_000, turns(false));
    assert.ok(events.some((e) => e.speakers.includes("A")), JSON.stringify(events));
    assert.ok(events.some((e) => e.speakers.includes("B")), JSON.stringify(events));
    assert.deepEqual(f.resolver.mapping(), { tA: "A", tB: "B" }, "the tracks learn their names from the tile");
    assert.ok(events.some((e) => e.src === "track"));
    // The store's first speaker brings it back.
    const back = simulate(f, 40_000, 42_000, () => ({ store: ["C"], tile: ["A"], tracks: [] }));
    assert.deepEqual(back.at(-1)?.speakers, ["C"]);
    assert.equal(back.at(-1)?.src, "store");
  });

  it("keeps a working store's silence over a sticky tile", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    simulate(f, 0, 40_000, turns(true));
    // Nobody talks; the tile keeps the last speaker.
    const events = simulate(f, 40_000, 60_000, () => ({ store: [], tile: ["B"], tracks: [{ id: "tA", level: 0 }, { id: "tB", level: 0 }] }));
    assert.deepEqual(f.current, [], JSON.stringify(events));
    assert.ok(!events.some((e) => e.src === "tile"), JSON.stringify(events));
  });

  it("closes the timeline at the end", () => {
    const f = new SpeakerFusion({ botName: "Notetaker" });
    simulate(f, 0, 1000, () => ({ store: ["A"], tile: null, tracks: [] }));
    assert.deepEqual(f.finish(5000), { t: 5000, speakers: [], src: "end", lagMs: 0 });
    assert.equal(f.finish(6000), null);
  });
});

describe("AloneDetector", () => {
  it("leaves when nobody ever came", () => {
    const a = new AloneDetector(60_000, 0);
    assert.equal(a.update(30_000, 1), false);
    assert.equal(a.update(59_999, 1), false);
    assert.equal(a.update(60_000, 1), true);
  });

  it("counts from the moment the others left", () => {
    const a = new AloneDetector(60_000, 0);
    assert.equal(a.update(10_000, 3), false);
    assert.equal(a.update(100_000, 2), false);
    assert.equal(a.update(120_000, 1), false);
    assert.equal(a.update(179_000, 1), false);
    assert.equal(a.update(180_000, 1), true);
    assert.equal(a.othersSeen, true);
  });

  it("never leaves on an unknown count", () => {
    const a = new AloneDetector(10_000, 0);
    assert.equal(a.update(50_000, null), false);
    assert.equal(a.update(50_250, 2), false);
    assert.equal(a.update(70_000, null), false);
  });
});

describe("SilenceDetector", () => {
  it("leaves after the timeout without sound and resets on sound", () => {
    const s = new SilenceDetector(30_000, 0);
    assert.equal(s.update(20_000, 0), false);
    assert.equal(s.update(25_000, 0.05), false);
    assert.equal(s.update(54_000, 0.0001), false);
    assert.equal(s.update(55_000, null), true);
  });

  it("is off with a zero timeout", () => {
    const s = new SilenceDetector(0, 0);
    assert.equal(s.update(10_000_000, 0), false);
  });
});

describe("rmsS16le", () => {
  it("measures a half-scale sine", () => {
    const n = 16000;
    const buffer = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) buffer.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
    assert.ok(Math.abs(rmsS16le(buffer) - 0.3536) < 0.002);
    assert.equal(rmsS16le(Buffer.alloc(0)), 0);
  });
});
