// Host RPC contract shared by server.ts (caller) and host.ts (implementation).
// The host entry runs on the recording machine and owns the runtime install,
// the detached bot/transcriber processes and the meeting directories
// (docs/dev/DESIGN.md §2–§4). Every call re-reads state from disk.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CONTROL_ACTIONS,
  botConfigSchema,
  botStateSchema,
  meetingIdSchema,
  readableFileSchema,
  rosterSchema,
  segmentSchema,
  transcriberConfigSchema,
  transcriberStateSchema,
  transcriptSchema,
} from "./runtime-files.js";

/** Max bytes per `meeting.readFile` call (base64 output stays under the 8 MiB host RPC cap). */
export const MAX_READ_CHUNK = 4 * 1024 * 1024;
/** Max segments per `meeting.segments` call. */
export const MAX_SEGMENTS_PAGE = 2000;

export const envItemSchema = z
  .object({
    /** chrome | xvfb | pulseaudio | ffmpeg | node | playwright | uv | venv | sherpa-onnx | vad-model | speaker-model | gigaam */
    id: z.string(),
    label: z.string(),
    ok: z.boolean(),
    /** Recording or transcription cannot work without it. */
    required: z.boolean(),
    version: z.string().nullable(),
    detail: z.string(),
    /** Shell command or instruction that fixes it, when `env.setup` cannot. */
    fix: z.string().nullable(),
  })
  .strict();
export type EnvItem = z.infer<typeof envItemSchema>;

export const SETUP_PHASES = ["idle", "running", "done", "failed"] as const;

export const gigaamStatusSchema = z
  .object({
    url: z.string().nullable(),
    ready: z.boolean(),
    detail: z.string(),
  })
  .strict();
export type GigaamStatus = z.infer<typeof gigaamStatusSchema>;

export const envReportSchema = z
  .object({
    /** Everything required to record and transcribe is present. */
    ready: z.boolean(),
    items: z.array(envItemSchema),
    setup: z
      .object({
        phase: z.enum(SETUP_PHASES),
        message: z.string(),
        startedAt: z.number().nullable(),
        finishedAt: z.number().nullable(),
        logTail: z.string(),
      })
      .strict(),
    runtimeHash: z.string(),
    hostDataDir: z.string(),
    /** Passwordless sudo is available, so setup can install system packages. */
    sudo: z.boolean(),
    gigaam: gigaamStatusSchema,
    chromePath: z.string().nullable(),
  })
  .strict();
export type EnvReport = z.infer<typeof envReportSchema>;

export const runtimeSnapshotSchema = z
  .object({
    meetingId: meetingIdSchema,
    /** The meeting directory exists on this host. */
    exists: z.boolean(),
    bot: botStateSchema.nullable(),
    botAlive: z.boolean(),
    transcriber: transcriberStateSchema.nullable(),
    transcriberAlive: z.boolean(),
    roster: rosterSchema.nullable(),
    files: z
      .object({
        audioBytes: z.number().nullable(),
        screenshotMtime: z.number().nullable(),
        transcriptFinal: z.boolean(),
        /** Lines in segments.jsonl (live) or segments in transcript.json (final). */
        segments: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

const meetingRef = z.object({ meetingId: meetingIdSchema }).strict();

export const hostContract = defineRpcContract({
  "env.check": {
    experimental_description:
      "Report which runtime pieces (Chrome, Xvfb, PulseAudio, ffmpeg, playwright, venv, models, GigaAM) are present and the last setup result.",
    input: z.object({ chromePath: z.string(), gigaamUrl: z.string() }).strict(),
    output: envReportSchema,
  },
  "env.setup": {
    experimental_description:
      "Start installing missing runtime pieces in the background (system packages only with passwordless sudo); returns at once.",
    input: z.object({ force: z.boolean(), chromePath: z.string(), gigaamUrl: z.string() }).strict(),
    output: envReportSchema,
  },
  "gigaam.discover": {
    experimental_description:
      "Resolve the GigaAM server URL (configured or discovered from the gigaam plugin), check /health, and persist it to <hostData>/gigaam.json for running transcribers.",
    input: z.object({ configuredUrl: z.string() }).strict(),
    output: gigaamStatusSchema,
  },
  "meeting.start": {
    experimental_description:
      "Create the meeting directory, write config.json and spawn the detached bot runner (and the live transcriber when enabled).",
    input: z.object({ config: botConfigSchema }).strict(),
    output: runtimeSnapshotSchema,
  },
  "meeting.import": {
    experimental_description:
      "Create a meeting directory from an existing audio/video file on this host (converted to audio.ogg) and start an offline transcription.",
    input: z.object({ config: botConfigSchema, sourcePath: z.string().min(1).max(4096) }).strict(),
    output: runtimeSnapshotSchema,
  },
  "meeting.stop": {
    experimental_description: "Ask the bot to leave and finish the recording (stop.request + SIGTERM; SIGKILL after a grace period).",
    input: meetingRef,
    output: runtimeSnapshotSchema,
  },
  "meeting.status": {
    input: z.object({ meetingIds: z.array(meetingIdSchema).max(100) }).strict(),
    output: z.object({ snapshots: z.array(runtimeSnapshotSchema) }).strict(),
  },
  "meeting.segments": {
    experimental_description:
      "Segments after `afterId` from transcript.json when final, else from segments.jsonl.",
    input: z
      .object({
        meetingId: meetingIdSchema,
        afterId: z.number().int().min(-1),
        limit: z.number().int().min(1).max(MAX_SEGMENTS_PAGE),
      })
      .strict(),
    output: z
      .object({
        final: z.boolean(),
        segments: z.array(segmentSchema),
        /** Highest id returned, or the input afterId when none. */
        lastId: z.number().int(),
        total: z.number().int(),
      })
      .strict(),
  },
  "meeting.transcript": {
    input: meetingRef,
    output: z.object({ transcript: transcriptSchema.nullable() }).strict(),
  },
  "meeting.ensureTranscriber": {
    experimental_description:
      "Spawn the transcriber when it is not running and the transcript is not final. mode=offline re-transcribes from audio.ogg from scratch.",
    input: z
      .object({
        meetingId: meetingIdSchema,
        mode: z.enum(["live", "offline"]),
        transcriber: transcriberConfigSchema,
      })
      .strict(),
    output: runtimeSnapshotSchema,
  },
  "meeting.readFile": {
    input: z
      .object({
        meetingId: meetingIdSchema,
        file: readableFileSchema,
        offset: z.number().int().min(0),
        length: z.number().int().min(1).max(MAX_READ_CHUNK),
      })
      .strict(),
    output: z
      .object({
        /** null when the file does not exist. */
        base64: z.string().nullable(),
        totalBytes: z.number().int(),
        mtimeMs: z.number().nullable(),
      })
      .strict(),
  },
  "meeting.filePath": {
    experimental_description: "Absolute path of a meeting file on this host (for agents and the CLI), or null when absent.",
    input: z
      .object({
        meetingId: meetingIdSchema,
        file: z.enum(["dir", "audio.ogg", "screen.jpg", "transcript.json", "transcript.md", "transcript.txt", "bot.log", "transcriber.log"]),
      })
      .strict(),
    output: z.object({ path: z.string().nullable() }).strict(),
  },
  "meeting.logs": {
    input: z.object({ meetingId: meetingIdSchema, lines: z.number().int().min(1).max(1000) }).strict(),
    output: z.object({ text: z.string() }).strict(),
  },
  "meeting.debugDump": {
    experimental_description: "Ask a running bot to dump the current DOM and a screenshot into debug/.",
    input: meetingRef,
    output: z.object({ requested: z.boolean() }).strict(),
  },
  "meeting.control": {
    experimental_description:
      "Queue one remote-control command (click/type/key/scroll/done) for a running bot; also marks a viewer as present.",
    input: z
      .object({
        meetingId: meetingIdSchema,
        action: z.enum(CONTROL_ACTIONS),
        x: z.number().min(0).max(4000).optional(),
        y: z.number().min(0).max(4000).optional(),
        text: z.string().max(2000).optional(),
        key: z.string().max(40).optional(),
        dy: z.number().min(-5000).max(5000).optional(),
      })
      .strict(),
    output: z.object({ queued: z.boolean(), seq: z.number().int() }).strict(),
  },
  "meeting.viewer": {
    experimental_description:
      "Someone is watching the live view: the bot takes a screenshot every second until `untilMs` (writes viewer.json).",
    input: z.object({ meetingId: meetingIdSchema, untilMs: z.number().int() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  "zoom.profile": {
    experimental_description:
      "Inspect or delete the persistent signed-in Zoom profile (<hostData>/profiles/zoom) used when the useZoomAccount setting is on.",
    input: z.object({ action: z.enum(["status", "delete"]) }).strict(),
    output: z
      .object({
        exists: z.boolean(),
        /** Zoom session cookies are present (zm_aid / _zm_ssid / zm_haid on zoom.us). */
        signedIn: z.boolean(),
        path: z.string(),
        updatedAt: z.number().nullable(),
      })
      .strict(),
  },
  "meeting.delete": {
    experimental_description: "Kill the meeting's processes and remove its directory.",
    input: meetingRef,
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  "runtime.list": {
    experimental_description: "Meeting ids that have a directory on this host.",
    input: z.object({}).strict(),
    output: z.object({ meetingIds: z.array(meetingIdSchema) }).strict(),
  },
});
export type HostContract = typeof hostContract;
