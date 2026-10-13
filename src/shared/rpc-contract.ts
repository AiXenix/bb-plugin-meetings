// Frontend data plane: server.ts registers these handlers, app.tsx imports
// only the type. Realtime channels are listed at the bottom.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { envReportSchema } from "./contract.js";
import {
  CONTROL_ACTIONS,
  botErrorCodeSchema,
  endReasonSchema,
  meetingIdSchema,
  platformSchema,
  speakerSourceSchema,
} from "./runtime-files.js";

export const MEETING_STATUSES = [
  "scheduled",
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "recording",
  "processing",
  "done",
  "failed",
  "cancelled",
] as const;
export const meetingStatusSchema = z.enum(MEETING_STATUSES);
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

/** Statuses in which a bot or transcriber may still be working. */
export const ACTIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set([
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "recording",
  "processing",
]);
/** Statuses in which a bot is (or is about to be) in the meeting. */
export const LIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set([
  "starting",
  "joining",
  "waiting_for_host",
  "waiting_room",
  "recording",
]);
export const TERMINAL_STATUSES: ReadonlySet<MeetingStatus> = new Set(["done", "failed", "cancelled"]);

export const MEETING_SOURCES = ["agent", "cli", "ui", "calendar", "import"] as const;
export const meetingSourceSchema = z.enum(MEETING_SOURCES);
export type MeetingSource = z.infer<typeof meetingSourceSchema>;

export const TRANSCRIPT_STATUSES = ["none", "live", "finalizing", "done", "failed"] as const;
export const transcriptStatusSchema = z.enum(TRANSCRIPT_STATUSES);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

export const speakerViewSchema = z
  .object({
    key: z.string(),
    /** Label after the user's renames. */
    label: z.string(),
    /** Label the transcriber produced. */
    originalLabel: z.string(),
    source: speakerSourceSchema,
    talkSec: z.number(),
    segments: z.number().int(),
  })
  .strict();
export type SpeakerView = z.infer<typeof speakerViewSchema>;

export const meetingSummarySchema = z
  .object({
    id: meetingIdSchema,
    title: z.string(),
    url: z.string(),
    platform: platformSchema,
    meetingNumber: z.string().nullable(),
    botName: z.string(),
    source: meetingSourceSchema,
    status: meetingStatusSchema,
    statusDetail: z.string().nullable(),
    errorCode: botErrorCodeSchema.nullable(),
    errorMessage: z.string().nullable(),
    endReason: endReasonSchema.nullable(),
    scheduledAt: z.number().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    joinedAt: z.number().nullable(),
    recordingStartedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    /** Recorded audio length in seconds (0 before recording). */
    durationSec: z.number(),
    transcriptStatus: transcriptStatusSchema,
    /** 0..1 while finalizing/processing, null otherwise. */
    transcriptProgress: z.number().nullable(),
    transcriptError: z.string().nullable(),
    participantsCount: z.number().int().nullable(),
    activeSpeakers: z.array(z.string()),
    speakers: z.array(speakerViewSchema),
    segmentsCount: z.number().int(),
    hasAudio: z.boolean(),
    /** Changes whenever a new screenshot is available; null = none. */
    screenshotVersion: z.number().nullable(),
    hasSummary: z.boolean(),
    requestedByThreadId: z.string().nullable(),
  })
  .strict();
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

export const meetingDetailSchema = meetingSummarySchema
  .extend({
    participants: z.array(z.string()),
    summaryMd: z.string().nullable(),
    speakerNames: z.record(z.string(), z.string()),
    maxDurationMinutes: z.number(),
    calendarEventKey: z.string().nullable(),
  })
  .strict();
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

export const segmentViewSchema = z
  .object({
    id: z.number().int(),
    start: z.number(),
    end: z.number(),
    speakerKey: z.string(),
    /** Display label after renames. */
    speaker: z.string(),
    source: speakerSourceSchema,
    text: z.string(),
  })
  .strict();
export type SegmentView = z.infer<typeof segmentViewSchema>;

/** FTS snippet markers: text between them matched the query. */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

export const searchHitSchema = z
  .object({
    meetingId: meetingIdSchema,
    meetingTitle: z.string(),
    meetingDate: z.number(),
    segmentId: z.number().int(),
    start: z.number(),
    speaker: z.string(),
    snippet: z.string(),
  })
  .strict();
export type SearchHit = z.infer<typeof searchHitSchema>;

export const calendarEventViewSchema = z
  .object({
    /** uid + occurrence start; stable id for skip toggles. */
    key: z.string(),
    title: z.string(),
    startsAt: z.number(),
    endsAt: z.number().nullable(),
    url: z.string().nullable(),
    skipped: z.boolean(),
    meetingId: meetingIdSchema.nullable(),
  })
  .strict();
export type CalendarEventView = z.infer<typeof calendarEventViewSchema>;

export const calendarStatusSchema = z
  .object({
    configured: z.boolean(),
    autoJoin: z.boolean(),
    feeds: z.number().int(),
    lastSyncAt: z.number().nullable(),
    lastError: z.string().nullable(),
    upcoming: z.array(calendarEventViewSchema),
  })
  .strict();
export type CalendarStatus = z.infer<typeof calendarStatusSchema>;

export const zoomStatusSchema = z
  .object({
    /** The useZoomAccount setting: bots join with the signed-in profile. */
    useZoomAccount: z.boolean(),
    profile: z
      .object({ exists: z.boolean(), signedIn: z.boolean(), updatedAt: z.number().nullable() })
      .strict(),
    /** The running sign-in session, if any (drive it with meetings.liveView / meetings.control). */
    session: z
      .object({
        id: meetingIdSchema,
        phase: z.string(),
        detail: z.string(),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ZoomStatus = z.infer<typeof zoomStatusSchema>;

export const liveViewSchema = z
  .object({
    /** Changes when a newer screenshot exists; null = none yet. Use it as a cache-buster for /screenshot. */
    screenshotVersion: z.number().nullable(),
    phase: z.string().nullable(),
    detail: z.string().nullable(),
    /** The bot process is running and accepts control commands. */
    controllable: z.boolean(),
  })
  .strict();
export type LiveView = z.infer<typeof liveViewSchema>;

const idInput = z.object({ id: meetingIdSchema }).strict();
const meetingOutput = z.object({ meeting: meetingSummarySchema }).strict();

export const rpcContract = defineRpcContract({
  "meetings.list": {
    input: z
      .object({
        filter: z.enum(["all", "active", "upcoming", "past"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
        /** createdAt cursor from the previous page. */
        before: z.number().nullable().default(null),
      })
      .strict(),
    output: z
      .object({ meetings: z.array(meetingSummarySchema), nextBefore: z.number().nullable() })
      .strict(),
  },
  "meetings.get": {
    input: idInput,
    output: z.object({ meeting: meetingDetailSchema }).strict(),
  },
  "meetings.segments": {
    input: z
      .object({
        id: meetingIdSchema,
        afterId: z.number().int().min(-1).default(-1),
        limit: z.number().int().min(1).max(5000).default(2000),
      })
      .strict(),
    output: z
      .object({
        segments: z.array(segmentViewSchema),
        final: z.boolean(),
        lastId: z.number().int(),
        total: z.number().int(),
      })
      .strict(),
  },
  "meetings.join": {
    input: z
      .object({
        url: z.string().trim().min(1).max(4096),
        title: z.string().trim().max(200).nullable().default(null),
        botName: z.string().trim().max(64).nullable().default(null),
        /** Epoch ms; null = now. */
        scheduledAt: z.number().nullable().default(null),
        maxDurationMinutes: z.number().int().min(5).max(1440).nullable().default(null),
      })
      .strict(),
    output: meetingOutput,
  },
  "meetings.stop": { input: idInput, output: meetingOutput },
  "meetings.cancel": { input: idInput, output: meetingOutput },
  "meetings.retranscribe": { input: idInput, output: meetingOutput },
  "meetings.delete": { input: idInput, output: z.object({ deleted: z.boolean() }).strict() },
  "meetings.update": {
    input: z
      .object({
        id: meetingIdSchema,
        title: z.string().trim().min(1).max(200).optional(),
        /** null clears the summary. */
        summaryMd: z.string().max(200_000).nullable().optional(),
      })
      .strict(),
    output: meetingOutput,
  },
  "meetings.renameSpeaker": {
    input: z
      .object({
        id: meetingIdSchema,
        speakerKey: z.string().min(1).max(300),
        /** Empty string resets to the transcriber's label. */
        name: z.string().trim().max(100),
      })
      .strict(),
    output: meetingOutput,
  },
  "meetings.search": {
    input: z
      .object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict(),
    output: z.object({ hits: z.array(searchHitSchema) }).strict(),
  },
  "meetings.logs": {
    input: z.object({ id: meetingIdSchema, lines: z.number().int().min(1).max(1000).default(200) }).strict(),
    output: z.object({ text: z.string() }).strict(),
  },
  "meetings.debugDump": { input: idInput, output: z.object({ requested: z.boolean() }).strict() },
  "meetings.liveView": {
    experimental_description:
      "Poll while a live view is open: marks a viewer for ~30 s (the bot then screenshots every second) and returns the screenshot version. Accepts meeting ids and the active Zoom sign-in session id.",
    input: idInput,
    output: liveViewSchema,
  },
  "meetings.control": {
    input: z
      .object({
        id: meetingIdSchema,
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
  "zoom.status": { input: z.null(), output: zoomStatusSchema },
  "zoom.loginStart": { input: z.null(), output: zoomStatusSchema },
  "zoom.loginFinish": { input: z.null(), output: zoomStatusSchema },
  "zoom.logout": { input: z.null(), output: zoomStatusSchema },
  "env.status": {
    input: z.null(),
    output: z
      .object({
        env: envReportSchema.nullable(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  "env.setup": {
    input: z.object({ force: z.boolean().default(false) }).strict(),
    output: z.object({ env: envReportSchema }).strict(),
  },
  "calendar.status": { input: z.null(), output: calendarStatusSchema },
  "calendar.sync": { input: z.null(), output: calendarStatusSchema },
  "calendar.setSkip": {
    input: z.object({ key: z.string().min(1).max(600), skip: z.boolean() }).strict(),
    output: calendarStatusSchema,
  },
});
export type RpcContract = typeof rpcContract;

/** Realtime channels published by the server. */
export const CHANNEL_MEETING_CHANGED = "meetings.changed"; // payload { id }
export const CHANNEL_MEETING_SEGMENTS = "meetings.segments"; // payload { id, lastId }
export const CHANNEL_ENV_CHANGED = "meetings.env"; // payload {}
export const CHANNEL_CALENDAR_CHANGED = "meetings.calendar"; // payload {}
export const CHANNEL_ZOOM_CHANGED = "meetings.zoom"; // payload {}
