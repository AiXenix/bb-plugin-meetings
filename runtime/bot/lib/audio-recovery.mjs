// Deaf-bot recovery helpers for adapters without a "computer audio" switch
// (Telemost, Google Meet, Jitsi; docs/dev/DESIGN.md §6.8). The guard itself
// is lib/deaf-guard.mjs; the page reload step is bot-runner's (it reuses the
// adapter's join flow). Nothing here clicks a meeting control.

/**
 * In every frame: start paused media elements that play one of the meeting's
 * streams (srcObject with a live audio track), and route such elements playing
 * to a non-default output back to the default one (the only output the
 * recording captures, DESIGN §14.1). Never unmutes anything, and never touches
 * file-backed media: meeting pages keep their UI sounds as paused
 * <audio src> elements (Jitsi preloads ringing, chimes and reaction sounds, the
 * ringing one looping), and playing them would put them into the recording
 * and look like the meeting audio coming back.
 */
export const KICK_SOURCE = `(() => {
  let media = 0, streams = 0, played = 0, rerouted = 0, files = 0;
  const meetingAudio = (el) => {
    const stream = el.srcObject;
    if (!stream || typeof stream.getAudioTracks !== "function") return false;
    return stream.getAudioTracks().some((track) => track.readyState === "live");
  };
  for (const el of document.querySelectorAll("audio, video")) {
    media += 1;
    try {
      if (!meetingAudio(el)) {
        if (!el.srcObject && el.currentSrc) files += 1;
        continue;
      }
      streams += 1;
      if (el.paused) { el.play().catch(() => {}); played += 1; }
      if (typeof el.setSinkId === "function" && el.sinkId !== "" && el.sinkId !== "default") { el.setSinkId("").catch(() => {}); rerouted += 1; }
    } catch {}
  }
  return { media, streams, played, rerouted, files };
})()`;

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resume the page's meeting playback on the default output. Returns {ok, detail, media, streams, played, rerouted, files, frames}. */
export async function kickPageAudio(page) {
  const total = { media: 0, streams: 0, played: 0, rerouted: 0, files: 0, frames: 0 };
  for (const frame of page.frames()) {
    const got = await bounded(frame.evaluate(KICK_SOURCE), 3_000);
    if (!got) continue;
    total.frames += 1;
    total.media += got.media;
    total.streams += got.streams ?? 0;
    total.played += got.played;
    total.rerouted += got.rerouted;
    total.files += got.files ?? 0;
  }
  return {
    ok: total.frames > 0,
    detail: `media elements ${total.media} (meeting streams ${total.streams}), restarted ${total.played}, moved to the default output ${total.rerouted}, platform sound files left alone ${total.files}`,
    ...total,
  };
}

/** recoverAudio(ctx, step) for adapters whose only audio-level step is the media kick. */
export async function recoverPageAudio(ctx, step) {
  if (step !== "rejoin_audio") return { ok: false, detail: `unsupported step ${step}` };
  const result = await kickPageAudio(ctx.page);
  ctx.log("info", "Restarted the page's audio playback (deaf-bot recovery)", { media: result.media, streams: result.streams, played: result.played, rerouted: result.rerouted, files: result.files });
  return result;
}
