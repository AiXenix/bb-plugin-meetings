import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotRunner } from "../bot-runner.mjs";

test("stopping the sampler closes attribution at the stop request, before delayed teardown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-stop-timeline-"));
  try {
    const runner = new BotRunner(dir);
    runner.log = () => {};
    runner.config = { botName: "Fixture Bot", maxDurationSec: 60, aloneTimeoutSec: 30, silenceTimeoutSec: 0 };
    runner.state.joinedAt = Date.now();
    runner.selectors = { lagMs: { store: 700, tile: 700, track: 100 }, fusion: {} };
    let samples = 0;
    const adapter = {
      sample: async () => {
        samples++;
        if (samples === 3) runner.requestStop("SIGTERM");
        return { signals: { store: ["Анна"], tile: null, tracks: [] }, roster: ["Анна"], count: 2, ended: null, raw: {} };
      },
      sweep: async () => {},
    };
    runner.outcome = await runner.sampleLoop(adapter, { joinedAt: runner.state.joinedAt });
    const read = () => fs.readFileSync(path.join(dir, "speakers.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const beforeTeardown = read();
    assert.ok(beforeTeardown.some(event => event.speakers.includes("Анна")));
    assert.deepEqual(beforeTeardown.at(-1), { t: runner.stopRequestedAt, speakers: [], src: "end", lagMs: 0 });
    assert.deepEqual(runner.state.activeSpeakers, []);
    // Cleanup may finish much later than leaving the meeting; it must not
    // append another end marker or extend the last speaker across that gap.
    runner.recorder = { stop: async () => {}, bytes: () => 0 };
    await runner.cleanup();
    assert.deepEqual(read(), beforeTeardown);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
