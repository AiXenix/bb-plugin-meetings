// The bot's camera and microphone in Chrome (docs/dev/DESIGN.md §14). Without
// an avatar Chrome uses the PulseAudio remap source as its microphone and has
// no camera. With config.avatarVideo (an MJPEG the host rendered from the
// avatar and the bot's name) Chrome's fake capture devices replace both: the
// MJPEG loops as the camera and a silent WAV is the microphone. Audio output
// is untouched, so the recording still captures what Chrome plays.
import fs from "node:fs";
import path from "node:path";

export const FAKE_DEVICES_FLAG = "--use-fake-device-for-media-stream";
export const FAKE_VIDEO_FLAG = "--use-file-for-fake-video-capture=";
export const FAKE_AUDIO_FLAG = "--use-file-for-fake-audio-capture=";
/** Written into the meeting dir when the host's silence.wav is missing; removed at cleanup. */
export const FALLBACK_SILENCE = "fake-mic.wav";

function readable(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the host keeps silence.wav for a render: <hostData>/bot/render/<key>.mjpeg
 * → <hostData>/bot/silence.wav (also accepted next to the video).
 */
export function silenceCandidates(video) {
  const dir = path.dirname(video);
  return [path.join(path.dirname(dir), "silence.wav"), path.join(dir, "silence.wav")];
}

/**
 * The camera decision for a run: { camera: "avatar", video, audio, reason } or
 * { camera: "off", reason }. `audio` is null when no silence.wav was found
 * (the runner then writes its own). Login sessions never get a camera.
 */
export function cameraPlan(config, { exists = readable } = {}) {
  if (config.mode === "login") return { camera: "off", reason: "a sign-in session has no camera" };
  const video = config.avatarVideo;
  if (video === undefined || video === null || video === "") {
    return { camera: "off", reason: config.avatar ? "the avatar is on, but the host rendered no avatar video (no avatar image?)" : "the avatar is off" };
  }
  if (typeof video !== "string" || !path.isAbsolute(video) || !/\.mjpeg$/i.test(video)) {
    return { camera: "off", reason: `avatarVideo is not an absolute .mjpeg path: ${String(video).slice(0, 200)}` };
  }
  if (!exists(video)) return { camera: "off", reason: `the avatar video is missing: ${video}` };
  const audio = silenceCandidates(video).find((file) => exists(file)) ?? null;
  return { camera: "avatar", video, audio, reason: "showing the avatar as the camera" };
}

/** Chrome switches for a plan: fake camera (the MJPEG) and fake microphone (silence), or none. */
export function fakeMediaArgs(plan) {
  if (plan?.camera !== "avatar" || !plan.video || !plan.audio) return [];
  return [FAKE_DEVICES_FLAG, `${FAKE_VIDEO_FLAG}${plan.video}`, `${FAKE_AUDIO_FLAG}${plan.audio}`];
}

/** 1 s of 48 kHz mono 16-bit silence as a WAV file (the fake microphone loops it). */
export function silenceWav(seconds = 1, rate = 48_000) {
  const dataBytes = Math.round(seconds * rate) * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "latin1");
  wav.write("fmt ", 12, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

/** Fill in `plan.audio` with a silence file in `dir` when the host's is missing. */
export function withSilence(plan, dir) {
  if (plan.camera !== "avatar" || plan.audio) return plan;
  const file = path.join(dir, FALLBACK_SILENCE);
  fs.writeFileSync(file, silenceWav());
  return { ...plan, audio: file, ownSilence: true };
}

/**
 * Zoom's camera button state from what page/zoom-page.js reports
 * ({label, text, icon}): true = on, false = off, null = unknown (no camera,
 * "Video" without an icon hint).
 */
export function videoIsOn({ label = "", text = "", icon = "" } = {}) {
  const words = `${label} ${text}`.toLowerCase();
  if (/stop (my )?video|turn off (my )?(video|camera)/.test(words)) return true;
  if (/start (my )?video|turn on (my )?(video|camera)/.test(words)) return false;
  if (/videooff/i.test(icon)) return false;
  if (/videoon/i.test(icon)) return true;
  return null;
}
