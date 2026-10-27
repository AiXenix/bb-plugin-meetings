// Unit tests for the deaf-bot guard (lib/deaf-guard.mjs) on a virtual clock.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIO_ISSUE_REASONS, CAPTURE_MODES, DEAF_GUARD_DEFAULTS, DeafGuard, peakDbfs, resolveDeafGuardOptions } from "./deaf-guard.mjs";

const BOT = "Notetaker";
const SILENT = 0; // exact digital zero, like the incident recording
const LOUD = 0.2; // speech peak
const NAMES = ["Анна", "Борис", "Вера"];

/**
 * Drive the guard like bot-runner's sampler: an observation every `tick` ms,
 * the recorded-audio peak every `pcmEvery` ms. A recovery action blocks the
 * loop for `actionMs` (no observations), then done() is called.
 */
function simulate(guard, {
  start = 0,
  end,
  tick = 250,
  pcmEvery = 1000,
  speakers = () => [],
  peak = () => SILENT,
  tracks = () => [0, 0, 0],
  participants = () => 4,
  actionMs = 3_000,
  result = () => ({ ok: true }),
}) {
  const actions = [];
  let lastPcm = -Infinity;
  let t = start;
  while (t <= end) {
    const measure = t - lastPcm >= pcmEvery;
    if (measure) lastPcm = t;
    const action = guard.observe({
      t,
      speakers: speakers(t),
      botName: BOT,
      pcmPeak: measure ? peak(t) : undefined,
      trackLevels: tracks(t),
      participants: participants(t),
    });
    if (action) {
      const record = { t, ...action, issue: guard.issue };
      actions.push(record);
      if (action.type === "rejoin_audio" || action.type === "reload") {
        t += typeof actionMs === "function" ? actionMs(action) : actionMs;
        guard.done(t, result(action, t));
        record.issueAfter = guard.issue;
        continue;
      }
    }
    t += tick;
  }
  return actions;
}

/** One speaker after another, `periodMs` each (frequent changes). */
const alternating = (names = NAMES, periodMs = 4_000) => (t) => [names[Math.floor(t / periodMs) % names.length]];
const kinds = (actions) => actions.map((a) => a.type);
const recovery = (actions) => actions.filter((a) => a.type === "rejoin_audio" || a.type === "reload");

/**
 * The incident's active-speaker timeline (mtg_mvqaselwbxfc, 2026-10-27, first
 * 13 minutes), anonymized: [seconds from the recording start, lit speakers]
 * from speakers.jsonl (Zoom's Redux asnIds). Audio and all WebRTC tracks were
 * exact zeros the whole time, except Zoom's own 1.3 s "Recording in progress".
 */
const INCIDENT = [[0.1,"A"],[31.8,"B"],[32.5,"A"],[35.6,"B"],[219.3,"C"],[270.4,""],[290.7,"A"],[292.2,"C"],[294.4,"A"],[297.3,"C"],[347.3,"A"],[365.8,"CA"],[366.2,"A"],[372.6,"C"],[376.6,"CA"],[377.7,"C"],[379.5,"A"],[413.6,"C"],[415.6,"A"],[433.2,"CA"],[433.9,"A"],[447.1,"C"],[447.8,"A"],[510.3,"C"],[513.8,"A"],[517.6,"AB"],[518.7,"B"],[561.9,"C"],[562.3,"B"],[606.6,"C"],[621.8,"A"],[631.3,"AB"],[632.4,"A"],[632.8,"B"],[636.8,"A"],[641.4,"B"],[661.7,"AB"],[662.1,"B"],[664.8,"A"],[665.2,"CA"],[665.9,"A"],[682.4,"B"],[684.8,"A"],[685.5,"AB"],[685.9,"B"],[714.4,"C"],[715.2,"B"],[716.8,"CB"],[717.2,"B"],[750.0,"A"],[751.8,"C"],[764.6,"A"],[770.8,"B"],[771.4,"A"],[783.1,"AB"],[784.0,"A"],[785.7,"B"]];
const PEOPLE = { A: "Участник А", B: "Участник Б", C: "Участник В" };
function incidentSpeakers(t) {
  let lit = "";
  for (const [sec, who] of INCIDENT) {
    if (sec * 1000 > t) break;
    lit = who;
  }
  return [...lit].map((key) => PEOPLE[key]);
}

describe("deaf guard: detection", () => {
  it("detects the incident pattern within ~45 s and climbs the whole ladder", () => {
    const guard = new DeafGuard();
    // Zoom's local "Recording in progress" announcement right after joining (1.3 s).
    const peak = (t) => (t >= 2_000 && t < 3_300 ? 0.3 : SILENT);
    const actions = simulate(guard, { end: 800_000, speakers: incidentSpeakers, peak, tracks: () => [0, 0, 0, 0, 0, 0], actionMs: (a) => (a.type === "reload" ? 15_000 : 3_000) });
    const first = actions[0];
    assert.equal(first.type, "rejoin_audio");
    assert.equal(first.reason, "detected");
    // Silent since the announcement (last loud measurement at 3 s): one full window later.
    assert.ok(first.t > 3_000 + 45_000 && first.t <= 3_000 + 45_000 + 2_000, `detected at ${first.t}`);
    assert.ok(first.evidence.speakingSec >= 10 && first.evidence.changes >= 2, JSON.stringify(first.evidence));
    assert.equal(first.evidence.peakDbfs, null);
    assert.deepEqual(kinds(actions).slice(0, 4), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
    // Every step waited the retry time and fresh speaker activity after the previous one.
    for (let i = 1; i < 4; i += 1) assert.ok(actions[i].t - actions[i - 1].t >= DEAF_GUARD_DEFAULTS.retryMs, `step ${i}`);
    const warn = actions[3];
    assert.equal(warn.attempts, 3);
    assert.equal(warn.issue.escalated, true);
    assert.match(warn.issue.message, /^Бот не слышит участников встречи/);
    assert.match(warn.issue.message, /переподключить звук встречи \(2 раза\)/);
    assert.match(warn.issue.message, /перезагрузить страницу встречи \(1 раз\)/);
    assert.match(warn.issue.message, /каждые 3 мин/);
    // Then the audio rejoin repeats every ~3 min while the meeting stays busy and silent.
    const persistent = actions.slice(4);
    assert.ok(persistent.length >= 1 && persistent.every((a) => a.type === "rejoin_audio" && a.reason === "persistent"), JSON.stringify(kinds(persistent)));
    assert.ok(persistent[0].t - warn.t >= DEAF_GUARD_DEFAULTS.persistentRetryMs);
    for (let i = 1; i < persistent.length; i += 1) assert.ok(persistent[i].t - persistent[i - 1].t >= DEAF_GUARD_DEFAULTS.persistentRetryMs);
    assert.equal(guard.issue.attempts, 3 + persistent.length);
    assert.equal(guard.issue.lastAction, "rejoin_audio");
    // The meeting ends while the bot is still deaf: the final state keeps it, in the past tense.
    const end = guard.issueAtEnd();
    assert.equal(end.escalated, true);
    assert.equal(end.attempts, guard.issue.attempts);
    assert.match(end.message, /^Бот не слышал участников встречи до конца записи/);
    assert.match(end.message, /переподключить звук встречи \(\d+ раз/);
  });

  it("detects frequent speaker changes over digital silence in one window", () => {
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 60_000, speakers: alternating(), actionMs: 2_000 });
    assert.equal(actions[0].type, "rejoin_audio");
    assert.ok(actions[0].t >= 45_000 && actions[0].t <= 46_000, String(actions[0].t));
    assert.equal(actions[0].issue.escalated, false);
    assert.match(actions[0].issue.message, /Пробую восстановить звук: переподключаю звук встречи \(попытка 1\)/);
    assert.match(actions[0].issueAfter.message, /Пробовали: переподключить звук встречи \(1 раз\); жду/);
    assert.equal(actions[0].issueAfter.since, actions[0].t - 45_000);
  });

  it("speakers with dark pauses between them still change (A, pause, B, pause, A)", () => {
    const speakers = (t) => (t % 4_000 < 3_000 ? alternating()(t) : []);
    const actions = simulate(new DeafGuard(), { end: 50_000, speakers });
    assert.equal(actions[0]?.type, "rejoin_audio", JSON.stringify(kinds(actions)));
    assert.ok(actions[0].evidence.changes >= 2, JSON.stringify(actions[0].evidence));
  });

  it("treats -85 dBFS as silence and -79 dBFS as sound", () => {
    const quiet = simulate(new DeafGuard(), { end: 50_000, speakers: alternating(), peak: () => 10 ** (-85 / 20) });
    assert.equal(recovery(quiet).length, 1);
    const hiss = simulate(new DeafGuard(), { end: 120_000, speakers: alternating(), peak: () => 10 ** (-79 / 20) });
    assert.equal(recovery(hiss).length, 0);
  });
});

describe("deaf guard: no false positives", () => {
  it("a silent meeting where nobody speaks", () => {
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000 });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.equal(actions[0].reason, "nobody is speaking");
    assert.equal(guard.issue, null);
  });

  it("a silent meeting that later shows a sticky indicator logs both decisions once", () => {
    const actions = simulate(new DeafGuard(), { end: 600_000, speakers: (t) => (t < 100_000 ? [] : ["Анна"]) });
    assert.deepEqual(kinds(actions), ["note", "note"]);
    assert.equal(actions[0].reason, "nobody is speaking");
    assert.match(actions[1].reason, /sticky/);
  });

  it("a screen share with a sticky indicator and no changes", () => {
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000, speakers: () => ["Анна"] });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.match(actions[0].reason, /sticky/);
    assert.equal(guard.issue, null);
  });

  it("a sticky indicator that flickers (dark for one tick, then the same person again)", () => {
    // A re-rendered tile or screen-share strip loses its "speaking" class for a moment every 15 s.
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000, speakers: (t) => (t % 15_000 < 250 ? [] : ["Анна"]) });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.match(actions[0].reason, /sticky/);
    assert.equal(actions[0].evidence.changes, 0);
    assert.equal(guard.issue, null);
  });

  it("a sticky indicator that changed only once", () => {
    const actions = simulate(new DeafGuard(), { end: 600_000, speakers: (t) => [t < 20_000 ? "Анна" : "Борис"] });
    assert.equal(recovery(actions).length, 0);
  });

  it("the bot alone (count 1), even with a stale flickering indicator", () => {
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000, speakers: alternating(), participants: () => 1 });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.equal(actions[0].reason, "the bot is alone");
  });

  it("only the bot itself lit (its own name, with Zoom's role suffix)", () => {
    const actions = simulate(new DeafGuard(), { end: 300_000, speakers: (t) => (Math.floor(t / 3_000) % 2 ? [`${BOT} (Host, me)`] : []) });
    assert.equal(recovery(actions).length, 0);
  });

  it("a normal meeting with audio", () => {
    const peak = (t) => (t % 4_000 < 3_000 ? LOUD : SILENT);
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000, speakers: alternating(), peak, tracks: () => [0.05, 0, 0] });
    assert.deepEqual(actions, []);
  });

  it("speech that stops for good: the remaining silence is no deafness", () => {
    const peak = (t) => (t < 60_000 ? LOUD : SILENT);
    const actions = simulate(new DeafGuard(), { end: 600_000, speakers: (t) => (t < 60_000 ? alternating()(t) : []), peak });
    assert.equal(recovery(actions).length, 0);
  });

  it("WebRTC tracks carry sound while the recording is silent: no deafness (capture mode off)", () => {
    // With capture mode on this is the capture case ("deaf guard: capture mode" below).
    const actions = simulate(new DeafGuard({ capture: "off" }), { end: 300_000, speakers: alternating(), tracks: () => [0.03, 0, 0] });
    assert.deepEqual(actions, []);
  });

  it("faint track noise (Telemost's comfort noise) over a silent recording is neither deaf nor capture", () => {
    const actions = simulate(new DeafGuard(), { end: 600_000, speakers: alternating(), tracks: () => [0.003, 0, 0] });
    assert.deepEqual(actions, []);
  });

  it("no measurements of the recording (ffmpeg stalled) is not silence", () => {
    const actions = simulate(new DeafGuard(), { end: 300_000, speakers: alternating(), pcmEvery: Infinity });
    assert.deepEqual(actions, []);
  });

  it("a gap in the measurements restarts the silent stretch", () => {
    const guard = new DeafGuard();
    // Measurements stop between 20 s and 50 s: nothing is known about that audio.
    const actions = [];
    for (let t = 0; t <= 120_000; t += 250) {
      const measure = t % 1_000 === 0 && (t < 20_000 || t >= 50_000);
      const action = guard.observe({ t, speakers: alternating()(t), botName: BOT, pcmPeak: measure ? SILENT : undefined, trackLevels: [], participants: 3 });
      if (action) {
        actions.push({ t, ...action });
        guard.done(t, { ok: true });
      }
    }
    const first = recovery(actions)[0];
    assert.ok(first && first.t >= 50_000 + 45_000 - DEAF_GUARD_DEFAULTS.pcmSlackMs, String(first?.t));
  });

  it("disabled guard never acts", () => {
    const actions = simulate(new DeafGuard({ enabled: false }), { end: 300_000, speakers: alternating() });
    assert.deepEqual(actions, []);
  });
});

describe("deaf guard: recovery", () => {
  it("sound after the first rejoin clears the issue", () => {
    const guard = new DeafGuard();
    let fixedAt = null;
    const peak = (t) => (fixedAt !== null && t >= fixedAt && t % 4_000 < 3_000 ? LOUD : SILENT);
    const actions = simulate(guard, {
      end: 200_000,
      speakers: alternating(),
      peak,
      result: (action, t) => {
        fixedAt = t;
        return { ok: true, detail: "left and rejoined computer audio" };
      },
    });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "recovered"]);
    const recovered = actions[1];
    assert.equal(recovered.attempts, 1);
    assert.deepEqual(recovered.tried, [{ type: "rejoin_audio", ok: true }]);
    assert.ok(recovered.deafMs >= 45_000, String(recovered.deafMs));
    assert.ok(recovered.t - fixedAt >= DEAF_GUARD_DEFAULTS.recoverySpanMs && recovered.t - fixedAt < 10_000, String(recovered.t - fixedAt));
    assert.equal(recovered.issue, null);
    assert.equal(guard.issue, null);
  });

  it("sound on the WebRTC tracks after a reload also counts (deaf episode)", () => {
    const guard = new DeafGuard({ capture: "off" });
    let reloadedAt = null;
    const tracks = (t) => (reloadedAt !== null && t >= reloadedAt ? [0.04] : [0]);
    const actions = simulate(guard, {
      end: 400_000,
      speakers: alternating(),
      tracks,
      actionMs: (a) => (a.type === "reload" ? 20_000 : 3_000),
      result: (action, t) => {
        if (action.type === "reload") reloadedAt = t;
        return { ok: true };
      },
    });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "rejoin_audio", "reload", "recovered"]);
    assert.equal(actions[3].attempts, 3);
    assert.equal(actions[3].evidence.by, "tracks");
  });

  it("tracks back but the recording still silent: the deaf episode recovers, capture takes it up as a relapse", () => {
    const guard = new DeafGuard();
    let reloadedAt = null;
    // The reload brings the participants' tracks back, but nothing reaches the recording.
    const tracks = (t) => (reloadedAt !== null && t >= reloadedAt ? [0.04] : [0]);
    const actions = simulate(guard, {
      end: 400_000,
      speakers: alternating(),
      tracks,
      actionMs: (a) => (a.type === "reload" ? 20_000 : 3_000),
      result: (action, t) => {
        if (action.type === "reload") reloadedAt = t;
        return { ok: true };
      },
    });
    // Deaf-reason recovery rules unchanged: the sounding tracks end the deaf episode...
    assert.deepEqual(kinds(actions).slice(0, 5), ["rejoin_audio", "rejoin_audio", "reload", "recovered", "warn"], JSON.stringify(kinds(actions)));
    assert.equal(actions[3].evidence.by, "tracks");
    // ...and one window later the silent recording is a capture relapse: the ladder is spent, so the warning.
    const warn = actions[4];
    assert.equal(warn.evidence.reason, "capture");
    assert.ok(warn.t - actions[3].t >= DEAF_GUARD_DEFAULTS.windowMs, String(warn.t - actions[3].t));
    assert.equal(warn.issue.reason, "capture");
    assert.equal(warn.issue.escalated, true);
    assert.match(warn.issue.message, /^Бот слышит участников, но звук не попадает в запись\./);
    // The tracks keep sounding: never a second "recovered" for the capture episode.
    assert.equal(kinds(actions).filter((k) => k === "recovered").length, 1, JSON.stringify(kinds(actions)));
  });

  it("one short local announcement during deafness is not a recovery", () => {
    const guard = new DeafGuard();
    // Zoom's "Recording in progress" (1.3 s) plays right after the first rejoin.
    let rejoinedAt = null;
    const peak = (t) => (rejoinedAt !== null && t >= rejoinedAt + 500 && t < rejoinedAt + 1_800 ? 0.3 : SILENT);
    const actions = simulate(guard, {
      end: 140_000,
      speakers: alternating(),
      peak,
      result: (action, t) => {
        rejoinedAt ??= t;
        return { ok: true };
      },
    });
    assert.ok(!kinds(actions).includes("recovered"), JSON.stringify(kinds(actions)));
    assert.deepEqual(kinds(actions).slice(0, 2), ["rejoin_audio", "rejoin_audio"]);
    // The announcement restarted the silent stretch: the retry waits one window after it.
    assert.ok(actions[1].t >= rejoinedAt + 1_800 + DEAF_GUARD_DEFAULTS.windowMs - DEAF_GUARD_DEFAULTS.pcmSlackMs);
  });

  it("a retry needs fresh speaker activity; a quiet pause keeps the issue without new actions", () => {
    const guard = new DeafGuard();
    // People talk until 50 s, pause until 400 s, then talk again.
    const speakers = (t) => (t < 50_000 || t >= 400_000 ? alternating()(t) : []);
    const actions = simulate(guard, { end: 440_000, speakers });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "rejoin_audio"]);
    assert.ok(actions[1].t >= 400_000 + 10_000, String(actions[1].t));
    assert.notEqual(guard.issue, null);
  });

  it("a deaf episode long after a recovery starts the ladder from the beginning", () => {
    const guard = new DeafGuard();
    let fixedAt = null;
    // Sound returns after the first rejoin and lasts until 450 s (past relapseMs after the recovery), then goes again.
    const peak = (t) => (fixedAt !== null && t < 450_000 && t % 4_000 < 3_000 ? LOUD : SILENT);
    const actions = simulate(guard, {
      end: 520_000,
      speakers: alternating(),
      peak,
      result: (action, t) => {
        fixedAt ??= t;
        return { ok: true };
      },
    });
    assert.deepEqual(kinds(actions).slice(0, 3), ["rejoin_audio", "recovered", "rejoin_audio"]);
    assert.ok(actions[2].t - actions[1].t > DEAF_GUARD_DEFAULTS.relapseMs);
    assert.equal(actions[2].reason, "detected");
    assert.equal(actions[2].attempt, 1);
  });

  it("deaf again soon after a recovery continues the ladder (a brief or false recovery cannot loop forever)", () => {
    const guard = new DeafGuard();
    // After each audio rejoin the sound comes back for 8 s only.
    const bursts = [];
    const peak = (t) => (bursts.some((b) => t >= b && t < b + 8_000) ? LOUD : SILENT);
    const actions = simulate(guard, {
      end: 600_000,
      speakers: alternating(),
      peak,
      actionMs: (a) => (a.type === "reload" ? 15_000 : 3_000),
      result: (action, t) => {
        bursts.push(t);
        return { ok: true };
      },
    });
    const flow = kinds(actions);
    assert.deepEqual(flow.slice(0, 7), ["rejoin_audio", "recovered", "rejoin_audio", "recovered", "reload", "recovered", "warn"]);
    assert.equal(actions[2].reason, "relapse");
    assert.equal(actions[2].attempt, 2);
    assert.match(actions[2].msg, /gone again .* s after it came back/);
    assert.equal(actions[4].type, "reload");
    const warn = actions[6];
    assert.equal(warn.issue.escalated, true);
    assert.match(warn.issue.message, /переподключить звук встречи \(2 раза\), перезагрузить страницу встречи \(1 раз\)/);
    // Escalated episodes relapse into the warning and the persistent retries, never back to the start.
    const later = actions.slice(7);
    assert.ok(later.every((a) => a.type === "recovered" || a.type === "warn" || (a.type === "rejoin_audio" && a.attempt > 3)), JSON.stringify(flow));
    assert.ok(later.some((a) => a.type === "warn" && a.relapse === true && a.issue.escalated === true), JSON.stringify(flow));
    // ...and a flapping recovery keeps the 3-minute cadence of the persistent rejoins.
    const rejoins = [warn, ...later].filter((a) => a.type === "rejoin_audio" || a === warn).map((a) => a.t);
    assert.ok(rejoins.length >= 3, JSON.stringify(flow));
    for (let i = 1; i < rejoins.length; i += 1) {
      assert.ok(rejoins[i] - rejoins[i - 1] >= DEAF_GUARD_DEFAULTS.persistentRetryMs, `${rejoins[i] - rejoins[i - 1]} ms between persistent rejoins`);
    }
  });

  it("an escalated relapse warns at once and rejoins only persistentRetryMs after the recovery", () => {
    const guard = new DeafGuard();
    // Sound returns for 8 s after every step, so every recovery relapses.
    const bursts = [];
    const peak = (t) => (bursts.some((b) => t >= b && t < b + 8_000) ? LOUD : SILENT);
    const actions = simulate(guard, {
      end: 1_000_000,
      speakers: alternating(),
      peak,
      result: (action, t) => {
        bursts.push(t);
        return { ok: true };
      },
    });
    const relapse = actions.find((a) => a.type === "warn" && a.relapse);
    assert.ok(relapse, JSON.stringify(kinds(actions)));
    assert.match(relapse.msg, /gone again .* warning the user again/);
    assert.equal(relapse.issue.escalated, true);
    const recoveredBefore = actions.filter((a) => a.type === "recovered" && a.t < relapse.t).at(-1);
    const nextRejoin = actions.find((a) => a.type === "rejoin_audio" && a.t > relapse.t);
    assert.ok(nextRejoin, JSON.stringify(kinds(actions)));
    assert.equal(nextRejoin.reason, "persistent");
    assert.ok(nextRejoin.t - recoveredBefore.t >= DEAF_GUARD_DEFAULTS.persistentRetryMs, String(nextRejoin.t - recoveredBefore.t));
    assert.ok(nextRejoin.t - recoveredBefore.t < DEAF_GUARD_DEFAULTS.persistentRetryMs + 5_000, String(nextRejoin.t - recoveredBefore.t));
  });

  it("a sub-second burst on a WebRTC track is not a recovery", () => {
    const guard = new DeafGuard();
    let first = null;
    // 0.75 s of sound on one track (three sampler ticks) after the first rejoin, then nothing again.
    const tracks = (t) => (first !== null && t >= first + 2_000 && t < first + 2_750 ? [0.05] : [0]);
    const actions = simulate(guard, {
      end: 200_000,
      speakers: alternating(),
      tracks,
      result: (action, t) => {
        first ??= t;
        return { ok: true };
      },
    });
    assert.ok(!kinds(actions).includes("recovered"), JSON.stringify(kinds(actions)));
    assert.deepEqual(kinds(actions).slice(0, 4), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
  });

  it("short local sounds after a step (a click, Zoom's announcement 4 s later) are not a recovery", () => {
    const guard = new DeafGuard();
    let at = null;
    // 5 ms click 1 s after the rejoin, then the 1.3 s "Recording in progress" 4 s later.
    const peak = (t) => (at !== null && (t === at + 1_000 || (t >= at + 5_000 && t < at + 6_300)) ? 0.3 : SILENT);
    const actions = simulate(guard, {
      end: 120_000,
      speakers: alternating(),
      peak,
      result: (action, t) => {
        at ??= t;
        return { ok: true };
      },
    });
    assert.ok(!kinds(actions).includes("recovered"), JSON.stringify(kinds(actions)));
  });
});

describe("deaf guard: options and helpers", () => {
  it("overrides merge loosely; bad values are ignored", () => {
    const o = resolveDeafGuardOptions({ windowMs: 10_000, retryMs: "x", minChanges: -1, ladder: ["reload", "bogus"], enabled: "no" });
    assert.equal(o.windowMs, 10_000);
    assert.equal(o.retryMs, DEAF_GUARD_DEFAULTS.retryMs);
    assert.equal(o.minChanges, DEAF_GUARD_DEFAULTS.minChanges);
    assert.equal(o.openMinChanges, 0);
    assert.equal(resolveDeafGuardOptions({ openMinChanges: 2 }).openMinChanges, 2);
    assert.deepEqual(o.ladder, ["reload"]);
    assert.equal(o.enabled, true);
    assert.deepEqual(resolveDeafGuardOptions(null).ladder, ["rejoin_audio", "rejoin_audio", "reload"]);
    assert.equal(resolveDeafGuardOptions(null).capture, "act");
    assert.equal(resolveDeafGuardOptions({ capture: "log" }).capture, "log");
    assert.equal(resolveDeafGuardOptions({ capture: "bogus" }).capture, "act");
    assert.equal(resolveDeafGuardOptions({ captureTrackLevel: 0.02, captureSoundMs: "x" }).captureTrackLevel, 0.02);
    assert.equal(resolveDeafGuardOptions({ captureSoundMs: "x" }).captureSoundMs, DEAF_GUARD_DEFAULTS.captureSoundMs);
    assert.deepEqual([...CAPTURE_MODES], ["act", "log", "off"]);
    assert.deepEqual([...AUDIO_ISSUE_REASONS], ["deaf", "capture"]);
  });

  it("short test timings drive the same ladder", () => {
    const guard = new DeafGuard({ windowMs: 10_000, minSpeakingMs: 4_000, retryMs: 8_000, persistentRetryMs: 20_000 });
    const actions = simulate(guard, { end: 90_000, speakers: alternating(NAMES, 2_000), actionMs: 1_000 });
    assert.deepEqual(kinds(actions).slice(0, 5), ["rejoin_audio", "rejoin_audio", "reload", "warn", "rejoin_audio"]);
    assert.ok(actions[0].t >= 10_000 && actions[0].t < 11_000);
    assert.match(actions[3].issue.message, /каждые 1 мин/);
  });

  it("peakDbfs", () => {
    assert.equal(peakDbfs(1), 0);
    assert.equal(peakDbfs(1e-4), -80);
    assert.equal(peakDbfs(0), null);
    assert.equal(peakDbfs(null), null);
  });

  it("issue shape is plain JSON", () => {
    const guard = new DeafGuard();
    simulate(guard, { end: 50_000, speakers: alternating() });
    const issue = guard.issue;
    assert.deepEqual(Object.keys(issue).sort(), ["attempts", "escalated", "lastAction", "message", "reason", "since"]);
    assert.equal(issue.reason, "deaf");
    assert.deepEqual(JSON.parse(JSON.stringify(issue)), issue);
    assert.equal(guard.debugState().phase, "deaf");
  });

  it("names are compared without case and role suffixes; the evidence keeps display names", () => {
    const guard = new DeafGuard({ windowMs: 10_000, minSpeakingMs: 4_000 });
    const speakers = (t) => [Math.floor(t / 2_000) % 2 ? "Анна (Host)" : "борис"];
    const actions = simulate(guard, { end: 12_000, speakers });
    assert.equal(actions[0].type, "rejoin_audio");
    assert.deepEqual([...actions[0].evidence.speakers].sort(), ["борис", "Анна"].sort());
  });
});

describe("deaf guard: capture mode (sound on the tracks, silence in the recording)", () => {
  /** The participants' tracks: someone talks 3 of every 4 s on one of three tracks. */
  const talkingTracks = (level = 0.04) => (t) => {
    const lit = Math.floor(t / 4_000) % 3;
    return [0, 1, 2].map((i) => (i === lit && t % 4_000 < 3_000 ? level : 0));
  };

  it("detects it without any speaking indicator (Telemost, Meet, Jitsi) and climbs the same ladder", () => {
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 800_000, speakers: () => [], tracks: talkingTracks(), actionMs: (a) => (a.type === "reload" ? 15_000 : 3_000) });
    const first = actions[0];
    assert.equal(first?.type, "rejoin_audio", JSON.stringify(kinds(actions)));
    assert.equal(first.reason, "detected");
    assert.ok(first.t >= 45_000 && first.t <= 46_000, String(first.t));
    assert.equal(first.evidence.reason, "capture");
    assert.equal(first.evidence.peakDbfs, null);
    assert.ok(first.evidence.trackSoundSec >= 10 && first.evidence.trackMax >= 0.01, JSON.stringify(first.evidence));
    assert.match(first.msg, /^Deaf bot: the participants' audio tracks carry sound, but the recording is digital silence \(capture\); rejoining the meeting audio \(attempt 1\)$/);
    assert.equal(first.issue.reason, "capture");
    assert.match(first.issue.message, /^Бот слышит участников, но звук не попадает в запись\. Пробую восстановить звук: переподключаю звук встречи \(попытка 1\)\.$/);
    // The tracks sound all the time: they never count as a recovery for this episode.
    assert.deepEqual(kinds(actions).slice(0, 5), ["rejoin_audio", "rejoin_audio", "reload", "warn", "rejoin_audio"], JSON.stringify(kinds(actions)));
    assert.ok(!kinds(actions).includes("recovered"));
    const warn = actions[3];
    assert.equal(warn.issue.escalated, true);
    assert.equal(warn.issue.reason, "capture");
    assert.match(warn.msg, /in the recording \(capture\) after 3 recovery attempt/);
    assert.match(warn.issue.message, /^Бот слышит участников, но звук не попадает в запись\. Автоматически пробовали: переподключить звук встречи \(2 раза\), перезагрузить страницу встречи \(1 раз\) — звук в записи не появился\./);
    const end = guard.issueAtEnd();
    assert.equal(end.reason, "capture");
    assert.match(end.message, /^Бот слышал участников, но до конца записи звук в неё так и не попал\. Автоматически пробовали: /);
  });

  it("recovers only when the recording has sound again", () => {
    const guard = new DeafGuard();
    let fixedAt = null;
    const peak = (t) => (fixedAt !== null && t >= fixedAt && t % 4_000 < 3_000 ? LOUD : SILENT);
    const actions = simulate(guard, {
      end: 200_000,
      speakers: alternating(),
      tracks: talkingTracks(),
      peak,
      result: (action, t) => {
        fixedAt = t;
        return { ok: true };
      },
    });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "recovered"]);
    assert.equal(actions[0].evidence.reason, "capture");
    assert.equal(actions[1].evidence.by, "recording");
    assert.equal(actions[1].evidence.reason, "capture");
    assert.match(actions[1].msg, /without meeting audio in the recording/);
    assert.ok(actions[1].t - fixedAt >= DEAF_GUARD_DEFAULTS.recoverySpanMs);
    assert.equal(guard.issue, null);
  });

  it("a capture episode whose tracks also go quiet (deaf) still recovers by the recording only", () => {
    const guard = new DeafGuard();
    let steps = 0;
    // Capture first; after the first rejoin the tracks go silent too (deaf), after the second they sound again.
    const tracks = (t) => (steps === 1 ? [0, 0, 0] : talkingTracks()(t));
    const actions = simulate(guard, {
      end: 400_000,
      speakers: alternating(),
      tracks,
      result: () => {
        steps += 1;
        return { ok: true };
      },
    });
    assert.deepEqual(kinds(actions).slice(0, 3), ["rejoin_audio", "rejoin_audio", "reload"], JSON.stringify(kinds(actions)));
    assert.equal(actions[0].evidence.reason, "capture");
    assert.equal(actions[1].evidence.reason, "deaf");
    assert.equal(actions[1].issue.reason, "deaf");
    assert.equal(actions[2].evidence.reason, "capture");
    assert.ok(!kinds(actions).includes("recovered"), JSON.stringify(kinds(actions)));
  });

  it("needs captureSoundMs of track sound in the window: a few seconds of sound are no capture", () => {
    // 8 s of talk per minute on the tracks, nothing in the recording, nobody lit.
    const tracks = (t) => (t % 60_000 < 8_000 ? [0.05] : [0]);
    const actions = simulate(new DeafGuard(), { end: 600_000, tracks });
    assert.equal(recovery(actions).length, 0, JSON.stringify(actions.map((a) => [a.type, a.reason])));
  });

  it("never with the bot alone, nor without continuous measurements of the recording", () => {
    assert.deepEqual(simulate(new DeafGuard(), { end: 300_000, tracks: talkingTracks(), participants: () => 1 }), []);
    assert.deepEqual(simulate(new DeafGuard(), { end: 300_000, tracks: talkingTracks(), pcmEvery: Infinity }), []);
  });

  it("a meeting the bot records is never capture", () => {
    const peak = (t) => (t % 4_000 < 3_000 ? LOUD : SILENT);
    assert.deepEqual(simulate(new DeafGuard(), { end: 600_000, tracks: talkingTracks(), peak }), []);
  });

  it('capture: "log" only notes it, once per silent stretch, and never acts', () => {
    const guard = new DeafGuard({ capture: "log" });
    const actions = simulate(guard, { end: 600_000, speakers: alternating(), tracks: talkingTracks() });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.equal(actions[0].reason, "capture");
    assert.match(actions[0].msg, /^Deaf guard: the recording is silent, but the participants' audio tracks carry sound \(capture; capture mode is log-only\): no action$/);
    assert.equal(actions[0].evidence.capture, true);
    assert.equal(guard.issue, null);
  });

  it('capture: "off" ignores it; deafness is still detected', () => {
    assert.deepEqual(simulate(new DeafGuard({ capture: "off" }), { end: 300_000, speakers: alternating(), tracks: talkingTracks() }), []);
    const deaf = simulate(new DeafGuard({ capture: "off" }), { end: 60_000, speakers: alternating() });
    assert.equal(deaf[0]?.evidence.reason, "deaf");
  });

  it("speakingWhileDeaf holds the silence timeout while the tracks talk in a capture episode", () => {
    const guard = new DeafGuard();
    simulate(guard, { end: 120_000, tracks: talkingTracks(), result: () => ({ ok: false }) });
    assert.equal(guard.issue?.reason, "capture");
    assert.equal(guard.speakingWhileDeaf(120_000), true);
  });
});

describe("deaf guard: review regressions (downstream reviews, 2026-10-27)", () => {
  it("the wall clock stepping back an hour does not blind the guard", () => {
    const guard = new DeafGuard();
    const HOUR = 3_600_000;
    const actions = [];
    // Deaf meeting; the clock reads one hour ahead until 30 s, then NTP steps it back.
    for (let t = 0; t <= 120_000; t += 250) {
      const clock = t < 30_000 ? t + HOUR : t;
      const action = guard.observe({ t: clock, speakers: alternating()(t), botName: BOT, pcmPeak: t % 1_000 === 0 ? SILENT : undefined, trackLevels: [0], participants: 4 });
      if (action) {
        actions.push({ t, ...action });
        if (action.type === "rejoin_audio" || action.type === "reload") guard.done(clock, { ok: true });
      }
    }
    const first = recovery(actions)[0];
    assert.ok(first, JSON.stringify(kinds(actions)));
    assert.ok(first.t >= 30_000 + DEAF_GUARD_DEFAULTS.windowMs && first.t < 30_000 + DEAF_GUARD_DEFAULTS.windowMs + 5_000, String(first.t));
  });

  it("the wall clock jumping forward never turns a hearing meeting deaf (positive control)", () => {
    const peak = (t) => (t % 4_000 < 3_000 ? LOUD : SILENT);
    for (const jump of [60_000, 3_600_000]) {
      const guard = new DeafGuard();
      const actions = [];
      for (let t = 0; t <= 200_000; t += 250) {
        const clock = t < 60_000 ? t : t + jump;
        const action = guard.observe({ t: clock, speakers: alternating()(t), botName: BOT, pcmPeak: t % 1_000 === 0 ? peak(t) : undefined, trackLevels: [0.04], participants: 4 });
        if (action) actions.push(action);
      }
      assert.deepEqual(actions, [], `jump ${jump}`);
    }
  });

  it("dropped samples (speakers null) under a sticky indicator are no speaker changes", () => {
    // bot-runner fed a failed sample as "nobody speaks": with a sticky name every dropped sample was
    // a dark moment, and a relit sticky name a new speaker on the guard before the flicker fix.
    const guard = new DeafGuard();
    const actions = simulate(guard, { end: 600_000, speakers: (t) => (t % 6_000 === 0 ? null : ["Анна"]) });
    assert.deepEqual(kinds(actions), ["note"]);
    assert.match(actions[0].reason, /sticky/);
    assert.equal(actions[0].evidence.changes, 0);
    assert.equal(guard.issue, null);
  });

  it("dropped samples do not hide a real deaf meeting", () => {
    const actions = simulate(new DeafGuard(), { end: 60_000, speakers: (t) => (t % 3_000 === 0 ? null : alternating()(t)) });
    assert.equal(actions[0]?.type, "rejoin_audio");
    assert.ok(actions[0].t >= 45_000 && actions[0].t <= 46_000, String(actions[0].t));
  });

  it("a page that answers only every 5th sample keeps its speakers lit (a failed sample is unknown, not silence)", () => {
    // Four of five samples fail: read as "nobody lit" they cut the speaking time to a fifth (9 s < 10 s).
    const speakers = (t) => (Math.floor(t / 250) % 5 === 0 ? alternating()(t) : null);
    const actions = simulate(new DeafGuard(), { end: 60_000, speakers });
    assert.equal(actions[0]?.type, "rejoin_audio", JSON.stringify(actions.map((a) => [a.type, a.reason, a.evidence?.speakingSec])));
    assert.ok(actions[0].evidence.speakingSec >= 40, JSON.stringify(actions[0].evidence));
  });
});

describe("deaf guard: one person talking in an open episode (verifier review, 2026-10-27)", () => {
  it("after the warning, one person talking with a steady indicator keeps the persistent rejoins every persistentRetryMs", () => {
    // Replay of mtg_mvgr928zgps9 with its audio zeroed: the persistent rejoins stopped for 14 and 20 min
    // while one participant talked (no speaker changes), although the warning promises one every 3 min.
    const guard = new DeafGuard();
    const speakers = (t) => (guard.phase === "escalated" ? ["Анна"] : alternating()(t));
    const actions = simulate(guard, { end: 1_800_000, speakers });
    const warnAt = actions.findIndex((a) => a.type === "warn");
    assert.ok(warnAt > 0, JSON.stringify(kinds(actions)));
    assert.deepEqual(kinds(actions).slice(0, warnAt + 1), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
    const persistent = actions.slice(warnAt + 1);
    assert.ok(persistent.length >= 8, `${persistent.length} persistent rejoins in ${Math.round((1_800_000 - actions[warnAt].t) / 1000)} s`);
    assert.ok(persistent.every((a) => a.type === "rejoin_audio" && a.reason === "persistent" && a.evidence.changes === 0), JSON.stringify(kinds(persistent)));
    const times = [actions[warnAt].t, ...persistent.map((a) => a.t)];
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= DEAF_GUARD_DEFAULTS.persistentRetryMs && gap <= DEAF_GUARD_DEFAULTS.persistentRetryMs + 5_000, `${gap} ms between persistent rejoins`);
    }
    // The warning stays true: "Бот продолжает переподключать звук каждые 3 мин".
    assert.match(guard.issue.message, /каждые 3 мин/);
    assert.equal(guard.issue.escalated, true);
    assert.equal(guard.speakingWhileDeaf(1_800_000), true);
  });

  it("before the warning, a steady indicator holds the silence timeout but never steps the ladder (no reload)", () => {
    const guard = new DeafGuard();
    let detected = false;
    const speakers = (t) => (detected ? ["Анна"] : alternating()(t));
    const actions = simulate(guard, {
      end: 900_000,
      speakers,
      result: () => {
        detected = true;
        return { ok: false };
      },
    });
    assert.deepEqual(kinds(actions), ["rejoin_audio"], "only the detection's step: a sticky indicator cannot drive the ladder");
    assert.equal(guard.issue.escalated, false);
    assert.match(guard.issue.message, /Пробовали: переподключить звук встречи \(1 раз\); жду, появится ли звук\./);
    assert.equal(guard.speakingWhileDeaf(900_000), true);
  });

  it("with persistentAction reload, a steady indicator after the warning drives no reload (the rule relaxes the rejoin only)", () => {
    const guard = new DeafGuard({ persistentAction: "reload" });
    const speakers = (t) => (guard.phase === "escalated" ? ["Анна"] : alternating()(t));
    const actions = simulate(guard, { end: 1_800_000, speakers });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
    assert.equal(guard.speakingWhileDeaf(1_800_000), true, "the silence hold still applies");
    // Turn-taking again is fresh evidence: the persistent reload resumes.
    const turns = new DeafGuard({ persistentAction: "reload" });
    const more = simulate(turns, { end: 1_800_000, speakers: alternating() });
    assert.ok(more.slice(4).length > 0 && more.slice(4).every((a) => a.type === "reload" && a.reason === "persistent"), JSON.stringify(kinds(more)));
  });

  it("after the warning, nobody lit (a silent meeting) or the bot alone stops the persistent rejoins", () => {
    const guard = new DeafGuard();
    let stopAt = null;
    const speakers = (t) => {
      if (guard.phase === "escalated") stopAt ??= t;
      return stopAt === null ? alternating()(t) : [];
    };
    const actions = simulate(guard, { end: 1_200_000, speakers });
    assert.deepEqual(kinds(actions), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
    assert.equal(guard.speakingWhileDeaf(1_200_000), false);
    const alone = new DeafGuard();
    const after = simulate(alone, { end: 1_200_000, speakers: (t) => (alone.phase === "escalated" ? ["Анна"] : alternating()(t)), participants: () => (alone.phase === "escalated" ? 1 : 4) });
    assert.deepEqual(kinds(after), ["rejoin_audio", "rejoin_audio", "reload", "warn"]);
    assert.equal(alone.speakingWhileDeaf(1_200_000), false);
  });

  it("the wall clock stepping back in an open episode clamps its start: no negative deaf time, audioIssue.since never in the future", () => {
    const guard = new DeafGuard();
    const T0 = 1_800_000_000_000;
    const HOUR = 3_600_000;
    let t = T0;
    for (let i = 0; i < 1_000; i += 1) {
      t += 220;
      const action = guard.observe({ t, speakers: alternating()(t - T0), botName: BOT, pcmPeak: i % 5 === 0 ? SILENT : undefined, trackLevels: [0], participants: 4 });
      if (action?.type === "rejoin_audio" || action?.type === "reload") guard.done(t + 1_000, { ok: false });
    }
    assert.equal(guard.issue?.escalated, true, JSON.stringify(guard.issue));
    assert.ok(guard.issue.since < t);
    t -= HOUR; // NTP steps the clock back an hour
    let recovered = null;
    for (let i = 0; i < 200 && recovered === null; i += 1) {
      t += 220;
      const action = guard.observe({ t, speakers: ["Анна"], botName: BOT, pcmPeak: i % 5 === 0 ? 0.3 : undefined, trackLevels: [0.2], participants: 4 });
      if (i === 0) {
        assert.ok(guard.issue.since <= t, `audioIssue.since ${guard.issue.since - t} ms in the future`);
        assert.ok(guard.escalatedAt <= t);
      }
      if (action?.type === "recovered") recovered = action;
    }
    assert.ok(recovered, "sound after the step recovers");
    assert.ok(recovered.deafMs >= 0 && recovered.deafMs < 60_000, String(recovered.deafMs));
    assert.match(recovered.msg, /^Audio recovered after \d/);
  });
});

describe("deaf guard: speakingWhileDeaf (holds the runner's silence timeout)", () => {
  /** Observations every 250 ms, a silent recording measurement every second, no recovery executed. */
  function drive(guard, from, to, speakers, participants = 4) {
    const out = [];
    for (let t = from; t <= to; t += 250) {
      const action = guard.observe({ t, speakers: speakers(t), botName: BOT, pcmPeak: t % 1_000 === 0 ? SILENT : undefined, trackLevels: [0], participants });
      if (action) {
        out.push(action);
        if (action.type === "rejoin_audio" || action.type === "reload") guard.done(t, { ok: false });
      }
    }
    return out;
  }

  it("is false while the bot hears the meeting, also in a silent one", () => {
    const guard = new DeafGuard();
    drive(guard, 0, 30_000, alternating());
    assert.equal(guard.issue, null);
    assert.equal(guard.speakingWhileDeaf(30_000), false);
  });

  it("is true while deaf and people keep speaking, false once they stop or the bot is alone", () => {
    const guard = new DeafGuard();
    drive(guard, 0, 120_000, alternating());
    assert.notEqual(guard.issue, null);
    assert.equal(guard.speakingWhileDeaf(120_000), true);
    // Everyone stops: one window later the silence is a silent meeting again.
    drive(guard, 120_250, 180_000, () => []);
    assert.notEqual(guard.issue, null, "the warning stays");
    assert.equal(guard.speakingWhileDeaf(180_000), false);
    // Speech again, but the bot is alone (a stale indicator).
    drive(guard, 180_250, 240_000, alternating(), 1);
    assert.equal(guard.speakingWhileDeaf(240_000), false);
  });

  it("one person who keeps talking (a steady indicator, no speaker changes) holds it once the episode is open", () => {
    // Verifier review 2026-10-27: mtg_mvgr928zgps9 with its audio zeroed left "for silence" at 5588 s of
    // 7877 s while one participant talked; the hold needed two speaker changes like the detection.
    const guard = new DeafGuard();
    drive(guard, 0, 120_000, alternating());
    drive(guard, 120_250, 200_000, () => ["Анна"]);
    assert.notEqual(guard.issue, null);
    assert.equal(guard.speakingWhileDeaf(200_000), true);
    // Less than minSpeakingMs lit in the window is no talking meeting.
    drive(guard, 200_250, 260_000, (t) => (t >= 252_000 ? ["Анна"] : []));
    assert.equal(guard.speakingWhileDeaf(260_000), false);
  });

  it("openMinChanges restores the stricter rule (a sticky indicator then does not hold it)", () => {
    const guard = new DeafGuard({ openMinChanges: 2 });
    drive(guard, 0, 120_000, alternating());
    drive(guard, 120_250, 200_000, () => ["Анна"]);
    assert.notEqual(guard.issue, null);
    assert.equal(guard.speakingWhileDeaf(200_000), false);
  });

  it("is false when the guard is disabled", () => {
    const guard = new DeafGuard({ enabled: false });
    drive(guard, 0, 120_000, alternating());
    assert.equal(guard.speakingWhileDeaf(120_000), false);
  });
});
