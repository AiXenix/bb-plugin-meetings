// Agent tools (docs/dev/DESIGN.md §8.2). Results are short and agent-facing:
// passcodes are masked, long transcripts are paged by segment id.
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { maskMeetingUrl } from "../shared/meeting-url.js";
import { ACTIVE_STATUSES } from "../shared/rpc-contract.js";
import type { MeetingRow } from "./db.js";
import { MeetingsError, errorMessage, parseStartTime } from "./errors.js";
import { clock, renderText, withNames } from "./format.js";
import { describeMeetingEn, isoMinute, joinOutcome, speakerListEn, statusLineEn } from "./present.js";
import type { MeetingsService } from "./service.js";

/** Characters of transcript per meetings_transcript call. */
export const TRANSCRIPT_PAGE_CHARS = 60_000;
export const DEFAULT_JOIN_WAIT_SEC = 60;

export const TOOL_INSTRUCTIONS = [
  "Meetings plugin (Zoom notetaker bot, local Russian transcription):",
  "- To record a Zoom meeting call meetings_join with the invite link (keep ?pwd=…). It waits up to 60 s and says whether the bot is in, waits in the waiting room (ask the user to admit the bot) or failed and why.",
  "- When the meeting ends this thread gets a message. Read the transcript with meetings_transcript (paged: pass fromSegment from the previous result) and save summaries with meetings_save_summary.",
  "- meetings_status shows one meeting or the active/recent ones; meetings_stop makes the bot leave; meetings_search finds words in all transcripts; meetings_rename_speaker turns \"Спикер N\" into a real name.",
  "- Never repeat meeting passcodes. More: `bb meetings --help`.",
].join("\n");

function text(value: string, isError = false): PluginAgentToolResult {
  return isError ? { content: [{ type: "text", text: value }], isError: true } : value;
}

function failure(error: unknown): PluginAgentToolResult {
  if (error instanceof MeetingsError) {
    return text(`${error.message}\n${error.en}${error.hint ? ` (${error.hint})` : ""}`, true);
  }
  return text(`Ошибка / Error: ${errorMessage(error)}`, true);
}

async function guard(run: () => Promise<PluginAgentToolResult>): Promise<PluginAgentToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

function shortLine(row: MeetingRow): string {
  const when = row.status === "scheduled" ? row.scheduledAt : (row.startedAt ?? row.createdAt);
  return `${row.id} | ${row.status} | ${isoMinute(when)} | ${row.durationSec > 0 ? clock(row.durationSec) : "-"} | ${row.title}`;
}

/** One page of transcript text, cut at a segment boundary under `maxChars`. */
export function transcriptPage(service: MeetingsService, row: MeetingRow, fromSegment: number, maxChars: number): string {
  const total = service.segmentCount(row.id);
  if (total === 0) {
    return row.transcriptFinal
      ? `The transcript of ${row.id} is final but empty: no speech was recognized (${statusLineEn(row)}). Транскрипт пуст — речь не распознана.`
      : `No transcript yet for ${row.id} (${statusLineEn(row)}). Транскрипта пока нет.`;
  }
  const candidates = withNames(service.transcriptSegments(row.id, fromSegment - 1, 5000), row.speakerNames);
  const header = fromSegment === 0;
  const budget = maxChars - (header ? 1500 : 300);
  const included: typeof candidates = [];
  let used = 0;
  for (const segment of candidates) {
    const cost = segment.text.length + segment.speaker.length + 16;
    if (used + cost > budget && included.length > 0) break;
    included.push(segment);
    used += cost;
  }
  const last = included.at(-1);
  if (last === undefined) return `No segments with id >= ${fromSegment} (total ${total}).`;
  const more = service.transcriptSegments(row.id, last.id, 1).length > 0;
  const body = renderText(service.formatMeta(row), included, { header }).slice(0, maxChars);
  const lines = [
    `[${row.id} "${row.title}", segments ${included[0]?.id}-${last.id} of ${total}, ${row.transcriptFinal ? "final" : `not final yet (${row.status})`}]`,
    body.trimEnd(),
  ];
  lines.push(
    more
      ? `[More: call meetings_transcript with id "${row.id}" and fromSegment ${last.id + 1}]`
      : "[End of transcript]",
  );
  return lines.join("\n");
}

export function registerTools(bb: BbPluginApi, service: MeetingsService): void {
  bb.agents.registerTool({
    name: "meetings_join",
    description:
      "Send the notetaker bot to a Zoom meeting to record and transcribe it (now or at a time). Waits for the join outcome and says what to tell the user. This thread is notified when the meeting ends.",
    instructions: TOOL_INSTRUCTIONS,
    presentation: { label: { pending: "Отправляю бота на встречу", completed: "Бот отправлен на встречу" }, icon: { glyph: "Mic" } },
    parameters: z.object({
      url: z.string().min(1).max(4096).describe("Zoom invite link exactly as given (keep ?pwd=…), or a meeting number"),
      title: z.string().max(200).optional().describe("Meeting title; default \"Zoom <number>\""),
      botName: z.string().max(64).optional().describe("Name shown in the meeting; default from settings (Notetaker)"),
      startAt: z
        .string()
        .max(64)
        .optional()
        .describe("When to join: HH:MM (server local time) or ISO 8601 with offset. Omit to join now"),
      maxDurationMinutes: z.number().int().min(5).max(1440).optional().describe("Hard stop after this many minutes"),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe(`How long to wait for the outcome (in / waiting room / failed). Default ${DEFAULT_JOIN_WAIT_SEC}`),
      notify: z.boolean().optional().describe("Message this thread when the meeting ends. Default true"),
    }),
    execute: (params, ctx) =>
      guard(async () => {
        const notify = params.notify ?? true;
        const scheduledAt = params.startAt === undefined ? null : parseStartTime(params.startAt, service.now());
        let row = await service.join({
          url: params.url,
          title: params.title ?? null,
          botName: params.botName ?? null,
          scheduledAt,
          maxDurationMinutes: params.maxDurationMinutes ?? null,
          source: "agent",
          requestedByThreadId: notify ? ctx.threadId : null,
          notify,
        });
        const waitSec = Math.min(300, Math.max(0, params.waitSeconds ?? DEFAULT_JOIN_WAIT_SEC));
        if (row.status !== "scheduled" && waitSec > 0) {
          row = await service.waitForJoin(row.id, waitSec * 1000, { signal: ctx.signal, reportsFailure: true });
        }
        const outcome = joinOutcome(row, await service.notifiesThread(row));
        return text(
          [
            `Встреча ${row.id} «${row.title}»: ${outcome.ru}`,
            `Meeting ${row.id} "${row.title}": ${outcome.en}`,
            `Status: ${statusLineEn(row)}. Link: ${maskMeetingUrl(row.url)}`,
          ].join("\n"),
          outcome.failed,
        );
      }),
  });

  bb.agents.registerTool({
    name: "meetings_status",
    description:
      "Status of one meeting (by id) or, without id, the active, upcoming and recent meetings: phase, participants, speakers, errors.",
    presentation: { label: { pending: "Проверяю встречи", completed: "Статус встреч" }, icon: { glyph: "Info" }, suppress: true },
    parameters: z.object({
      id: z.string().max(64).optional().describe("Meeting id (mtg_…); omit for an overview"),
    }),
    execute: (params) =>
      guard(async () => {
        if (params.id !== undefined && params.id.trim() !== "") {
          let row = service.requireMeeting(params.id.trim());
          if (ACTIVE_STATUSES.has(row.status)) row = await service.refresh(row.id).catch(() => row);
          return text(describeMeetingEn(row));
        }
        const active = service.list("active", 20, null).meetings;
        const upcoming = service.list("upcoming", 10, null).meetings;
        const recent = service.list("past", 5, null).meetings;
        const section = (title: string, ids: string[]) =>
          ids.length === 0 ? `${title}: none` : `${title}:\n${ids.map((id) => `  ${shortLine(service.requireMeeting(id))}`).join("\n")}`;
        return text(
          [
            section("Active", active.map((m) => m.id)),
            section("Upcoming", upcoming.map((m) => m.id)),
            section("Recent", recent.map((m) => m.id)),
          ].join("\n"),
        );
      }),
  });

  bb.agents.registerTool({
    name: "meetings_stop",
    description: "Make the bot leave a meeting now; the recording is then transcribed and this thread is notified.",
    presentation: { label: { pending: "Останавливаю запись", completed: "Запись остановлена" }, icon: { glyph: "Square" } },
    parameters: z.object({ id: z.string().min(1).max(64).describe("Meeting id (mtg_…)") }),
    execute: (params) =>
      guard(async () => {
        const row = await service.stop(params.id.trim());
        return text(
          `Бот выходит из встречи ${row.id}; транскрипт будет готов после обработки.\nThe bot is leaving ${row.id}: ${statusLineEn(row)}.`,
        );
      }),
  });

  bb.agents.registerTool({
    name: "meetings_transcript",
    description:
      "Read a meeting transcript as \"[hh:mm:ss] Speaker: text\" turns, paged by segment id (about 60k characters per call). Works during the meeting too (live, not final).",
    presentation: { label: { pending: "Читаю транскрипт", completed: "Транскрипт прочитан" }, icon: { glyph: "FileText" }, suppress: true },
    parameters: z.object({
      id: z.string().min(1).max(64).describe("Meeting id (mtg_…)"),
      fromSegment: z.number().int().min(0).optional().describe("First segment id; use the value from the previous page's [More: …] line. Default 0"),
      maxChars: z.number().int().min(2000).max(TRANSCRIPT_PAGE_CHARS).optional().describe(`Page size in characters, default ${TRANSCRIPT_PAGE_CHARS}`),
    }),
    execute: (params) =>
      guard(async () => {
        const row = service.requireMeeting(params.id.trim());
        return text(transcriptPage(service, row, params.fromSegment ?? 0, params.maxChars ?? TRANSCRIPT_PAGE_CHARS));
      }),
  });

  bb.agents.registerTool({
    name: "meetings_search",
    description: "Full-text search over all meeting transcripts (all words must match, word prefixes match).",
    presentation: { label: { pending: "Ищу в транскриптах", completed: "Поиск по встречам" }, icon: { glyph: "Search" }, suppress: true },
    parameters: z.object({
      query: z.string().min(1).max(200).describe("Words to find"),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits, default 20"),
    }),
    execute: (params) =>
      guard(async () => {
        const hits = service.search(params.query, params.limit ?? 20);
        if (hits.length === 0) return text(`Ничего не найдено / No matches for "${params.query}".`);
        return text(
          hits
            .map(
              (hit) =>
                `${hit.meetingId} "${hit.meetingTitle}" ${isoMinute(hit.meetingDate)} segment ${hit.segmentId} [${clock(hit.start)}] ${hit.speaker}: ${hit.snippet.replace(/[\u0002\u0003]/g, "**")}`,
            )
            .join("\n"),
        );
      }),
  });

  bb.agents.registerTool({
    name: "meetings_save_summary",
    description: "Save (replace) the markdown summary of a meeting; it is shown on the Meetings page and in downloads.",
    presentation: { label: { pending: "Сохраняю резюме встречи", completed: "Резюме встречи сохранено" }, icon: { glyph: "Edit" } },
    parameters: z.object({
      id: z.string().min(1).max(64).describe("Meeting id (mtg_…)"),
      markdown: z.string().min(1).max(200_000).describe("The summary in Markdown"),
    }),
    execute: (params) =>
      guard(async () => {
        const row = service.update(params.id.trim(), { summaryMd: params.markdown });
        return text(`Резюме сохранено для ${row.id} «${row.title}».\nSummary saved for ${row.id}.`);
      }),
  });

  bb.agents.registerTool({
    name: "meetings_rename_speaker",
    description:
      "Give a speaker a real name in one meeting (e.g. \"Спикер 2\" → \"Анна\"). Pass the speaker key (spk:2, ui:Name) or its current label; an empty name resets it.",
    presentation: { label: { pending: "Переименовываю спикера", completed: "Спикер переименован" }, icon: { glyph: "UserRound" } },
    parameters: z.object({
      id: z.string().min(1).max(64).describe("Meeting id (mtg_…)"),
      speaker: z.string().min(1).max(300).describe("Speaker key or current label"),
      name: z.string().max(100).describe("New name; empty resets to the transcriber's label"),
    }),
    execute: (params) =>
      guard(async () => {
        const row = service.renameSpeaker(params.id.trim(), params.speaker, params.name);
        return text(`Спикеры / Speakers of ${row.id}: ${speakerListEn(row)}`);
      }),
  });
}
