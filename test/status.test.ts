import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot } from "../src/shared/contract.js";
import type { BotState, TranscriberState } from "../src/shared/runtime-files.js";
import {
  BOT_START_GRACE_MS,
  MAX_TRANSCRIBER_FAILURES,
  TRANSCRIBER_STALL_MS,
  errorMessageFor,
  explainError,
  mapRuntime,
  type StatusContext,
} from "../src/server/status.js";
import { botState, transcriberState } from "./server-fixtures.js";

const ID = "mtg_test0001";
const NOW = 1_000_000;

function snap(parts: {
  bot?: Partial<BotState> | null;
  botAlive?: boolean;
  transcriber?: Partial<TranscriberState> | null;
  transcriberAlive?: boolean;
  audioBytes?: number | null;
  final?: boolean;
  segments?: number;
  exists?: boolean;
}): RuntimeSnapshot {
  return {
    meetingId: ID,
    exists: parts.exists ?? true,
    bot: parts.bot === null || parts.bot === undefined ? null : botState(ID, parts.bot),
    botAlive: parts.botAlive ?? true,
    transcriber: parts.transcriber === null || parts.transcriber === undefined ? null : transcriberState(parts.transcriber),
    transcriberAlive: parts.transcriberAlive ?? false,
    roster: null,
    files: {
      audioBytes: parts.audioBytes ?? null,
      screenshotMtime: 77,
      transcriptFinal: parts.final ?? false,
      segments: parts.segments ?? 0,
    },
  };
}

const ctx: StatusContext = {
  status: "starting",
  source: "agent",
  startedAt: NOW - 1000,
  transcriberFailures: 0,
  transcriberProgressAt: NOW - 1000,
  botDeathConfirmed: true,
  now: NOW,
};

describe("mapRuntime: bot phases", () => {
  it("is starting until the bot writes its state, then fails after the grace period", () => {
    expect(mapRuntime(snap({ bot: null, botAlive: true }), ctx).status).toBe("starting");
    expect(mapRuntime(snap({ bot: null, botAlive: false }), ctx).status).toBe("starting");
    const dead = mapRuntime(snap({ bot: null, botAlive: false }), { ...ctx, startedAt: NOW - BOT_START_GRACE_MS - 1 });
    expect(dead.status).toBe("failed");
    expect(dead.errorCode).toBe("unknown");
  });

  it.each([
    ["starting", "joining"],
    ["joining", "joining"],
    ["waiting_for_host", "waiting_for_host"],
    ["waiting_room", "waiting_room"],
    ["in_meeting", "recording"],
    ["leaving", "recording"],
  ] as const)("bot %s → %s", (phase, status) => {
    const mapped = mapRuntime(snap({ bot: { phase, activeSpeakers: ["Анна"] } }), ctx);
    expect(mapped.status).toBe(status);
    expect(mapped.botFinished).toBe(false);
    expect(mapped.transcriptProgress).toBeNull();
    expect(mapped.statusDetail).toBeTruthy();
  });

  it("reports live transcription, speakers and participants while recording", () => {
    const mapped = mapRuntime(
      snap({
        bot: {
          phase: "in_meeting",
          joinedAt: 10,
          recordingStartedAt: 11,
          activeSpeakers: ["Анна"],
          participants: { count: 3, names: ["Анна", "Борис"] },
          audio: { seconds: 61.5, bytes: 1000 },
        },
        transcriber: { phase: "live", processedSec: 30, audioSec: 60 },
        transcriberAlive: true,
        audioBytes: 900,
        segments: 4,
      }),
      ctx,
    );
    expect(mapped).toMatchObject({
      status: "recording",
      transcriptStatus: "live",
      joinedAt: 10,
      recordingStartedAt: 11,
      durationSec: 61.5,
      participantsCount: 3,
      participants: ["Анна", "Борис"],
      activeSpeakers: ["Анна"],
      hasAudio: true,
      screenshotMtime: 77,
      needsTranscriber: false,
    });
  });

  it("flags GigaAM outages during the live transcript", () => {
    const mapped = mapRuntime(
      snap({ bot: { phase: "in_meeting" }, transcriber: { phase: "waiting_asr", detail: "GigaAM unreachable" }, transcriberAlive: true }),
      ctx,
    );
    expect(mapped.transcriptStatus).toBe("live");
    expect(mapped.transcriptError).toBe("GigaAM unreachable");
  });
});

describe("mapRuntime: after the bot", () => {
  const ended = { phase: "ended" as const, endReason: "meeting_ended" as const, endedAt: 50, audio: { seconds: 600, bytes: 4096 } };

  it("is processing with progress while the transcriber finalizes", () => {
    const mapped = mapRuntime(
      snap({ bot: ended, botAlive: false, transcriber: { phase: "finalizing", processedSec: 450, audioSec: 600 }, transcriberAlive: true, audioBytes: 4096 }),
      { ...ctx, status: "recording" },
    );
    expect(mapped).toMatchObject({ status: "processing", transcriptStatus: "finalizing", transcriptProgress: 0.75, needsTranscriber: false, endReason: "meeting_ended" });
    expect(mapped.statusDetail).toBe("Распознавание: 75%");
  });

  it("asks for a transcriber when none is running", () => {
    const mapped = mapRuntime(snap({ bot: ended, botAlive: false, transcriber: null, audioBytes: 4096 }), { ...ctx, status: "recording" });
    expect(mapped.status).toBe("processing");
    expect(mapped.needsTranscriber).toBe(true);
    expect(mapped.transcriptStatus).toBe("finalizing");
  });

  it("fails after too many failed transcriber runs", () => {
    const mapped = mapRuntime(
      snap({ bot: ended, botAlive: false, transcriber: { phase: "failed", error: "ASR crashed" }, audioBytes: 4096 }),
      { ...ctx, status: "processing", transcriberFailures: MAX_TRANSCRIBER_FAILURES },
    );
    expect(mapped.status).toBe("failed");
    expect(mapped.transcriptStatus).toBe("failed");
    expect(mapped.transcriptError).toBe("ASR crashed");
    expect(mapped.errorMessage).toContain("ASR crashed");
  });

  it("fails when no transcriber has run or progressed for a long time", () => {
    const base = snap({ bot: ended, botAlive: false, transcriber: null, audioBytes: 4096 });
    const stale = mapRuntime(base, { ...ctx, status: "processing", transcriberProgressAt: NOW - TRANSCRIBER_STALL_MS - 1 });
    expect(stale.status).toBe("failed");
    expect(stale.transcriptError).toContain("не запускается");
    const recent = mapRuntime(base, { ...ctx, status: "processing", transcriberProgressAt: NOW - 60_000 });
    expect(recent.status).toBe("processing");
    expect(recent.needsTranscriber).toBe(true);
  });

  it("restarts a live transcriber that died mid-meeting", () => {
    const mapped = mapRuntime(snap({ bot: { phase: "in_meeting" }, transcriber: { phase: "live" }, transcriberAlive: false }), ctx);
    expect(mapped.status).toBe("recording");
    expect(mapped.needsTranscriber).toBe(true);
    const off = mapRuntime(snap({ bot: { phase: "in_meeting" }, transcriber: null }), ctx);
    expect(off.needsTranscriber).toBe(false);
  });

  it("is done once the final transcript exists", () => {
    const mapped = mapRuntime(
      snap({ bot: ended, botAlive: false, transcriber: { phase: "done" }, audioBytes: 4096, final: true, segments: 12 }),
      { ...ctx, status: "processing" },
    );
    expect(mapped).toMatchObject({ status: "done", transcriptStatus: "done", transcriptProgress: null, needsTranscriber: false });
  });

  it("keeps the error of a bot that failed mid-meeting but still has audio", () => {
    const crashed = {
      phase: "failed" as const,
      endReason: "error" as const,
      error: { code: "browser_crashed" as const, message: "Target closed" },
      audio: { seconds: 120, bytes: 2048 },
    };
    const processing = mapRuntime(snap({ bot: crashed, botAlive: false, audioBytes: 2048 }), { ...ctx, status: "recording" });
    expect(processing.status).toBe("processing");
    expect(processing.errorCode).toBe("browser_crashed");
    const done = mapRuntime(snap({ bot: crashed, botAlive: false, audioBytes: 2048, final: true }), { ...ctx, status: "processing" });
    expect(done.status).toBe("done");
    expect(done.errorCode).toBe("browser_crashed");
    expect(done.errorMessage).toBe("Браузер бота аварийно завершился. Target closed");
  });

  it("fails a bot that failed without audio, with the Russian explanation", () => {
    const mapped = mapRuntime(
      snap({ bot: { phase: "failed", error: { code: "wrong_passcode", message: "Passcode wrong" } }, botAlive: false }),
      ctx,
    );
    expect(mapped.status).toBe("failed");
    expect(mapped.errorCode).toBe("wrong_passcode");
    expect(mapped.errorMessage).toBe(`${explainError("wrong_passcode")}. Passcode wrong`);
  });

  it("derives an error from the end reason when the bot ended without audio", () => {
    const mapped = mapRuntime(snap({ bot: { phase: "ended", endReason: "waiting_timeout" }, botAlive: false }), { ...ctx, status: "waiting_room" });
    expect(mapped.status).toBe("failed");
    expect(mapped.errorCode).toBe("waiting_timeout");
  });

  it("treats a stop before any audio as cancelled", () => {
    const mapped = mapRuntime(snap({ bot: { phase: "ended", endReason: "stopped" }, botAlive: false }), { ...ctx, status: "waiting_room" });
    expect(mapped.status).toBe("cancelled");
  });

  it("waits for a second look before calling a dead, non-terminal bot crashed", () => {
    const racing = mapRuntime(snap({ bot: { phase: "leaving" }, botAlive: false }), { ...ctx, status: "recording", botDeathConfirmed: false });
    expect(racing.status).toBe("recording");
    expect(racing.errorCode).toBeNull();
  });

  it("treats a dead bot that never wrote a terminal state as crashed", () => {
    const noAudio = mapRuntime(snap({ bot: { phase: "in_meeting" }, botAlive: false }), { ...ctx, status: "recording" });
    expect(noAudio.status).toBe("failed");
    expect(noAudio.errorCode).toBe("browser_crashed");
    const withAudio = mapRuntime(
      snap({ bot: { phase: "in_meeting", audio: { seconds: 30, bytes: 500 } }, botAlive: false, audioBytes: 500 }),
      { ...ctx, status: "recording" },
    );
    expect(withAudio.status).toBe("processing");
    expect(withAudio.needsTranscriber).toBe(true);
  });

  it("marks meetings whose directory vanished as lost", () => {
    const mapped = mapRuntime(snap({ exists: false }), { ...ctx, status: "processing" });
    expect(mapped.status).toBe("failed");
    expect(mapped.statusDetail).toBe("lost");
    expect(mapped.errorMessage).toContain("lost");
  });

  it("gives a starting bot the grace period to get its directory before calling it lost", () => {
    const early = mapRuntime(snap({ exists: false }), ctx);
    expect(early).toMatchObject({ status: "starting", errorCode: null, errorMessage: null });
    expect(mapRuntime(snap({ exists: false }), { ...ctx, startedAt: NOW - BOT_START_GRACE_MS - 1 }).statusDetail).toBe("lost");
    expect(mapRuntime(snap({ exists: false }), { ...ctx, startedAt: null }).statusDetail).toBe("lost");
  });
});

describe("mapRuntime: imports", () => {
  const importCtx: StatusContext = { ...ctx, status: "processing", source: "import" };

  it("is processing while the offline transcriber runs", () => {
    const mapped = mapRuntime(
      snap({ bot: null, botAlive: false, transcriber: { mode: "offline", phase: "live", processedSec: 10, audioSec: 40 }, transcriberAlive: true, audioBytes: 999 }),
      importCtx,
    );
    expect(mapped).toMatchObject({ status: "processing", transcriptStatus: "finalizing", transcriptProgress: 0.25 });
  });

  it("waits for the file conversion, then fails without audio", () => {
    expect(mapRuntime(snap({ bot: null, botAlive: false }), importCtx).status).toBe("processing");
    expect(
      mapRuntime(snap({ bot: null, botAlive: false }), { ...importCtx, startedAt: NOW - BOT_START_GRACE_MS - 1 }).status,
    ).toBe("failed");
  });

  it("is done when the transcript is final", () => {
    expect(mapRuntime(snap({ bot: null, botAlive: false, audioBytes: 999, final: true }), importCtx).status).toBe("done");
  });

  it("treats the host's recordingStartedAt 0 as no date", () => {
    const mapped = mapRuntime(
      snap({ bot: { phase: "ended", endReason: "stopped", recordingStartedAt: 0, joinedAt: 0, endedAt: 5_000 }, botAlive: false, audioBytes: 999, final: true }),
      importCtx,
    );
    expect(mapped).toMatchObject({ status: "done", recordingStartedAt: null, joinedAt: null, endedAt: 5_000 });
  });
});

describe("error texts", () => {
  it("has Russian and English explanations", () => {
    expect(explainError("captcha")).toContain("капчу");
    expect(explainError("captcha", "en")).toContain("captcha");
    expect(errorMessageFor("unknown", null)).toBe("Неизвестная ошибка");
  });
});
