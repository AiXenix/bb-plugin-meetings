// Unit tests for the Zoom adapter's join state machine (platform-zoom.mjs
// joinFlow) against a fake page, on a virtual clock.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { joinFlow } from "../platform-zoom.mjs";

const BOT = "Notetaker";

/** Markers op result (page/zoom-page.js `markers`) with everything off. */
function markers(over = {}) {
  return {
    url: "http://127.0.0.1/mock/index.html",
    title: "Zoom meeting on web",
    text: "",
    error3001: false,
    errorTitle: false,
    errorMessage: null,
    registration: false,
    botWall: false,
    signIn: false,
    browserDisabled: false,
    captcha: false,
    captchaText: false,
    waitingRoom: false,
    waitingHost: false,
    wrongPasscode: false,
    denied: false,
    locked: false,
    full: false,
    ended: null,
    notice: null,
    loading: false,
    cookie: false,
    disclaimer: false,
    allow: false,
    joinFromBrowser: false,
    prejoin: null,
    inMeeting: false,
    audio: null,
    ...over,
  };
}

const form = (over = {}) =>
  markers({ text: "Enter Meeting Info Your Name Join", prejoin: { name: true, nameValue: BOT, join: true, joinDisabled: false, passcode: false, mic: null, video: null, ...over } });

/**
 * A fake page whose markers come from `script(elapsedMs, state)`; other ops
 * answer as an in-meeting page with computer audio joined.
 */
function fakeContext(script, { waitingTimeoutSec = 60, hang = false } = {}) {
  const t0 = Date.now();
  const state = { joinClicks: 0, gotos: 0 };
  const locator = () => ({
    first: () => locator(),
    or: () => locator(),
    click: async () => {},
    fill: async () => {},
    inputValue: async () => BOT,
  });
  const joinLocator = () => ({
    ...locator(),
    first: () => joinLocator(),
    click: async () => {
      state.joinClicks += 1;
    },
  });
  const frame = {
    evaluate: async (source) => {
      if (hang) return new Promise(() => {});
      const args = JSON.parse(source.slice(source.lastIndexOf(")({") + 2, -1));
      if (args.op === "markers") return script(Date.now() - t0, state);
      if (args.op === "audio") return { label: "unmute my microphone", joined: true, muted: true, clicked: null };
      if (args.op === "sweep") return [];
      return null;
    },
    locator: (selector) => (String(selector).includes("preview-join-button") ? joinLocator() : locator()),
    getByRole: () => locator(),
  };
  const page = {
    frames: () => [],
    mainFrame: () => frame,
    goto: async () => {
      state.gotos += 1;
    },
    keyboard: { press: async () => {}, type: async () => {} },
  };
  const phases = [];
  const ctx = {
    page,
    context: { clearCookies: async () => {} },
    config: { joinUrl: "http://127.0.0.1/mock/index.html", botName: BOT, passcode: null, waitingTimeoutSec, zoomProfileDir: null },
    selectors: {},
    display: ":nonexistent",
    signal: new AbortController().signal,
    log: () => {},
    setPhase: (phase, detail) => phases.push(`${phase}: ${detail}`),
    dumpDebug: async () => {},
    wantScreenshot: () => {},
    adapterState: {},
  };
  return { ctx, state, phases, t0 };
}

/** Advance the virtual clock in 1 s steps until `promise` settles or `maxMs` passes. */
async function drive(promise, maxMs) {
  let settled = null;
  promise.then(
    (value) => (settled = { ok: true, value }),
    (error) => (settled = { ok: false, error }),
  );
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  for (let elapsed = 0; settled === null && elapsed < maxMs; elapsed += 1_000) {
    await flush();
    mock.timers.tick(1_000);
  }
  await flush();
  return settled;
}

describe("joinFlow deadline", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 }));
  afterEach(() => mock.timers.reset());

  it("fails when the pre-join form never enables Join", async () => {
    const { ctx, t0 } = fakeContext(() => form({ joinDisabled: true }), { waitingTimeoutSec: 60 });
    const result = await drive(joinFlow(ctx, { launchPage: false }), 3_600_000);
    assert.ok(result && !result.ok, "joinFlow must not hang");
    assert.equal(result.error.code, "join_failed");
    assert.match(result.error.message, /kept Join disabled/);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 240_000 && elapsed <= 260_000, `failed after ${elapsed} ms`);
  });

  it("fails when Zoom hangs on 'Joining…' after the click", async () => {
    const { ctx, state, t0 } = fakeContext((_, s) => (s.joinClicks === 0 ? form() : markers({ text: "Joining meeting...", loading: true })), {
      waitingTimeoutSec: 300,
    });
    const result = await drive(joinFlow(ctx, { launchPage: false }), 3_600_000);
    assert.ok(result && !result.ok, "joinFlow must not hang");
    assert.equal(result.error.code, "join_failed");
    assert.match(result.error.message, /after it clicked Join/);
    assert.equal(state.joinClicks, 1);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 300_000 && elapsed <= 320_000, `failed after ${elapsed} ms`);
  });

  it("fails when the page stops answering", async () => {
    const { ctx, t0 } = fakeContext(() => form(), { waitingTimeoutSec: 0, hang: true });
    const result = await drive(joinFlow(ctx, { launchPage: false }), 3_600_000);
    assert.ok(result && !result.ok, "joinFlow must not hang");
    assert.equal(result.error.code, "join_failed");
    assert.match(result.error.message, /did not answer/);
    assert.ok(Date.now() - t0 <= 260_000);
  });

  it("does not count the waiting room against the join deadline", async () => {
    // 550 s in the waiting room (limit 600 s), then a slow 120 s load, then admitted.
    const { ctx, phases } = fakeContext(
      (elapsed, s) => {
        if (s.joinClicks === 0) return form();
        if (elapsed < 550_000) return markers({ text: "Please wait, the meeting host will let you in soon.", waitingRoom: true });
        if (elapsed < 670_000) return markers({ text: `Joining meeting... ${Math.floor(elapsed / 1000)}`, loading: true });
        return markers({ inMeeting: true });
      },
      { waitingTimeoutSec: 600 },
    );
    const result = await drive(joinFlow(ctx, { launchPage: false }), 3_600_000);
    assert.ok(result?.ok, result?.error?.message ?? "still joining");
    assert.ok(phases.some((p) => p.startsWith("waiting_room")));
  });

  it("still times out a waiting room with waiting_timeout", async () => {
    const { ctx } = fakeContext((_, s) => (s.joinClicks === 0 ? form() : markers({ waitingRoom: true })), { waitingTimeoutSec: 120 });
    const result = await drive(joinFlow(ctx, { launchPage: false }), 3_600_000);
    assert.equal(result?.error?.code, "waiting_timeout");
  });
});
