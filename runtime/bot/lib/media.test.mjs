// Unit tests for the avatar camera (docs/dev/DESIGN.md §14): the camera
// decision and Chrome switches (lib/media.mjs), and the Zoom adapter's
// preview / after-admission camera handling against a fake page.
// Run: node --test runtime/bot/lib/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { avatarChecks, checkSpeaker, ensureVideo, previewDevices } from "../platform-zoom.mjs";
import { FALLBACK_SILENCE, cameraPlan, fakeMediaArgs, silenceCandidates, silenceWav, videoIsOn, withSilence } from "./media.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-media-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** <tmp>/<name>/bot/render/<key>.mjpeg (+ silence.wav where asked), like <hostData>. */
function hostData(name, { silence = "bot" } = {}) {
  const bot = path.join(tmp, name, "bot");
  const render = path.join(bot, "render");
  fs.mkdirSync(render, { recursive: true });
  const video = path.join(render, "0123456789ab.mjpeg");
  fs.writeFileSync(video, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  if (silence === "bot") fs.writeFileSync(path.join(bot, "silence.wav"), silenceWav());
  if (silence === "render") fs.writeFileSync(path.join(render, "silence.wav"), silenceWav());
  return { bot, render, video };
}

describe("cameraPlan", () => {
  it("keeps the camera off without an avatar video, and says why", () => {
    assert.deepEqual(cameraPlan({ mode: "meeting", avatar: false, avatarVideo: null }), { camera: "off", reason: "the avatar is off" });
    assert.match(cameraPlan({ mode: "meeting", avatar: true, avatarVideo: null }).reason, /rendered no avatar video/);
    // Configs from before the avatar existed.
    assert.equal(cameraPlan({ mode: "meeting" }).camera, "off");
  });

  it("never uses the camera in a sign-in session", () => {
    const { video } = hostData("login");
    assert.equal(cameraPlan({ mode: "login", avatar: true, avatarVideo: video }).camera, "off");
  });

  it("refuses relative, non-MJPEG and missing paths", () => {
    assert.match(cameraPlan({ mode: "meeting", avatarVideo: "render/x.mjpeg" }).reason, /absolute \.mjpeg/);
    assert.match(cameraPlan({ mode: "meeting", avatarVideo: "/tmp/x.y4m" }).reason, /absolute \.mjpeg/);
    assert.match(cameraPlan({ mode: "meeting", avatarVideo: 42 }).reason, /absolute \.mjpeg/);
    assert.match(cameraPlan({ mode: "meeting", avatarVideo: path.join(tmp, "nope", "x.mjpeg") }).reason, /missing/);
  });

  it("uses the video with <hostData>/bot/silence.wav, or one next to the video", () => {
    const a = hostData("a");
    assert.deepEqual(cameraPlan({ mode: "meeting", avatar: true, avatarVideo: a.video }), {
      camera: "avatar",
      video: a.video,
      audio: path.join(a.bot, "silence.wav"),
      reason: "showing the avatar as the camera",
    });
    const b = hostData("b", { silence: "render" });
    assert.equal(cameraPlan({ mode: "meeting", avatarVideo: b.video }).audio, path.join(b.render, "silence.wav"));
    assert.deepEqual(silenceCandidates("/d/bot/render/k.mjpeg"), ["/d/bot/silence.wav", "/d/bot/render/silence.wav"]);
    const c = hostData("c", { silence: "none" });
    const plan = cameraPlan({ mode: "meeting", avatarVideo: c.video });
    assert.equal(plan.camera, "avatar");
    assert.equal(plan.audio, null);
  });

  it("writes its own silent microphone when the host's is missing", () => {
    const c = hostData("own", { silence: "none" });
    const meetingDir = path.join(tmp, "own-meeting");
    fs.mkdirSync(meetingDir);
    const plan = withSilence(cameraPlan({ mode: "meeting", avatarVideo: c.video }), meetingDir);
    assert.equal(plan.audio, path.join(meetingDir, FALLBACK_SILENCE));
    assert.equal(plan.ownSilence, true);
    assert.deepEqual(fs.readFileSync(plan.audio), silenceWav());
    // Plans that already have a microphone, or no camera, are left alone.
    const off = { camera: "off", reason: "x" };
    assert.equal(withSilence(off, meetingDir), off);
  });
});

describe("fakeMediaArgs", () => {
  it("gives Chrome the MJPEG as its camera and the WAV as its microphone", () => {
    assert.deepEqual(fakeMediaArgs({ camera: "avatar", video: "/h/bot/render/k.mjpeg", audio: "/h/bot/silence.wav" }), [
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=/h/bot/render/k.mjpeg",
      "--use-file-for-fake-audio-capture=/h/bot/silence.wav",
    ]);
  });

  it("adds nothing without an avatar (PulseAudio mic, no camera), or without a silent mic (fake devices would beep)", () => {
    assert.deepEqual(fakeMediaArgs({ camera: "off", reason: "the avatar is off" }), []);
    assert.deepEqual(fakeMediaArgs({ camera: "avatar", video: "/v.mjpeg", audio: null }), []);
    assert.deepEqual(fakeMediaArgs(undefined), []);
  });

  it("writes a valid 1 s, 48 kHz mono, 16-bit WAV", () => {
    const wav = silenceWav();
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    assert.equal(wav.toString("latin1", 8, 16), "WAVEfmt ");
    assert.equal(wav.readUInt32LE(24), 48_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 96_000);
    assert.equal(wav.length, 44 + 96_000);
  });
});

describe("videoIsOn", () => {
  it("reads Zoom's camera button", () => {
    assert.equal(videoIsOn({ label: "stop my video", icon: "SvgVideoOn" }), true); // Zoom web client 2026-10
    assert.equal(videoIsOn({ label: "start my video", icon: "SvgVideoOff" }), false);
    assert.equal(videoIsOn({ label: "Stop Video" }), true);
    assert.equal(videoIsOn({ label: "Start Video" }), false);
    assert.equal(videoIsOn({ label: "Video", icon: "SvgVideoOn" }), true);
    assert.equal(videoIsOn({ label: "Video", icon: "SvgVideoOffDisallowed" }), false);
    assert.equal(videoIsOn({ label: "Video", icon: "" }), null);
    assert.equal(videoIsOn(), null);
  });
});

/** A fake page: `video` answers come from `videoStates` (one per state read), clicks are counted. */
function fakeCtx({ camera = "avatar", videoStates = [], store = null, prejoin = null } = {}) {
  const calls = { videoClicks: 0, previewClicks: [], ops: [] };
  const logs = [];
  let reads = 0;
  const frame = {
    evaluate: async (source) => {
      const args = JSON.parse(source.slice(source.lastIndexOf(")({") + 2, -1));
      calls.ops.push(args.op);
      if (args.op === "video") {
        if (args.action === "click") {
          calls.videoClicks += 1;
          return { found: true, clicked: true };
        }
        const state = videoStates[Math.min(reads, videoStates.length - 1)] ?? { found: false };
        reads += 1;
        return state;
      }
      if (args.op === "store") return typeof store === "function" ? store() : store;
      if (args.op === "click") {
        calls.previewClicks.push(args.selectors[0]);
        return "clicked";
      }
      return null;
    },
    locator: (selector) => ({
      click: async () => {
        calls.previewClicks.push(selector);
      },
    }),
  };
  const ctx = {
    page: { frames: () => [], mainFrame: () => frame },
    camera,
    signal: new AbortController().signal,
    log: (level, msg, data) => logs.push({ level, msg, data }),
    adapterState: {},
    joinedAt: Date.now(),
  };
  return { ctx, frame, calls, logs, prejoin };
}

const ON = { found: true, label: "stop my video", text: "Stop Video", icon: "SvgVideoOn", disabled: false };
const OFF = { found: true, label: "start my video", text: "Start Video", icon: "SvgVideoOff", disabled: false };

describe("previewDevices", () => {
  it("with the avatar: keeps the camera on, starts it when Zoom offers it off; mutes the mic", async () => {
    const keep = fakeCtx();
    await previewDevices(keep.ctx, keep.frame, { mic: "Mute", video: "Stop Video" });
    assert.deepEqual(keep.calls.previewClicks, ["#preview-audio-control-button"]);
    assert.ok(keep.logs.some((l) => l.msg === "Keeping the camera on in the preview (avatar)"));
    const start = fakeCtx();
    await previewDevices(start.ctx, start.frame, { mic: "Unmute", video: "Start Video" });
    assert.deepEqual(start.calls.previewClicks, ["#preview-video-control-button"]);
    assert.ok(start.logs.some((l) => l.msg === "Started the camera in the preview (avatar)"));
  });

  it("without the avatar: stops the camera as before and never starts it", async () => {
    const stop = fakeCtx({ camera: "off" });
    await previewDevices(stop.ctx, stop.frame, { mic: "Mute", video: "Stop Video" });
    assert.deepEqual(stop.calls.previewClicks, ["#preview-audio-control-button", "#preview-video-control-button"]);
    const off = fakeCtx({ camera: "off" });
    await previewDevices(off.ctx, off.frame, { mic: "Unmute", video: "Start Video" });
    assert.deepEqual(off.calls.previewClicks, []);
  });
});

describe("ensureVideo", () => {
  it("presses Start Video once and confirms", async () => {
    const { ctx, calls, logs } = fakeCtx({ videoStates: [OFF, ON] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 8 }), true);
    assert.equal(calls.videoClicks, 1);
    assert.equal(ctx.adapterState.videoOn, true);
    assert.ok(logs.some((l) => l.msg === "Starting the camera (avatar)"));
    assert.ok(logs.some((l) => l.msg === "Camera is on (avatar)"));
  });

  it("waits for the footer button instead of clicking blindly", async () => {
    const { ctx, calls } = fakeCtx({ videoStates: [{ found: false }, { found: false }, ON] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 8 }), true);
    assert.equal(calls.videoClicks, 0);
  });

  it("never toggles an unknown state, and gives up quietly", async () => {
    const { ctx, calls, logs } = fakeCtx({ videoStates: [{ found: true, label: "Video", icon: "", disabled: false }] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 3 }), null);
    assert.equal(calls.videoClicks, 0);
    assert.equal(logs.filter((l) => l.level === "warn").length, 1);
    await ensureVideo(ctx, { pauseMs: 0, checks: 1 });
    assert.equal(logs.filter((l) => l.level === "warn").length, 1, "warned once");
  });

  it("waits while Zoom keeps the button disabled (the camera is starting) and never clicks it", async () => {
    const starting = { ...OFF, disabled: true };
    const { ctx, calls, logs } = fakeCtx({ videoStates: [starting, starting, ON] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 8 }), true);
    assert.equal(calls.videoClicks, 0);
    assert.ok(!logs.some((l) => l.level === "warn"));
    // Still disabled after every check: no verdict, so the sampler keeps checking for a while.
    const stuck = fakeCtx({ videoStates: [starting] });
    assert.equal(await ensureVideo(stuck.ctx, { pauseMs: 0, checks: 3 }), false);
    assert.equal(stuck.ctx.adapterState.videoOn, undefined);
    assert.equal(stuck.calls.videoClicks, 0);
  });

  it("stops when Zoom does not allow the camera", async () => {
    const { ctx, calls } = fakeCtx({ videoStates: [{ found: true, label: "Video", icon: "SvgVideoOffDisallowed", disabled: false }] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0 }), false);
    assert.equal(calls.videoClicks, 0);
    assert.equal(ctx.adapterState.videoOn, false);
  });

  it("caps the clicks on a camera that stays off", async () => {
    const { ctx, calls } = fakeCtx({ videoStates: [OFF] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 10 }), false);
    assert.equal(calls.videoClicks, 4);
    assert.equal(await ensureVideo(ctx, { pauseMs: 0, checks: 10 }), false);
    assert.equal(calls.videoClicks, 4);
  });

  it("leaves the camera off once it was on (the host or the user turned it off)", async () => {
    const { ctx, calls, logs } = fakeCtx({ videoStates: [ON, OFF] });
    assert.equal(await ensureVideo(ctx, { pauseMs: 0 }), true);
    assert.equal(await ensureVideo(ctx, { pauseMs: 0 }), false);
    assert.equal(calls.videoClicks, 0);
    assert.ok(logs.some((l) => l.msg === "The camera was turned off in the meeting; leaving it off"));
  });
});

describe("ensureVideo timing (the recorder and the sampler wait for it)", () => {
  it("makes one check by default and never pauses after the last check", async () => {
    // No footer camera button (webinar attendee), a disabled button, an unknown label: the
    // states that used to cost 8 checks x 1.5 s before the recorder started.
    for (const state of [{ found: false }, { ...OFF, disabled: true }, { found: true, label: "Video", icon: "", disabled: false }]) {
      const { ctx, calls } = fakeCtx({ videoStates: [state] });
      const started = Date.now();
      await ensureVideo(ctx, { warn: false });
      assert.ok(Date.now() - started < 300, `one check took ${Date.now() - started} ms`);
      assert.equal(calls.ops.filter((op) => op === "video").length, 1);
    }
    const { ctx } = fakeCtx({ videoStates: [{ found: false }] });
    const started = Date.now();
    await ensureVideo(ctx, { checks: 2, pauseMs: 400, warn: false });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350 && elapsed < 750, `two checks took ${elapsed} ms (one pause between them, none after)`);
  });

  it("clicks at most once in a single check and leaves the confirmation to a later check", async () => {
    const { ctx, calls, logs } = fakeCtx({ videoStates: [OFF, ON] });
    assert.equal(await ensureVideo(ctx, { warn: false }), false);
    assert.equal(calls.videoClicks, 1);
    assert.equal(ctx.adapterState.videoOn, undefined);
    assert.ok(!logs.some((l) => l.level === "warn"));
    assert.equal(await ensureVideo(ctx, { warn: false }), true);
    assert.equal(ctx.adapterState.videoOn, true);
  });
});

describe("avatarChecks (from ensureAudio, while recording)", () => {
  const speakerStore = (id) => ({ found: true, devices: { activeSpeaker: id, speakers: [{ deviceId: "default", label: "Fake Default Audio Output" }] } });

  it("checks the camera once per call without pausing, then warns once when the grace period is over", async () => {
    const starting = { ...OFF, disabled: true };
    const { ctx, calls, logs } = fakeCtx({ videoStates: [starting], store: speakerStore("default") });
    const started = Date.now();
    await avatarChecks(ctx);
    await avatarChecks(ctx);
    assert.ok(Date.now() - started < 300, `two sampler checks took ${Date.now() - started} ms`);
    assert.equal(calls.ops.filter((op) => op === "video").length, 2);
    assert.equal(calls.videoClicks, 0);
    assert.ok(!logs.some((l) => l.level === "warn"), "no warning inside the grace period");
    ctx.joinedAt = Date.now() - 121_000;
    await avatarChecks(ctx);
    await avatarChecks(ctx);
    assert.equal(calls.ops.filter((op) => op === "video").length, 2, "no camera checks after the grace period");
    assert.deepEqual(
      logs.filter((l) => l.level === "warn").map((l) => l.msg),
      ["The camera did not turn on; the avatar may not be shown"],
    );
  });

  it("stops checking the camera once it is on", async () => {
    const { ctx, calls, logs } = fakeCtx({ videoStates: [ON], store: speakerStore("default") });
    await avatarChecks(ctx);
    await avatarChecks(ctx);
    assert.equal(calls.ops.filter((op) => op === "video").length, 1);
    assert.ok(logs.some((l) => l.msg === "Camera is on (avatar)"));
  });

  it("reads the speaker choice on the first call, then every minute, logging only changes", async () => {
    let speaker = "default";
    const { ctx, calls, logs } = fakeCtx({ videoStates: [ON], store: () => speakerStore(speaker) });
    await avatarChecks(ctx);
    await avatarChecks(ctx);
    assert.equal(calls.ops.filter((op) => op === "store").length, 1, "not re-read within a minute");
    assert.equal(logs.filter((l) => /^Zoom plays the meeting/.test(l.msg)).length, 1);
    ctx.adapterState.speakerCheckedAt -= 60_000;
    await avatarChecks(ctx);
    assert.equal(calls.ops.filter((op) => op === "store").length, 2);
    assert.equal(logs.filter((l) => /^Zoom plays the meeting/.test(l.msg)).length, 1, "an unchanged choice is not logged again");
    speaker = { deviceId: "fake-out-1", label: "Fake Audio Output 1" };
    ctx.adapterState.speakerCheckedAt -= 60_000;
    await avatarChecks(ctx);
    assert.equal(logs.at(-1).level, "warn");
    assert.match(logs.at(-1).msg, /non-default output/);
  });
});

describe("checkSpeaker", () => {
  it("logs the default output as recorded and warns about any other", async () => {
    const good = fakeCtx({ store: { found: true, devices: { activeSpeaker: "default", speakers: [{ deviceId: "default", label: "Fake Default Audio Output" }] } } });
    assert.equal(await checkSpeaker(good.ctx), "default");
    assert.deepEqual(good.logs.at(-1), { level: "info", msg: "Zoom plays the meeting to the default output (recorded)", data: { speaker: "Fake Default Audio Output" } });
    const bad = fakeCtx({ store: { found: true, devices: { activeSpeaker: { deviceId: "abc", label: "Fake Audio Output 1" }, speakers: [] } } });
    assert.equal(await checkSpeaker(bad.ctx), "abc");
    assert.equal(bad.logs.at(-1).level, "warn");
    const none = fakeCtx({ store: { found: false } });
    assert.equal(await checkSpeaker(none.ctx), null);
  });
});
