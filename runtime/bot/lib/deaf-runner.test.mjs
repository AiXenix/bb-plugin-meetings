// The deaf-bot guard inside bot-runner's sampling loop (DESIGN §6.8): a fake
// adapter whose speaking indicators keep changing (or whose tracks sound) while
// audio.pcm grows with digital zeros. Short guard timings via
// speakerSelectors.deafGuard.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BotRunner } from "../bot-runner.mjs";

const FAST = { windowMs: 2_000, minSpeakingMs: 800, minChanges: 2, captureSoundMs: 800, retryMs: 1_200, persistentRetryMs: 2_000, recoverySpanMs: 900, recoveryWindowMs: 4_000 };

function readJsonl(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function makeRunner(dir) {
  const runner = new BotRunner(dir);
  runner.config = { botName: "Fixture Bot", maxDurationSec: 120, aloneTimeoutSec: 60, silenceTimeoutSec: 0, screenshotIntervalSec: 0, platform: "mock" };
  runner.state.joinedAt = Date.now();
  runner.state.phase = "in_meeting";
  runner.loggedPhase = "in_meeting";
  runner.selectors = { lagMs: { store: 700, tile: 700, track: 100 }, fusion: {}, deafGuard: FAST };
  return runner;
}

/** Appends 100 ms of s16le audio every 100 ms: zeros, or a loud square wave while `loud()`. */
function feedPcm(file, loud) {
  const silent = Buffer.alloc(3_200);
  const sound = Buffer.alloc(3_200);
  for (let i = 0; i < 1_600; i += 1) sound.writeInt16LE(i % 40 < 20 ? 8_000 : -8_000, i * 2);
  fs.writeFileSync(file, "");
  const timer = setInterval(() => fs.appendFileSync(file, loud() ? sound : silent), 100);
  return () => clearInterval(timer);
}

test("deaf guard in the sampler: ladder, warning in state.json, recovery, decisions in events.jsonl", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-deaf-runner-"));
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  let loud = false;
  const stopFeed = feedPcm(path.join(dir, "audio.pcm"), () => loud);
  try {
    const runner = makeRunner(dir);
    const calls = [];
    const issues = [];
    const adapter = {
      sample: async () => {
        const who = ["Анна", "Борис", "Вера"][Math.floor(Date.now() / 400) % 3];
        return { signals: { store: [who], tile: null, tracks: [{ id: "t1", level: loud ? 0.05 : 0 }] }, roster: ["Анна", "Борис", "Вера"], count: 4, ended: null, raw: {} };
      },
      sweep: async () => [],
      recoverAudio: async (ctx, step) => {
        calls.push(step);
        issues.push(runner.state.audioIssue);
        return { ok: true, detail: "fake rejoin" };
      },
      join: async (ctx) => {
        calls.push("join");
        ctx.setPhase("waiting_room", "In the waiting room");
        issues.push(runner.state.audioIssue);
        ctx.setPhase("joining", "Joining");
      },
    };
    const ctx = { joinedAt: runner.state.joinedAt, setPhase: runner.setPhase, adapterState: { stale: true }, log: runner.log, signal: runner.stopController.signal };
    const done = runner.sampleLoop(adapter, ctx);

    const waitFor = async (check, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    // rejoin, rejoin, reload (join), warning, then the persistent rejoin.
    assert.ok(await waitFor(() => calls.length >= 4, 30_000), `calls: ${calls}`);
    assert.deepEqual(calls.slice(0, 4), ["rejoin_audio", "rejoin_audio", "join", "rejoin_audio"]);
    assert.equal(issues[0].escalated, false);
    assert.equal(issues[0].attempts, 1);
    assert.match(issues[0].message, /^Бот не слышит участников встречи/);
    // While the reload sits in the waiting room the warning asks the host to admit the bot.
    assert.match(issues[2].message, /в зале ожидания: впустите «Fixture Bot»/);
    assert.equal(issues[3].escalated, true);
    assert.deepEqual(ctx.adapterState, {}, "the reload starts the adapter state afresh");
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.audioIssue.escalated, true);
    assert.equal(state.phase, "in_meeting", "the reload keeps the in_meeting phase");

    // Sound comes back: the issue clears.
    loud = true;
    assert.ok(await waitFor(() => runner.state.audioIssue === null, 10_000), "audioIssue cleared");
    runner.requestStop("test");
    const outcome = await done;
    assert.equal(outcome.endReason, "stopped");

    const events = readJsonl(path.join(dir, "events.jsonl"));
    const msgs = events.map((e) => e.msg);
    assert.ok(msgs.some((m) => /^Deaf bot: participants speak, but the recording is digital silence/.test(m)), "detection logged");
    assert.ok(events.some((e) => /^Deaf bot: still no meeting audio after 3 recovery attempt/.test(e.msg) && e.level === "warn"), "warning logged");
    assert.ok(msgs.some((m) => /^Audio recovered after/.test(m)), "recovery logged");
    const detected = events.find((e) => /^Deaf bot: participants speak/.test(e.msg));
    assert.equal(detected.data.changes >= 2 && detected.data.speakingSec >= 0.8, true, JSON.stringify(detected.data));
    assert.equal(detected.data.peakDbfs, null);
    // The reload closed the speaker timeline while the bot was outside.
    assert.ok(readJsonl(path.join(dir, "speakers.jsonl")).some((l) => l.src === "none" && l.speakers.length === 0));
    assert.deepEqual(state.participants.count, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).audioIssue, null);
  } finally {
    stopFeed();
    console.log = quiet.log;
    console.error = quiet.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reload that cannot get back in ends the recording with that error; the issue stays in the final state", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-deaf-runner-"));
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  const stopFeed = feedPcm(path.join(dir, "audio.pcm"), () => false);
  try {
    const runner = makeRunner(dir);
    runner.selectors.deafGuard = { ...FAST, ladder: ["reload"] };
    const { BotError } = await import("./proc.mjs");
    const adapter = {
      sample: async () => ({ signals: { store: [["Анна", "Борис"][Math.floor(Date.now() / 400) % 2]], tile: null, tracks: [] }, roster: null, count: 3, ended: null, raw: {} }),
      sweep: async () => [],
      join: async () => {
        throw new BotError("waiting_timeout", "Not admitted within 1 min (waiting room)");
      },
    };
    const ctx = { joinedAt: runner.state.joinedAt, setPhase: runner.setPhase, adapterState: {}, log: runner.log, signal: runner.stopController.signal };
    const outcome = await runner.sampleLoop(adapter, ctx);
    assert.equal(outcome.phase, "failed");
    assert.equal(outcome.error.code, "waiting_timeout");
    runner.outcome = outcome;
    runner.writeTerminalState();
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.phase, "failed");
    assert.match(state.audioIssue.message, /^Бот не слышал участников встречи до конца записи/);
    assert.match(state.audioIssue.message, /перезагрузить страницу встречи \(1 раз\)/);
  } finally {
    stopFeed();
    console.log = quiet.log;
    console.error = quiet.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an audio rejoin that overruns is called off: it stops clicking before the sampler goes on", { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-deaf-runner-"));
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    const runner = makeRunner(dir);
    runner.audioRecoveryTimeoutMs = 400;
    const clicks = [];
    let seenSignal = null;
    const adapter = {
      // A Zoom page that keeps answering "not joined": the step would click on for a long time.
      recoverAudio: async (ctx) => {
        seenSignal = ctx.signal;
        while (!ctx.signal.aborted) {
          clicks.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { ok: false, detail: "called off" };
      },
    };
    const ctx = { joinedAt: Date.now(), setPhase: runner.setPhase, adapterState: {}, log: runner.log, signal: runner.stopController.signal };
    const result = await runner.rejoinAudio(adapter, ctx);
    const returnedAt = Date.now();
    assert.equal(result.ok, false);
    assert.match(result.detail, /no answer within 0\.4 s; called off/);
    assert.equal(seenSignal.aborted, true);
    assert.equal(ctx.signal.aborted, false, "the runner's own stop signal is untouched");
    const before = clicks.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(clicks.length, before, "no clicks after the step returned");
    assert.ok(clicks.every((t) => t <= returnedAt));

    // A step that throws reports the error instead of "no answer".
    const failing = await runner.rejoinAudio({ recoverAudio: async () => { throw new Error("page crashed\nstack"); } }, ctx);
    assert.deepEqual(failing, { ok: false, detail: "page crashed" });
  } finally {
    console.log = quiet.log;
    console.error = quiet.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- review regressions (downstream reviews, 2026-10-27)

/** Runs `body(runner, ctx, dir)` with console output muted and the PCM feed running; cleans up afterwards. */
async function withRunner({ loud = () => false, config = {} } = {}, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-deaf-runner-"));
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  const stopFeed = feedPcm(path.join(dir, "audio.pcm"), loud);
  try {
    const runner = makeRunner(dir);
    Object.assign(runner.config, config);
    runner.page = { isClosed: () => false, frames: () => [] };
    const ctx = { joinedAt: runner.state.joinedAt, setPhase: runner.setPhase, adapterState: {}, log: runner.log, signal: runner.stopController.signal };
    return await body(runner, ctx, dir);
  } finally {
    stopFeed();
    console.log = quiet.log;
    console.error = quiet.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rotating = (names = ["Анна", "Борис", "Вера"]) => names[Math.floor(Date.now() / 400) % names.length];

test("a failed sample is unknown, not 'nobody speaks': a sticky indicator over silence triggers no recovery", { timeout: 30_000 }, async () => {
  await withRunner({}, async (runner, ctx, dir) => {
    const calls = [];
    let n = 0;
    const adapter = {
      // Screen share: one sticky name, nobody talks (digital silence), every 6th sample times out.
      sample: async () => {
        n += 1;
        if (n % 6 === 0) throw new Error("page.evaluate: Timeout 4000ms exceeded");
        return { signals: { store: ["Анна"], tile: null, tracks: [{ id: "t1", level: 0 }] }, roster: ["Анна", "Борис"], count: 3, ended: null, raw: {} };
      },
      sweep: async () => [],
      recoverAudio: async (c, step) => {
        calls.push(step);
        return { ok: true };
      },
      join: async () => {
        calls.push("join");
      },
    };
    const done = runner.sampleLoop(adapter, ctx);
    await sleepMs(6_000);
    runner.requestStop("test");
    await done;
    assert.ok(n > 20, `samples: ${n}`);
    assert.deepEqual(calls, []);
    assert.equal(runner.state.audioIssue, null);
    assert.ok(readJsonl(path.join(dir, "events.jsonl")).some((e) => /sticky/.test(e.msg)), "the sticky decision is logged");
  });
});

test("a page whose samples mostly fail still shows its speakers to the guard (failed samples are passed as unknown)", { timeout: 45_000 }, async () => {
  await withRunner({}, async (runner, ctx) => {
    // Successful samples come ~1.1 s apart: a 5 s window holds enough speaker changes. Read as
    // "nobody lit", the failed ones would leave 20% of it as speaking time (< minSpeakingMs 40%).
    runner.selectors.deafGuard = { ...FAST, windowMs: 5_000, minSpeakingMs: 2_000 };
    const calls = [];
    let n = 0;
    const adapter = {
      // Four of five samples time out; the ones that answer show people taking turns over digital silence.
      sample: async () => {
        n += 1;
        if (n % 5 !== 0) throw new Error("page.evaluate: Timeout 4000ms exceeded");
        return { signals: { store: [rotating()], tile: null, tracks: [{ id: "t1", level: 0 }] }, roster: null, count: 4, ended: null, raw: {} };
      },
      sweep: async () => [],
      recoverAudio: async (c, step) => {
        calls.push(step);
        return { ok: false };
      },
      join: async () => {
        calls.push("join");
      },
    };
    const done = runner.sampleLoop(adapter, ctx);
    const until = Date.now() + 25_000;
    while (calls.length === 0 && Date.now() < until) await sleepMs(100);
    runner.requestStop("test");
    await done;
    assert.equal(calls[0], "rejoin_audio", "the deafness was detected although most samples failed");
  });
});

test("a deaf bot is not sent home by the silence timeout while the meeting keeps talking, also while one person talks alone; once nobody is lit it is", { timeout: 60_000 }, async () => {
  await withRunner({ config: { silenceTimeoutSec: 3 } }, async (runner, ctx) => {
    /** "turns": people take turns; "one": one person keeps talking (a steady indicator); "nobody". */
    let talking = "turns";
    const calls = [];
    const adapter = {
      sample: async () => ({ signals: { store: talking === "turns" ? [rotating()] : talking === "one" ? ["Анна"] : [], tile: null, tracks: [{ id: "t1", level: 0 }] }, roster: ["Анна", "Борис", "Вера"], count: 4, ended: null, raw: {} }),
      sweep: async () => [],
      recoverAudio: async () => {
        calls.push(Date.now());
        return { ok: true, detail: "fake rejoin" };
      },
      join: async () => {
        calls.push(Date.now());
      },
    };
    const started = Date.now();
    let outcome = null;
    const done = runner.sampleLoop(adapter, ctx).then((value) => (outcome = value));
    while (Date.now() - started < 9_000 && outcome === null) await sleepMs(100);
    assert.equal(outcome, null, `the bot left: ${JSON.stringify(outcome)}`);
    assert.ok(calls.length >= 3, `recovery kept going: ${calls.length}`);
    assert.notEqual(runner.state.audioIssue, null);
    // Verifier review 2026-10-27 (mtg_mvgr928zgps9 zeroed): one person talking without speaker changes
    // still holds the timeout, and the warning's persistent audio rejoins go on.
    const escalatedUntil = Date.now() + 10_000;
    while (!runner.state.audioIssue?.escalated && Date.now() < escalatedUntil && outcome === null) await sleepMs(100);
    assert.equal(runner.state.audioIssue?.escalated, true, "escalated");
    talking = "one";
    const before = calls.length;
    const oneFrom = Date.now();
    while (Date.now() - oneFrom < 9_000 && outcome === null) await sleepMs(100);
    assert.equal(outcome, null, `the bot left while one person talked: ${JSON.stringify(outcome)}`);
    assert.ok(calls.length - before >= 2, `persistent rejoins while one person talked: ${calls.length - before}`);
    // Nobody is lit any more: now the silence timeout may end it.
    talking = "nobody";
    const stoppedAt = Date.now();
    while (Date.now() - stoppedAt < 10_000 && outcome === null) await sleepMs(100);
    if (outcome === null) runner.requestStop("test");
    await done;
    assert.equal(outcome.endReason, "silence", JSON.stringify(outcome));
    assert.ok(Date.now() - stoppedAt >= 2_500, "counted from the last talk");
  });
});

test("the silence timeout does not end a deaf meeting while participants speak, and does once they stop", { timeout: 60_000 }, async () => {
  await withRunner({ config: { silenceTimeoutSec: 3 } }, async (runner, ctx) => {
    runner.selectors.deafGuard = { ...FAST, retryMs: 1_500 };
    const calls = [];
    const talkUntil = Date.now() + 12_000;
    const adapter = {
      sample: async () => ({ signals: { store: Date.now() < talkUntil ? [rotating()] : [], tile: null, tracks: [] }, roster: null, count: 4, ended: null, raw: {} }),
      sweep: async () => [],
      recoverAudio: async (c, step) => {
        calls.push(step);
        return { ok: false, detail: "fake: still nothing" };
      },
      join: async () => {
        calls.push("join");
      },
    };
    const started = Date.now();
    const outcome = await runner.sampleLoop(adapter, ctx);
    const ranMs = Date.now() - started;
    assert.equal(outcome.endReason, "silence", JSON.stringify(outcome));
    assert.ok(ranMs >= 12_000, `ended after ${ranMs} ms, while participants were still speaking`);
    assert.deepEqual(calls.slice(0, 4), ["rejoin_audio", "rejoin_audio", "join", "rejoin_audio"]);
    assert.equal(runner.state.audioIssue.escalated, true, "the warning stays to the end");
  });
});

test("a reload that waited in the waiting room longer than the silence timeout does not end the meeting on rejoin", { timeout: 60_000 }, async () => {
  await withRunner({ config: { silenceTimeoutSec: 3 } }, async (runner, ctx) => {
    runner.selectors.deafGuard = { ...FAST, ladder: ["reload"] };
    let reloaded = false;
    const adapter = {
      sample: async () => ({ signals: { store: [rotating(["Анна", "Борис"])], tile: null, tracks: [] }, roster: null, count: 3, ended: null, raw: {} }),
      sweep: async () => [],
      recoverAudio: async () => ({ ok: false }),
      join: async (c) => {
        c.setPhase("waiting_room", "In the waiting room");
        await sleepMs(4_000); // longer than silenceTimeoutSec
        reloaded = true;
      },
    };
    let finished = null;
    const done = runner.sampleLoop(adapter, ctx).then((outcome) => (finished = outcome));
    const until = Date.now() + 20_000;
    while (!reloaded && Date.now() < until) await sleepMs(100);
    assert.ok(reloaded, "the reload ran");
    await sleepMs(1_500);
    assert.equal(finished, null, `the meeting ended right after the reload: ${JSON.stringify(finished)}`);
    runner.requestStop("test");
    await done;
    assert.equal(finished.endReason, "stopped", JSON.stringify(finished));
  });
});

test("a rejoin step that overruns its timeout is told to stop; Stop aborts a running step", { timeout: 30_000 }, async () => {
  await withRunner({}, async (runner, ctx, dir) => {
    runner.audioRecoveryTimeoutMs = 300;
    const steps = [];
    const adapter = {
      sample: async () => ({ signals: { store: [rotating()], tile: null, tracks: [] }, roster: null, count: 4, ended: null, raw: {} }),
      sweep: async () => [],
      recoverAudio: async (c) => {
        const step = { signal: c.signal, startedAt: Date.now(), endedAt: null, shared: c.adapterState === ctx.adapterState };
        steps.push(step);
        while (!c.signal.aborted) await sleepMs(20); // a page that never answers
        step.endedAt = Date.now();
        return { ok: false, detail: "aborted" };
      },
      join: async () => {},
    };
    const done = runner.sampleLoop(adapter, ctx);
    const until = Date.now() + 15_000;
    while (!(steps.length >= 1 && steps[0].endedAt !== null) && Date.now() < until) await sleepMs(50);
    assert.ok(steps[0]?.endedAt, "the overrunning step ended");
    assert.ok(steps[0].endedAt - steps[0].startedAt < 1_500, `ran ${steps[0].endedAt - steps[0].startedAt} ms`);
    assert.equal(steps[0].shared, true, "the step still shares the adapter state");
    assert.equal(ctx.signal.aborted, false, "the meeting itself is not stopped");
    assert.ok(readJsonl(path.join(dir, "events.jsonl")).some((e) => e.msg === "Deaf bot: rejoining the meeting audio did not work" && /no answer within/.test(e.data?.detail ?? "")));
    // A long step is cut short by Stop.
    runner.audioRecoveryTimeoutMs = 60_000;
    while (steps.length < 2 && Date.now() < until + 10_000) await sleepMs(50);
    assert.equal(steps.length >= 2, true, "a second step started");
    runner.requestStop("test");
    const outcome = await done;
    assert.equal(outcome.endReason, "stopped");
    assert.ok(steps[1].signal.aborted && steps[1].endedAt !== null);
  });
});

test("a stop that arrives before a recovery step runs is not turned into a page reload", { timeout: 30_000 }, async () => {
  await withRunner({}, async (runner, ctx) => {
    let joins = 0;
    let rejoins = 0;
    const adapter = {
      join: async () => {
        joins += 1;
      },
      recoverAudio: async () => {
        rejoins += 1;
        return { ok: true };
      },
    };
    runner.requestStop("test");
    const reload = await runner.reloadAndRejoin(adapter, ctx);
    assert.equal(reload.result.ok, false);
    assert.equal(reload.end, null);
    assert.equal((await runner.rejoinAudio(adapter, ctx)).ok, false);
    // Telemost/Meet/Jitsi (no recoverAudio): the media kick is skipped as well.
    assert.equal((await runner.rejoinAudio({}, ctx)).detail, "stopping; not run");
    assert.equal(joins, 0, "the meeting page was not left for the join link");
    assert.equal(rejoins, 0);
  });
});

test("a wall clock that steps back keeps the sampler and its timers going: popup sweep, signals.jsonl, no-speaker dump", { timeout: 30_000 }, async () => {
  // Verifier review 2026-10-27: after a backward step these timers waited until the clock caught up,
  // and a step during a tick made the sampler sleep for the size of the step.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    await withRunner({ loud: () => true, config: { maxDurationSec: 24 * 3600 } }, async (runner, ctx, dir) => {
      const sweeps = [];
      const dumps = [];
      let samples = 0;
      let stepBack = false;
      runner.dumpDebug = async (tag) => {
        dumps.push(tag);
      };
      const adapter = {
        // Audio plays, but no speaker is ever detected: the no-speaker forensics case.
        sample: async () => {
          samples += 1;
          if (stepBack) {
            stepBack = false;
            offset -= 3_600_000; // NTP steps the clock back an hour, in the middle of a tick
          }
          return { signals: { store: [], tile: null, tracks: [] }, roster: null, count: 3, ended: null, raw: {} };
        },
        sweep: async () => {
          sweeps.push(Date.now());
          return [];
        },
      };
      const signalLines = () => readJsonl(path.join(dir, "signals.jsonl")).length;
      const done = runner.sampleLoop(adapter, ctx);
      try {
        await sleepMs(3_600);
        assert.ok(sweeps.length >= 1, "a sweep before the step");
        offset += 130_000; // 130 s without a speaker while audio plays
        await sleepMs(800);
        assert.deepEqual(dumps, ["no-speaker"]);
        stepBack = true;
        while (stepBack) await sleepMs(20);
        const before = { samples, sweeps: sweeps.length, signals: signalLines() };
        await sleepMs(3_800);
        assert.ok(samples - before.samples >= 5, `samples after the step: ${samples - before.samples}`);
        assert.ok(sweeps.length > before.sweeps, "the popup sweep goes on after the step");
        assert.ok(signalLines() >= before.signals + 3, `signals.jsonl lines after the step: ${signalLines() - before.signals}`);
        offset += 130_000; // another 130 s without a speaker: still ~58 min before the first dump's time
        await sleepMs(800);
        assert.deepEqual(dumps, ["no-speaker", "no-speaker"], "the no-speaker dump timer restarted");
      } finally {
        runner.requestStop("test"); // also wakes a sampler that sleeps
        await done;
      }
    });
  } finally {
    Date.now = realNow;
  }
});

test("capture in the sampler: the tracks sound, the recording stays silent; only the recording ends the episode", { timeout: 60_000 }, async () => {
  let loud = false;
  await withRunner({ loud: () => loud }, async (runner, ctx, dir) => {
    const calls = [];
    const adapter = {
      // No speaking indicators at all (as on Telemost); the participants' tracks carry sound throughout.
      sample: async () => ({ signals: { store: [], tile: null, tracks: [{ id: "t1", level: 0.05 }, { id: "t2", level: 0 }] }, roster: null, count: 3, ended: null, raw: {} }),
      sweep: async () => [],
      recoverAudio: async (c, step) => {
        calls.push(step);
        return { ok: true, detail: "fake rejoin" };
      },
      join: async () => {
        calls.push("join");
      },
    };
    const done = runner.sampleLoop(adapter, ctx);
    const until = Date.now() + 30_000;
    while (calls.length < 4 && Date.now() < until) await sleepMs(100);
    assert.deepEqual(calls.slice(0, 4), ["rejoin_audio", "rejoin_audio", "join", "rejoin_audio"], "the same ladder; the tracks never counted as recovered");
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.audioIssue.reason, "capture");
    assert.equal(state.audioIssue.escalated, true);
    assert.match(state.audioIssue.message, /^Бот слышит участников, но звук не попадает в запись\./);
    assert.match(state.detail, /^Recording, but the meeting audio does not reach the recording/);
    // The recording gets the sound: the issue clears.
    loud = true;
    const clearUntil = Date.now() + 10_000;
    while (runner.state.audioIssue !== null && Date.now() < clearUntil) await sleepMs(100);
    assert.equal(runner.state.audioIssue, null, "audioIssue cleared");
    runner.requestStop("test");
    await done;
    const events = readJsonl(path.join(dir, "events.jsonl"));
    const detected = events.find((e) => /^Deaf bot: the participants' audio tracks carry sound, but the recording is digital silence \(capture\)/.test(e.msg));
    assert.equal(detected?.level, "warn", "capture detection logged");
    assert.equal(detected.data.reason, "capture");
    assert.ok(detected.data.trackSoundSec >= 0.8 && detected.data.trackMax >= 0.05, JSON.stringify(detected.data));
    const recovered = events.find((e) => /^Audio recovered after .* in the recording/.test(e.msg));
    assert.equal(recovered?.data.by.startsWith("recording"), true, JSON.stringify(recovered?.data));
  });
});
