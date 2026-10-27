// The Zoom adapter's deaf-bot recovery step (platform-zoom.mjs recoverAudio,
// DESIGN §6.8) against a fake web-client frame: which page ops it runs, that it
// never touches the meeting's Leave/End, that it stops when its signal aborts,
// and that a step called off after rejoining still leaves the bot muted.
// (Ported from a downstream review, 2026-10-27.)
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverAudio } from "../platform-zoom.mjs";

/**
 * A page whose zoom-page.js ops are answered by a tiny audio model: computer
 * audio joined and muted, the speaker on "default". `onOp(args, model)` may
 * change the model or abort the step.
 */
function fakeZoom({ onOp = () => {}, speaker = "default" } = {}) {
  const model = { joined: true, muted: true, menuOpen: false, refuseJoin: false, ops: [] };
  const answer = (args) => {
    model.ops.push(args.action ? `${args.op}:${args.action}` : args.op);
    onOp(args, model);
    switch (args.op) {
      case "store":
        return { found: true, devices: { activeSpeaker: { deviceId: speaker, label: speaker }, speakers: [] } };
      case "audioMenu":
        if (args.action === "open") {
          const wasOpen = model.menuOpen;
          model.menuOpen = true;
          return { toggle: true, wasOpen, open: true, items: [{ text: "Leave Computer Audio", label: "", checked: false }] };
        }
        if (args.action === "close") {
          const wasOpen = model.menuOpen;
          model.menuOpen = false;
          return { wasOpen, open: false };
        }
        if (args.action === "leave") {
          model.joined = false;
          model.muted = false;
          return { clicked: "Leave Computer Audio", items: [] };
        }
        return { clicked: null, already: true, items: [] };
      case "audio": {
        let clicked = null;
        if (args.action === "join" && !model.joined && !model.refuseJoin) {
          model.joined = true;
          model.muted = false;
          clicked = "dialog";
        } else if (args.action === "mute" && model.joined && !model.muted) {
          model.muted = true;
          clicked = "mute";
        }
        return { label: model.joined ? (model.muted ? "unmute my microphone" : "mute my microphone") : "join audio", joined: model.joined, muted: model.muted, clicked };
      }
      default:
        return null;
    }
  };
  const frame = {
    name: () => "",
    evaluate: async (source) => answer(JSON.parse(source.slice(source.lastIndexOf(")({") + 2, -1))),
  };
  const page = { frames: () => [frame], mainFrame: () => frame, mouse: { move: async () => {} } };
  return { model, page };
}

function ctxFor(page, signal = new AbortController().signal) {
  const logs = [];
  return { ctx: { page, signal, adapterState: {}, log: (level, msg) => logs.push(`${level} ${msg}`) }, logs };
}

describe("Zoom recoverAudio (deaf-bot step rejoin_audio)", () => {
  it("leaves computer audio through the audio menu, joins it again and mutes; never the meeting's Leave/End", async () => {
    const { model, page } = fakeZoom();
    const { ctx } = ctxFor(page);
    const result = await recoverAudio(ctx, "rejoin_audio");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.left, "Leave Computer Audio");
    assert.equal(model.joined && model.muted, true);
    assert.equal(ctx.adapterState.audioJoined, true);
    assert.ok(model.ops.every((op) => /^(store|audioMenu:(open|close|leave|speaker)|audio:(state|join|mute))$/.test(op)), model.ops.join(", "));
    assert.ok(!model.ops.some((op) => op.startsWith("leave")), "the meeting's leave op is never used");
  });

  it("stops as soon as its signal aborts (runner timeout or Stop) and leaves the rejoin to ensureAudio", async () => {
    const step = new AbortController();
    // Zoom never offers computer audio again after the leave; the step would retry for 25 s.
    const { model, page } = fakeZoom({
      onOp: (args, m) => {
        m.refuseJoin = true;
        if (args.op === "audio" && args.action === "join" && m.ops.filter((op) => op === "audio:join").length === 2) step.abort();
      },
    });
    const { ctx } = ctxFor(page, step.signal);
    const started = Date.now();
    const result = await recoverAudio(ctx, "rejoin_audio");
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
    assert.equal(result.ok, false);
    assert.equal(model.ops.filter((op) => op === "audio:join").length, 2);
    assert.equal(model.ops.includes("audio:mute"), false, "nothing to mute: not joined");
    // Not joined: the sampler's 5 s ensureAudio joins (and mutes) again.
    assert.equal(ctx.adapterState.audioJoined, false);
  });

  it("called off right after joining again, it still mutes once: the bot never stays unmuted", async () => {
    const step = new AbortController();
    const { model, page } = fakeZoom({
      onOp: (args, m) => {
        // The step's time runs out just as Zoom joined computer audio (unmuted).
        if (args.op === "audio" && args.action === "join" && m.joined === false) queueMicrotask(() => step.abort());
      },
    });
    const { ctx } = ctxFor(page, step.signal);
    await recoverAudio(ctx, "rejoin_audio");
    assert.equal(step.signal.aborted, true);
    assert.equal(model.joined, true);
    assert.equal(model.muted, true, model.ops.join(", "));
    assert.equal(model.ops.filter((op) => op === "audio:mute").length, 1);
  });

  it("other steps are not the adapter's", async () => {
    const { page } = fakeZoom();
    const { ctx } = ctxFor(page);
    assert.equal((await recoverAudio(ctx, "reload")).ok, false);
  });
});
