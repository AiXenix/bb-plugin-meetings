// One JSON request in, one JSON answer out: the entry point for agents outside
// bb (e.g. an OpenClaw bot that drives the bb CLI from another machine):
//   echo '{"action":"list"}' | bb meetings api --request-stdin --json
// The bb CLI's stdin option reads one line, so multi-line text (a summary)
// travels JSON-escaped. Agent-visible output never contains meeting passcodes.
import { z } from "zod";
import { maskMeetingUrl } from "../shared/meeting-url.js";
import { ACTIVE_STATUSES } from "../shared/rpc-contract.js";
import type { MeetingRow } from "./db.js";
import { MeetingsError, parseStartTime } from "./errors.js";
import { renderText, withNames } from "./format.js";
import { joinOutcome, statusLineEn } from "./present.js";
import type { MeetingsService } from "./service.js";
import { describeStatus, explainError } from "./status.js";

/** Characters of transcript text per `transcript` call. */
export const API_TRANSCRIPT_CHARS = 60_000;
const DEFAULT_JOIN_WAIT_SEC = 45;

const id = z.string().trim().regex(/^mtg_[a-z0-9]{6,32}$/, "Meeting id looks like mtg_…");

export const agentRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      filter: z.enum(["all", "active", "upcoming", "past"]).default("all"),
      limit: z.number().int().min(1).max(50).default(20),
      /** Case-insensitive substring of the title. */
      query: z.string().trim().max(200).optional(),
    })
    .strict(),
  z.object({ action: z.literal("show"), id }).strict(),
  z
    .object({
      action: z.literal("join"),
      url: z.string().trim().min(1).max(4096),
      title: z.string().trim().max(200).optional(),
      botName: z.string().trim().max(64).optional(),
      /** HH:MM (bb server local time) or ISO 8601 with offset; omit to join now. */
      startAt: z.string().trim().max(64).optional(),
      maxDurationMinutes: z.number().int().min(5).max(1440).optional(),
      waitSeconds: z.number().int().min(0).max(120).default(DEFAULT_JOIN_WAIT_SEC),
    })
    .strict(),
  z.object({ action: z.literal("stop"), id }).strict(),
  z.object({ action: z.literal("cancel"), id }).strict(),
  z
    .object({
      action: z.literal("delete"),
      id,
      /** Deleting removes the recording and transcript for good. */
      confirm: z.literal(true),
      /** The user's own words asking to delete this meeting. */
      userRequest: z.string().trim().min(3).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("transcript"),
      id,
      fromSegment: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(2000).max(API_TRANSCRIPT_CHARS).default(API_TRANSCRIPT_CHARS),
    })
    .strict(),
  z
    .object({
      action: z.literal("search"),
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z.object({ action: z.literal("summary"), id }).strict(),
  z.object({ action: z.literal("save_summary"), id, markdown: z.string().min(1).max(200_000) }).strict(),
  z
    .object({
      action: z.literal("rename_speaker"),
      id,
      /** Speaker key (spk:2, ui:Name) or the current label ("Спикер 2"). */
      speaker: z.string().trim().min(1).max(300),
      /** Empty resets to the transcriber's label. */
      name: z.string().trim().max(100),
    })
    .strict(),
  z.object({ action: z.literal("retranscribe"), id }).strict(),
  z.object({ action: z.literal("logs"), id, lines: z.number().int().min(1).max(500).default(100) }).strict(),
  z.object({ action: z.literal("doctor") }).strict(),
  z.object({ action: z.literal("calendar") }).strict(),
]);
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export const AGENT_ACTIONS = agentRequestSchema.options.map((option) => option.shape.action.value);

function iso(epochMs: number | null): string | null {
  return epochMs === null || epochMs <= 0 ? null : new Date(epochMs).toISOString();
}

/** A compact, passcode-free meeting description for agents. */
export function agentMeeting(service: MeetingsService, row: MeetingRow) {
  const totalTalk = row.speakers.reduce((sum, s) => sum + s.talkSec, 0);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    statusText: describeStatus(row.status),
    statusDetail: row.statusDetail,
    link: maskMeetingUrl(row.url),
    botName: row.botName,
    source: row.source,
    scheduledAt: iso(row.scheduledAt),
    createdAt: iso(row.createdAt),
    joinedAt: iso(row.joinedAt),
    endedAt: iso(row.endedAt),
    durationSec: Math.round(row.durationSec),
    participants: row.participantsCount,
    speakingNow: row.activeSpeakers,
    speakers: row.speakers.map((s) => ({
      key: s.key,
      name: row.speakerNames[s.key] || s.label,
      talkSec: Math.round(s.talkSec),
      share: totalTalk > 0 ? Math.round((s.talkSec / totalTalk) * 100) / 100 : null,
    })),
    transcript: {
      status: row.transcriptStatus,
      final: row.transcriptFinal,
      segments: service.segmentCount(row.id),
      progress: row.transcriptProgress,
      error: row.transcriptError,
    },
    error:
      row.errorCode === null
        ? null
        : {
            code: row.errorCode,
            explanation: explainError(row.errorCode),
            message: row.errorMessage === null ? null : maskMeetingUrl(row.errorMessage),
          },
    endReason: row.endReason,
    hasSummary: row.summaryMd !== null && row.summaryMd.trim() !== "",
  };
}

/** One page of transcript turns "[hh:mm:ss] Speaker: text", cut at a segment boundary. */
export function transcriptChunk(service: MeetingsService, row: MeetingRow, fromSegment: number, maxChars: number) {
  const total = service.segmentCount(row.id);
  const base = { id: row.id, title: row.title, final: row.transcriptFinal, totalSegments: total };
  if (total === 0) {
    return {
      ...base,
      text: "",
      fromSegment,
      toSegment: null,
      nextFromSegment: null,
      done: row.transcriptFinal,
      note: row.transcriptFinal
        ? "The transcript is final but empty: no speech was recognized."
        : `No transcript yet (${statusLineEn(row)}).`,
    };
  }
  const candidates = withNames(service.transcriptSegments(row.id, fromSegment - 1, 5000), row.speakerNames);
  const header = fromSegment === 0;
  const budget = maxChars - (header ? 1500 : 200);
  const included: typeof candidates = [];
  let used = 0;
  for (const segment of candidates) {
    const cost = segment.text.length + segment.speaker.length + 16;
    if (used + cost > budget && included.length > 0) break;
    included.push(segment);
    used += cost;
  }
  const last = included.at(-1);
  if (last === undefined) {
    return { ...base, text: "", fromSegment, toSegment: null, nextFromSegment: null, done: true, note: `No segments with id >= ${fromSegment}.` };
  }
  const more = service.transcriptSegments(row.id, last.id, 1).length > 0;
  return {
    ...base,
    text: maskMeetingUrl(renderText(service.formatMeta(row), included, { header })).slice(0, maxChars),
    fromSegment: included[0]?.id ?? fromSegment,
    toSegment: last.id,
    nextFromSegment: more ? last.id + 1 : null,
    // A live transcript keeps growing: "done" only when final and fully read.
    done: !more && row.transcriptFinal,
    note: row.transcriptFinal ? null : `Live transcript, not final yet (${row.status}); speakers are refined after the meeting.`,
  };
}

function matchesQuery(row: MeetingRow, query: string | undefined): boolean {
  return query === undefined || query === "" || row.title.toLowerCase().includes(query.toLowerCase());
}

/** Run one agent request. Throws MeetingsError (or a validation error) on failure. */
export async function runAgentRequest(service: MeetingsService, request: AgentRequest, signal?: AbortSignal): Promise<unknown> {
  switch (request.action) {
    case "list": {
      // The query filters titles, so look further back than `limit`.
      const rows = service.list(request.filter, request.query ? 200 : request.limit, null).meetings
        .map((summary) => service.requireMeeting(summary.id))
        .filter((row) => matchesQuery(row, request.query))
        .slice(0, request.limit);
      return { meetings: rows.map((row) => agentMeeting(service, row)) };
    }
    case "show": {
      let row = service.requireMeeting(request.id);
      let bot = null;
      if (ACTIVE_STATUSES.has(row.status)) {
        row = await service.refresh(row.id, signal).catch(() => row);
        bot = await service.botState(row.id, signal).catch(() => null);
      }
      // bot.detail is the bot's own English step description (e.g. a captcha that needs a human).
      return { meeting: { ...agentMeeting(service, row), bot } };
    }
    case "join": {
      let row = await service.join({
        url: request.url,
        title: request.title ?? null,
        botName: request.botName ?? null,
        scheduledAt: request.startAt === undefined ? null : parseStartTime(request.startAt, service.now()),
        maxDurationMinutes: request.maxDurationMinutes ?? null,
        source: "agent",
        requestedByThreadId: null,
        notify: false,
      });
      if (row.status !== "scheduled" && request.waitSeconds > 0) {
        row = await service.waitForJoin(row.id, request.waitSeconds * 1000, { signal, reportsFailure: true });
      }
      const outcome = joinOutcome(row, false);
      return { meeting: agentMeeting(service, row), outcome: { ru: outcome.ru, en: outcome.en, failed: outcome.failed } };
    }
    case "stop":
      return { meeting: agentMeeting(service, await service.stop(request.id)) };
    case "cancel":
      return { meeting: agentMeeting(service, service.cancel(request.id)) };
    case "delete": {
      const row = service.requireMeeting(request.id);
      const deleted = await service.delete(row.id);
      return { deleted, id: row.id, title: row.title };
    }
    case "transcript":
      return transcriptChunk(service, service.requireMeeting(request.id), request.fromSegment, request.maxChars);
    case "search":
      return {
        hits: service.search(request.query, request.limit).map((hit) => ({
          meetingId: hit.meetingId,
          meetingTitle: hit.meetingTitle,
          meetingDate: iso(hit.meetingDate),
          segmentId: hit.segmentId,
          startSec: Math.round(hit.start),
          speaker: hit.speaker,
          snippet: hit.snippet.replace(/[\u0002\u0003]/g, "**"),
        })),
      };
    case "summary": {
      const row = service.requireMeeting(request.id);
      return { id: row.id, title: row.title, summaryMd: row.summaryMd };
    }
    case "save_summary": {
      const row = service.update(request.id, { summaryMd: request.markdown });
      return { id: row.id, title: row.title, saved: true, chars: row.summaryMd?.length ?? 0 };
    }
    case "rename_speaker": {
      const row = service.renameSpeaker(request.id, request.speaker, request.name);
      return { meeting: agentMeeting(service, row) };
    }
    case "retranscribe":
      return { meeting: agentMeeting(service, await service.retranscribe(request.id)) };
    case "logs": {
      service.requireMeeting(request.id);
      return { id: request.id, logs: maskMeetingUrl(await service.logs(request.id, request.lines)) };
    }
    case "doctor": {
      const report = await service.envReport(true);
      return {
        ready: report.ready,
        missing: report.items.filter((item) => item.required && !item.ok).map((item) => ({ id: item.id, label: item.label, fix: item.fix })),
        gigaam: { ready: report.gigaam.ready, detail: report.gigaam.detail },
        setup: { phase: report.setup.phase, message: report.setup.message },
      };
    }
    case "calendar": {
      const status = await service.calendar.status();
      return {
        ...status,
        upcoming: status.upcoming.map((event) => ({
          ...event,
          url: event.url === null ? null : maskMeetingUrl(event.url),
          startsAt: iso(event.startsAt),
          endsAt: iso(event.endsAt),
        })),
      };
    }
  }
}

/** Parse the raw stdin line into a request, with a readable error. */
export function parseAgentRequest(raw: string): AgentRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MeetingsError("invalid_request", "Запрос должен быть JSON-объектом в одну строку", "The request must be one line of JSON", `Example: {"action":"list"}`);
  }
  const parsed = agentRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new MeetingsError(
      "invalid_request",
      `Неверный запрос: ${where}${issue?.message ?? "invalid"}`,
      `Invalid request: ${where}${issue?.message ?? "invalid"}`,
      `Actions: ${AGENT_ACTIONS.join(", ")}`,
    );
  }
  return parsed.data;
}
