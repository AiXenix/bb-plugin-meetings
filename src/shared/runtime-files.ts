// Shapes of the files inside a meeting directory on the recording machine
// (docs/dev/DESIGN.md §4). The bot runner (plain JS) and the transcriber
// (Python) write them; the host entry validates them when it reads them.
import { z } from "zod";

export const MEETING_ID_PATTERN = /^mtg_[a-z0-9]{6,32}$/;
export const meetingIdSchema = z.string().regex(MEETING_ID_PATTERN, "Invalid meeting id");

export const PLATFORMS = ["zoom", "mock"] as const;
export const platformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof platformSchema>;

export const DIARIZATION_MODES = ["ui+acoustic", "ui", "acoustic"] as const;
export const diarizationSchema = z.enum(DIARIZATION_MODES);
export type DiarizationMode = z.infer<typeof diarizationSchema>;

export const transcriberConfigSchema = z
  .object({
    /** Base URL of an OpenAI-compatible GigaAM server, or null to rely on <hostData>/gigaam.json. */
    gigaamUrl: z.string().nullable(),
    diarization: diarizationSchema,
    speakerLagMs: z.number().int().min(0).max(5000),
    keepRawAudio: z.boolean(),
    /** CPU threads for VAD/embeddings; 0 = auto. */
    threads: z.number().int().min(0).max(64),
  })
  .strict();
export type TranscriberConfig = z.infer<typeof transcriberConfigSchema>;

export const BOT_MODES = ["meeting", "login"] as const;
export const botModeSchema = z.enum(BOT_MODES);
export type BotMode = z.infer<typeof botModeSchema>;

export const botConfigSchema = z
  .object({
    version: z.literal(1),
    meetingId: meetingIdSchema,
    /** "login": open the Zoom sign-in page in the persistent profile and wait for a human (remote control) instead of joining. */
    mode: botModeSchema,
    platform: platformSchema,
    url: z.string().min(1).max(4096),
    joinUrl: z.string().min(1).max(4096),
    meetingNumber: z.string().nullable(),
    passcode: z.string().nullable(),
    botName: z.string().min(1).max(64),
    maxDurationSec: z.number().int().min(60).max(24 * 3600),
    aloneTimeoutSec: z.number().int().min(10).max(3600),
    waitingTimeoutSec: z.number().int().min(30).max(4 * 3600),
    /** Leave after this long with no audio at all (0 = never). */
    silenceTimeoutSec: z.number().int().min(0).max(4 * 3600),
    screenshotIntervalSec: z.number().int().min(0).max(300),
    chatAnnouncement: z.string().max(1000),
    /** Advanced selector override for speaker detection (DESIGN §6.4); null = adapter defaults. */
    speakerSelectors: z.record(z.string(), z.unknown()).nullable(),
    chromePath: z.string(),
    /**
     * Persistent signed-in Zoom profile (<hostData>/profiles/zoom). mode=login uses it in place;
     * mode=meeting copies it into the meeting's own profile dir when set. null = fresh guest profile.
     */
    zoomProfileDir: z.string().nullable(),
    liveTranscription: z.boolean(),
    transcriber: transcriberConfigSchema,
    createdAt: z.number().int(),
  })
  .strict();
export type BotConfig = z.infer<typeof botConfigSchema>;

export const BOT_PHASES = [
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "in_meeting",
  "leaving",
  "ended",
  "failed",
] as const;
export const botPhaseSchema = z.enum(BOT_PHASES);
export type BotPhase = z.infer<typeof botPhaseSchema>;
export const TERMINAL_BOT_PHASES: ReadonlySet<BotPhase> = new Set(["ended", "failed"]);

export const BOT_ERROR_CODES = [
  "invalid_meeting",
  "wrong_passcode",
  "auth_required",
  "registration_required",
  "bot_blocked",
  "browser_join_disabled",
  "captcha",
  "meeting_ended",
  "meeting_locked",
  "meeting_full",
  "denied",
  "waiting_timeout",
  "browser_crashed",
  "dependency_missing",
  "join_failed",
  "recording_failed",
  "unknown",
] as const;
export const botErrorCodeSchema = z.enum(BOT_ERROR_CODES);
export type BotErrorCode = z.infer<typeof botErrorCodeSchema>;

export const END_REASONS = [
  "stopped",
  "meeting_ended",
  "removed",
  "alone",
  "silence",
  "max_duration",
  "waiting_timeout",
  "error",
] as const;
export const endReasonSchema = z.enum(END_REASONS);
export type EndReason = z.infer<typeof endReasonSchema>;

export const botStateSchema = z.object({
  version: z.literal(1),
  meetingId: meetingIdSchema,
  pid: z.number().int(),
  phase: botPhaseSchema,
  detail: z.string(),
  startedAt: z.number(),
  joinedAt: z.number().nullable(),
  recordingStartedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: endReasonSchema.nullable(),
  error: z.object({ code: botErrorCodeSchema, message: z.string() }).nullable(),
  participants: z.object({ count: z.number().int().nullable(), names: z.array(z.string()) }),
  activeSpeakers: z.array(z.string()),
  audio: z.object({ seconds: z.number(), bytes: z.number() }),
  updatedAt: z.number(),
});
export type BotState = z.infer<typeof botStateSchema>;

export const speakerEventSchema = z.object({
  /** Observation time (epoch ms). */
  t: z.number(),
  speakers: z.array(z.string()),
  /** Which signal decided: "track" (per-participant WebRTC audio), "store" (Zoom Redux state), "tile" (lit video tile), "none" (no signal), "end" (closing line when the bot leaves). */
  src: z.string(),
  /** How late this observation is relative to the recorded audio; the transcriber uses t - lagMs. Absent = transcriber default. */
  lagMs: z.number().optional(),
});
export type SpeakerEvent = z.infer<typeof speakerEventSchema>;

export const rosterSchema = z.object({
  t: z.number(),
  count: z.number().int().nullable(),
  names: z.array(z.string()),
});
export type Roster = z.infer<typeof rosterSchema>;

export const TRANSCRIBER_PHASES = [
  "waiting_audio",
  "live",
  "waiting_asr",
  "finalizing",
  "done",
  "failed",
] as const;
export const transcriberPhaseSchema = z.enum(TRANSCRIBER_PHASES);
export type TranscriberPhase = z.infer<typeof transcriberPhaseSchema>;

export const transcriberStateSchema = z.object({
  version: z.literal(1),
  pid: z.number().int(),
  mode: z.enum(["live", "offline"]),
  phase: transcriberPhaseSchema,
  detail: z.string(),
  processedSec: z.number(),
  audioSec: z.number(),
  segments: z.number().int(),
  checkpoint: z.object({ samples: z.number().int(), nextId: z.number().int() }),
  error: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type TranscriberState = z.infer<typeof transcriberStateSchema>;

export const SPEAKER_SOURCES = ["ui", "acoustic", "mixed", "none"] as const;
export const speakerSourceSchema = z.enum(SPEAKER_SOURCES);
export type SpeakerSource = z.infer<typeof speakerSourceSchema>;

export const segmentSchema = z.object({
  id: z.number().int().min(0),
  start: z.number().min(0),
  end: z.number().min(0),
  speakerKey: z.string().min(1).max(300),
  speaker: z.string().max(300),
  source: speakerSourceSchema,
  text: z.string(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const transcriptSpeakerSchema = z.object({
  key: z.string(),
  label: z.string(),
  source: speakerSourceSchema,
  talkSec: z.number(),
  segments: z.number().int(),
});
export type TranscriptSpeaker = z.infer<typeof transcriptSpeakerSchema>;

export const transcriptSchema = z.object({
  version: z.literal(1),
  meetingId: meetingIdSchema,
  audioSec: z.number(),
  createdAt: z.number(),
  asr: z.object({ engine: z.literal("gigaam"), model: z.string().nullable() }),
  diarization: diarizationSchema,
  speakers: z.array(transcriptSpeakerSchema),
  segments: z.array(segmentSchema),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const CONTROL_ACTIONS = ["click", "dblclick", "type", "key", "scroll", "done"] as const;
/**
 * One remote-control command for a running bot (human in the loop: captcha, sign-in, odd dialogs).
 * The host writes control/<seq>.json; the bot executes in seq order and records the last seq in control/ack.json.
 * x/y are CSS pixels of the 1280x720 viewport, i.e. of screen.jpg.
 */
export const controlCommandSchema = z
  .object({
    seq: z.number().int().min(0),
    t: z.number(),
    action: z.enum(CONTROL_ACTIONS),
    x: z.number().min(0).max(4000).optional(),
    y: z.number().min(0).max(4000).optional(),
    text: z.string().max(2000).optional(),
    /** Playwright key name, e.g. "Enter", "Escape", "Tab", "Backspace". */
    key: z.string().max(40).optional(),
    dy: z.number().min(-5000).max(5000).optional(),
  })
  .strict();
export type ControlCommand = z.infer<typeof controlCommandSchema>;

/** Files the host may serve from a meeting directory through `meeting.readFile`. */
export const READABLE_FILES = [
  "audio.ogg",
  "screen.jpg",
  "transcript.json",
  "transcript.md",
  "transcript.txt",
] as const;
export const readableFileSchema = z.enum(READABLE_FILES);
export type ReadableFile = z.infer<typeof readableFileSchema>;

export const CONTENT_TYPES: Readonly<Record<ReadableFile, string>> = {
  "audio.ogg": "audio/ogg",
  "screen.jpg": "image/jpeg",
  "transcript.json": "application/json; charset=utf-8",
  "transcript.md": "text/markdown; charset=utf-8",
  "transcript.txt": "text/plain; charset=utf-8",
};

/** Speaker labels the transcriber uses (Russian UI). */
export const UNKNOWN_SPEAKER_LABEL = "Неизвестный";
export function acousticSpeakerLabel(n: number): string {
  return `Спикер ${n}`;
}
