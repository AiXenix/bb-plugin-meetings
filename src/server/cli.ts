// `bb meetings …` (docs/dev/DESIGN.md §8.1). Output is English for agents,
// every command takes --json, and output stays far below the 1 MiB CLI cap.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { maskMeetingUrl } from "../shared/meeting-url.js";
import { MEETING_STATUSES, type MeetingStatus } from "../shared/rpc-contract.js";
import { AGENT_ACTIONS, parseAgentRequest, runAgentRequest } from "./agent-api.js";
import type { CalendarService } from "./calendar-service.js";
import type { MeetingRow } from "./db.js";
import { MeetingsError, parseStartTime } from "./errors.js";
import {
  TRANSCRIPT_FORMATS,
  clock,
  humanDuration,
  renderTranscript,
  withNames,
  type TranscriptFormat,
} from "./format.js";
import { describeMeetingEn, isoMinute, joinOutcome, statusLineEn } from "./present.js";
import { runSelftest } from "./selftest.js";
import type { MeetingsService } from "./service.js";

/** Leave room under PLUGIN_CLI_OUTPUT_MAX_BYTES (1 MiB) for stderr and JSON escaping. */
const MAX_STDOUT_BYTES = 800_000;
const LIST_FILTERS = ["all", "active", "upcoming", "past"] as const;
const json = { type: "boolean", description: "Print JSON" } as const;
const idPositional = { name: "id", description: "Meeting id (mtg_…)", required: true } as const;

function cliError(error: unknown): never {
  if (error instanceof MeetingsError) {
    throw new PluginCliError(error.en, { code: error.code, ...(error.hint === undefined ? {} : { hint: error.hint }) });
  }
  throw error;
}

/** Run a command body, turning service errors into PluginCliError (English message + hint). */
async function guard(run: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    return cliError(error);
  }
}

function out(stdout: string): PluginCliResult {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

function outJson(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n` };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The meeting summary with passcodes masked (link and error text). */
function agentView(service: MeetingsService, row: MeetingRow) {
  const summary = service.toSummary(row);
  return {
    ...summary,
    url: maskMeetingUrl(row.url),
    errorMessage: summary.errorMessage === null ? null : maskMeetingUrl(summary.errorMessage),
  };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The end of a long text, cut at a line start, under MAX_STDOUT_BYTES. */
function boundTail(text: string): string {
  if (bytes(text) <= MAX_STDOUT_BYTES) return text;
  const tail = Buffer.from(text, "utf8").subarray(-MAX_STDOUT_BYTES).toString("utf8");
  return `[earlier lines cut]\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

export function registerCli(bb: BbPluginApi, service: MeetingsService): void {
  const pageLink = () => {
    const base = bb.server.experimental_appUrl;
    return base ? `${base.replace(/\/+$/, "")}/plugins/meetings/meetings` : "the Meetings page in bb (sidebar: «Встречи»)";
  };

  bb.cli.register(
    defineCli({
      name: "meetings",
      summary: "Record and transcribe Zoom meetings with a notetaker bot",
      description:
        "A bot joins Zoom from a link, records the meeting and transcribes it locally with GigaAM (Russian), split by speaker. Meeting ids look like mtg_….",
      commands: {
        api: cliCommand({
          summary: "One JSON request per call, for agents outside bb (e.g. an OpenClaw bot): list, show, join, stop, cancel, delete, transcript, search, summary, save_summary, rename_speaker, retranscribe, logs, doctor, calendar",
          options: {
            request: {
              type: "string",
              required: true,
              stdin: true,
              description: `JSON object with "action" (${AGENT_ACTIONS.join(" | ")}); --request-stdin reads one JSON line`,
              placeholder: "JSON",
            },
            json,
          },
          run: (input, ctx) => guard(async () => {
            const request = parseAgentRequest(input.options.request);
            const result = await runAgentRequest(service, request, ctx.signal);
            const text = JSON.stringify({ ok: true, action: request.action, ...(result as object) });
            if (bytes(text) > MAX_STDOUT_BYTES) {
              throw new MeetingsError("too_large", "Ответ слишком большой", "The answer is too large", "Ask for a smaller page (maxChars, limit)");
            }
            return out(text);
          }),
        }),

        join: cliCommand({
          summary: "Send the notetaker bot to a Zoom meeting, now or at a given time",
          positionals: [{ name: "url", description: "Zoom invite link (with ?pwd=…) or meeting number", required: true }],
          options: {
            title: { type: "string", description: "Meeting title (default: Zoom <number>)", placeholder: "TEXT" },
            name: { type: "string", description: "Bot display name (default: the botName setting)", placeholder: "NAME" },
            at: { type: "string", description: "Start time: HH:MM (server time) or ISO 8601; default now", placeholder: "TIME" },
            "max-duration": {
              type: "duration",
              defaultUnit: "m",
              min: 5 * 60_000,
              max: 1440 * 60_000,
              description: "Hard stop, e.g. 90m or 2h (default: the maxDurationMinutes setting)",
            },
            "no-notify": { type: "boolean", description: "Do not message the calling thread when the meeting ends" },
            wait: {
              type: "duration",
              defaultUnit: "s",
              min: 0,
              max: 300_000,
              default: 0,
              description: "Wait up to this long for the join outcome (in / waiting room / failed), e.g. 60s",
            },
            json,
          },
          run: (input, ctx) => guard(async () => {
            const now = service.now();
            const scheduledAt = input.options.at === undefined ? null : parseStartTime(input.options.at, now);
            const maxMs = input.options["max-duration"];
            const notify = !input.options["no-notify"];
            let row = await service.join({
              url: input.positionals.url,
              title: input.options.title ?? null,
              botName: input.options.name ?? null,
              scheduledAt,
              maxDurationMinutes: maxMs === undefined ? null : Math.round(maxMs / 60_000),
              source: ctx.threadId ? "agent" : "cli",
              requestedByThreadId: notify ? (ctx.threadId ?? null) : null,
              notify,
            });
            if (input.options.wait > 0) {
              row = await service.waitForJoin(row.id, input.options.wait, { signal: ctx.signal, reportsFailure: true });
            }
            const outcome = joinOutcome(row, await service.notifiesThread(row));
            if (input.options.json) return outJson({ meeting: agentView(service, row), next: outcome.en });
            return {
              exitCode: outcome.failed ? 1 : 0,
              stdout: [
                `Meeting ${row.id} "${row.title}": ${statusLineEn(row)}`,
                `Link: ${maskMeetingUrl(row.url)}`,
                outcome.en,
                `Status: bb meetings show ${row.id}   Transcript: bb meetings transcript ${row.id}   Stop: bb meetings stop ${row.id}`,
                "",
              ].join("\n"),
            };
          }),
        }),

        list: cliCommand({
          summary: "List meetings, newest first",
          options: {
            status: {
              type: "enum",
              values: [...LIST_FILTERS, ...MEETING_STATUSES],
              default: "all",
              description: "all | active | upcoming | past, or one exact status",
            },
            limit: { type: "integer", min: 1, max: 200, default: 20, description: "How many, 1-200" },
            json,
          },
          run: (input) => guard(async () => {
            const filter = input.options.status;
            let rows: MeetingRow[];
            if ((LIST_FILTERS as readonly string[]).includes(filter)) {
              rows = service
                .list(filter as (typeof LIST_FILTERS)[number], input.options.limit, null)
                .meetings.map((m) => service.requireMeeting(m.id));
            } else {
              rows = service.listWithStatus(filter as MeetingStatus, input.options.limit);
            }
            if (input.options.json) return outJson({ meetings: rows.map((row) => agentView(service, row)) });
            if (rows.length === 0) return out("No meetings. Start one with: bb meetings join <zoom link>");
            const lines = [`${pad("ID", 20)} ${pad("STATUS", 17)} ${pad("WHEN", 17)} ${pad("LENGTH", 10)} TITLE`];
            for (const row of rows) {
              const when = row.scheduledAt !== null && row.status === "scheduled" ? row.scheduledAt : (row.startedAt ?? row.createdAt);
              lines.push(
                `${pad(row.id, 20)} ${pad(row.status, 17)} ${pad(isoMinute(when), 17)} ${pad(row.durationSec > 0 ? clock(row.durationSec) : "-", 10)} ${row.title}`,
              );
            }
            return out(lines.join("\n"));
          }),
        }),

        show: cliCommand({
          summary: "Show one meeting: status, participants, speakers, errors",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const row = service.requireMeeting(input.positionals.id);
            if (input.options.json) {
              const detail = await service.toDetail(row);
              return outJson({ meeting: { ...detail, ...agentView(service, row) } });
            }
            return out(
              `${describeMeetingEn(row)}\nNext: bb meetings transcript ${row.id}${row.status === "recording" ? ` | bb meetings stop ${row.id}` : ""}`,
            );
          }),
        }),

        stop: cliCommand({
          summary: "Make the bot leave and finish the recording",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const row = await service.stop(input.positionals.id);
            if (input.options.json) return outJson({ meeting: agentView(service, row) });
            return out(`Meeting ${row.id}: ${statusLineEn(row)}. The transcript is finalized after the bot leaves.`);
          }),
        }),

        cancel: cliCommand({
          summary: "Cancel a scheduled meeting",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const row = service.cancel(input.positionals.id);
            if (input.options.json) return outJson({ meeting: agentView(service, row) });
            return out(`Meeting ${row.id} cancelled.`);
          }),
        }),

        transcript: cliCommand({
          summary: "Print a transcript (paged by segment id)",
          positionals: [idPositional],
          options: {
            format: { type: "enum", values: TRANSCRIPT_FORMATS, default: "md", description: "md | txt | srt | vtt | json" },
            from: { type: "integer", min: 0, max: 100_000_000, default: 0, description: "First segment id to print" },
            limit: { type: "integer", min: 1, max: 5000, default: 1000, description: "Max segments per call, 1-5000" },
            json: { type: "boolean", description: "Same as --format json" },
          },
          run: (input) => guard(async () => {
            const row = service.requireMeeting(input.positionals.id);
            const format: TranscriptFormat = input.options.json ? "json" : input.options.format;
            const from = input.options.from;
            const total = service.segmentCount(row.id);
            let limit = input.options.limit;
            let page = service.transcriptSegments(row.id, from - 1, limit);
            if (total === 0) {
              const message = row.transcriptFinal
                ? `The transcript of ${row.id} is final but empty: no speech was recognized (status: ${statusLineEn(row)}).`
                : `No transcript yet for ${row.id} (status: ${statusLineEn(row)}).`;
              return format === "json"
                ? outJson({ meetingId: row.id, final: row.transcriptFinal, total: 0, segments: [], nextFrom: null })
                : { exitCode: 0, stdout: "", stderr: `${message}\n` };
            }
            const meta = service.formatMeta(row);
            const render = (segments: typeof page): string => {
              if (format === "json") {
                const last = segments.at(-1);
                const hasMore = last !== undefined && service.transcriptSegments(row.id, last.id, 1).length > 0;
                return `${JSON.stringify({
                  meetingId: row.id,
                  title: row.title,
                  final: row.transcriptFinal,
                  total,
                  segments: withNames(segments, row.speakerNames).map((s) => ({
                    id: s.id,
                    start: s.start,
                    end: s.end,
                    speakerKey: s.speakerKey,
                    speaker: s.speaker,
                    text: s.text,
                  })),
                  nextFrom: hasMore && last !== undefined ? last.id + 1 : null,
                })}\n`;
              }
              return renderTranscript(format, meta, segments, row.speakerNames, { header: from === 0 });
            };
            let text = render(page);
            while (bytes(text) > MAX_STDOUT_BYTES && limit > 1) {
              limit = Math.max(1, Math.floor(limit / 2));
              page = page.slice(0, limit);
              text = render(page);
            }
            const last = page.at(-1);
            const more = last !== undefined && service.transcriptSegments(row.id, last.id, 1).length > 0;
            const notes: string[] = [];
            if (page.length === 0) notes.push(`No segments with id >= ${from} (total ${total}).`);
            if (more && last !== undefined) {
              notes.push(
                `Showing segments ${page[0]?.id}-${last.id} of ${total}. Next page: bb meetings transcript ${row.id} --from ${last.id + 1}${format === "md" ? "" : ` --format ${format}`}`,
              );
            }
            if (!row.transcriptFinal) notes.push(`Transcript is not final yet (${row.status}); speakers and text may still change.`);
            return { exitCode: 0, stdout: text, ...(notes.length > 0 ? { stderr: `${notes.join("\n")}\n` } : {}) };
          }),
        }),

        search: cliCommand({
          summary: "Full-text search across all transcripts",
          positionals: [{ name: "query", description: "Words to find (all must match; prefixes match)", required: true, variadic: true }],
          options: { limit: { type: "integer", min: 1, max: 100, default: 20, description: "Max hits, 1-100" }, json },
          run: (input) => guard(async () => {
            const query = input.positionals.query.join(" ").trim();
            const hits = service.search(query, input.options.limit);
            if (input.options.json) {
              return outJson({ hits: hits.map((hit) => ({ ...hit, snippet: hit.snippet.replace(/[\u0002\u0003]/g, "**") })) });
            }
            if (hits.length === 0) return out(`No matches for "${query}".`);
            return out(
              hits
                .map(
                  (hit) =>
                    `${hit.meetingId} ${isoMinute(hit.meetingDate)} "${hit.meetingTitle}" #${hit.segmentId} [${clock(hit.start)}] ${hit.speaker}: ${hit.snippet.replace(/[\u0002\u0003]/g, "**")}`,
                )
                .join("\n"),
            );
          }),
        }),

        "rename-speaker": cliCommand({
          summary: "Give a speaker a real name in one meeting (empty name resets)",
          positionals: [
            idPositional,
            { name: "speaker", description: "Speaker key (spk:1, ui:Name) or current label", required: true },
            { name: "name", description: "New name", required: true, variadic: true },
          ],
          options: { json },
          run: (input) => guard(async () => {
            const name = input.positionals.name.join(" ");
            const row = service.renameSpeaker(input.positionals.id, input.positionals.speaker, name);
            if (input.options.json) return outJson({ meeting: agentView(service, row) });
            return out(`Speakers of ${row.id}: ${row.speakers.map((s) => `${row.speakerNames[s.key] || s.label} [${s.key}]`).join(", ")}`);
          }),
        }),

        summary: cliCommand({
          summary: "Print or save the meeting summary (markdown)",
          positionals: [idPositional],
          options: {
            set: {
              type: "string",
              description: 'Save this markdown as the summary; for a file use --set "$(cat summary.md)"',
              placeholder: "MARKDOWN",
            },
            clear: { type: "boolean", description: "Delete the saved summary" },
            json,
          },
          constraints: [{ kind: "at-most-one", options: ["set", "clear"] }],
          run: (input) => guard(async () => {
            let row = service.requireMeeting(input.positionals.id);
            if (input.options.set !== undefined) row = service.update(row.id, { summaryMd: input.options.set });
            else if (input.options.clear) row = service.update(row.id, { summaryMd: null });
            if (input.options.json) return outJson({ meetingId: row.id, summaryMd: row.summaryMd });
            if (input.options.set !== undefined || input.options.clear) {
              return out(row.summaryMd ? `Summary of ${row.id} saved (${row.summaryMd.length} chars).` : `Summary of ${row.id} cleared.`);
            }
            return row.summaryMd ? out(row.summaryMd) : { exitCode: 0, stdout: "", stderr: `No summary saved for ${row.id}.\n` };
          }),
        }),

        retranscribe: cliCommand({
          summary: "Transcribe the recorded audio again from scratch",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const row = await service.retranscribe(input.positionals.id);
            if (input.options.json) return outJson({ meeting: agentView(service, row) });
            return out(`Re-transcribing ${row.id}. Follow progress: bb meetings show ${row.id}`);
          }),
        }),

        delete: cliCommand({
          summary: "Delete a meeting with its recording and transcript",
          positionals: [idPositional],
          options: { yes: { type: "boolean", description: "Confirm the deletion" }, json },
          run: (input) => guard(async () => {
            if (!input.options.yes) {
              throw new PluginCliError(`Refusing to delete ${input.positionals.id} without --yes`, {
                code: "confirmation_required",
                hint: `Run: bb meetings delete ${input.positionals.id} --yes`,
              });
            }
            const deleted = await service.delete(input.positionals.id);
            if (input.options.json) return outJson({ deleted });
            return out(deleted ? `Deleted ${input.positionals.id}.` : `${input.positionals.id} was already gone.`);
          }),
        }),

        doctor: cliCommand({
          summary: "Check Chrome, Xvfb, PulseAudio, ffmpeg, the transcriber and GigaAM on the recording machine",
          options: { json },
          run: (input) => guard(async () => {
            const report = await service.envReport(true);
            if (input.options.json) return outJson(report);
            const lines = [`Recording environment: ${report.ready ? "ready" : "NOT READY"}`];
            for (const item of report.items) {
              const state = item.ok ? "ok" : item.required ? "MISSING" : "missing";
              lines.push(
                `  [${pad(state, 7)}] ${pad(item.label, 22)} ${item.version ?? ""}${item.detail ? ` ${item.detail}` : ""}${!item.ok && item.fix ? `\n             fix: ${item.fix}` : ""}`,
              );
            }
            lines.push(`GigaAM: ${report.gigaam.ready ? `ready at ${report.gigaam.url}` : `not ready (${report.gigaam.detail})`}`);
            lines.push(`Setup: ${report.setup.phase}${report.setup.message ? ` - ${report.setup.message}` : ""}`);
            lines.push(`Host data: ${report.hostDataDir}`);
            if (!report.ready) lines.push("Install what is missing: bb meetings setup");
            return out(lines.join("\n"));
          }),
        }),

        setup: cliCommand({
          summary: "Install missing runtime pieces on the recording machine (runs in the background)",
          options: { force: { type: "boolean", description: "Reinstall even what looks fine" }, json },
          run: (input) => guard(async () => {
            const report = await service.envSetup(input.options.force);
            if (input.options.json) return outJson(report);
            return out(`Setup ${report.setup.phase}: ${report.setup.message || "started"}\nFollow progress: bb meetings doctor`);
          }),
        }),

        logs: cliCommand({
          summary: "Print the tail of a meeting's bot and transcriber logs",
          positionals: [idPositional],
          options: { lines: { type: "integer", min: 1, max: 1000, default: 100, description: "Lines per log, 1-1000" }, json },
          run: (input) => guard(async () => {
            const text = boundTail(maskMeetingUrl(await service.logs(input.positionals.id, input.options.lines)));
            if (input.options.json) return outJson({ text });
            return out(text || "(no logs yet)");
          }),
        }),

        screenshot: cliCommand({
          summary: "Print the path of the bot's latest screenshot on the recording machine",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const path = await service.filePath(input.positionals.id, "screen.jpg");
            if (input.options.json) return outJson({ path });
            if (path === null) {
              throw new PluginCliError(`No screenshot yet for ${input.positionals.id}`, { code: "not_found" });
            }
            return out(path);
          }),
        }),

        "debug-dump": cliCommand({
          summary: "Ask a running bot to dump the page DOM and a screenshot for troubleshooting",
          positionals: [idPositional],
          options: { json },
          run: (input) => guard(async () => {
            const requested = await service.debugDump(input.positionals.id);
            if (input.options.json) return outJson({ requested });
            const dir = requested ? await service.filePath(input.positionals.id, "dir") : null;
            return out(requested ? `Requested. Files appear in ${dir ?? "the meeting dir"}/debug/` : "The bot is not running.");
          }),
        }),

        import: cliCommand({
          summary: "Transcribe an existing audio/video file as a meeting",
          positionals: [{ name: "path", description: "File on the recording machine (absolute, or relative to the cwd)", required: true }],
          options: { title: { type: "string", description: "Meeting title", placeholder: "TEXT" }, json },
          run: (input, ctx) => guard(async () => {
            let path = input.positionals.path;
            if (!path.startsWith("/") && ctx.cwd) path = `${ctx.cwd.replace(/\/+$/, "")}/${path}`;
            const row = await service.importFile(path, input.options.title ?? null, ctx.threadId ?? null);
            if (input.options.json) return outJson({ meeting: agentView(service, row) });
            return out(`Imported as ${row.id}: ${statusLineEn(row)}. Follow progress: bb meetings show ${row.id}`);
          }),
        }),

        calendar: cliCommand({
          summary: "List upcoming calendar meetings (from the ICS feeds)",
          aliases: ["calendar list"],
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.calendar.status();
            if (input.options.json) return outJson(maskCalendar(status));
            return out(calendarText(status));
          }),
        }),

        "calendar sync": cliCommand({
          summary: "Fetch the ICS feeds now and schedule auto-join meetings",
          options: { json },
          run: (input, ctx) => guard(async () => {
            const status = await service.calendar.sync(ctx.signal);
            if (input.options.json) return outJson(maskCalendar(status));
            return out(calendarText(status));
          }),
        }),

        "calendar skip": cliCommand({
          summary: "Do not join one calendar occurrence",
          positionals: [{ name: "key", description: "Event key from `bb meetings calendar`", required: true }],
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.calendar.setSkip(input.positionals.key, true);
            if (input.options.json) return outJson(maskCalendar(status));
            return out(calendarText(status));
          }),
        }),

        "calendar unskip": cliCommand({
          summary: "Join a previously skipped calendar occurrence again",
          positionals: [{ name: "key", description: "Event key from `bb meetings calendar`", required: true }],
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.calendar.setSkip(input.positionals.key, false);
            if (input.options.json) return outJson(maskCalendar(status));
            return out(calendarText(status));
          }),
        }),

        selftest: cliCommand({
          summary: "Record the built-in mock meeting to check Chrome, PulseAudio, ffmpeg, speaker detection and the transcriber (no Zoom)",
          options: {
            timeout: {
              type: "duration",
              defaultUnit: "s",
              min: 30_000,
              max: 600_000,
              default: 180_000,
              description: "Give up after this long, e.g. 3m",
            },
            keep: { type: "boolean", description: "Keep the test meeting in the list (failed runs are always kept)" },
            json,
          },
          run: (input, ctx) =>
            guard(async () => {
              const result = await runSelftest(bb, service, { timeoutMs: input.options.timeout, signal: ctx.signal, keep: input.options.keep });
              if (input.options.json) return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n` };
              const lines = [
                `Selftest ${result.ok ? "passed" : "FAILED"} in ${result.seconds} s (meeting ${result.meetingId}${result.kept ? "" : ", deleted"})`,
                `Statuses:  ${result.statuses.join(" -> ")}`,
                `Speakers:  ${result.speakers.join(", ") || "-"} (participants seen: ${result.participants})`,
                `Audio:     ${humanDuration(result.audioSec, "en")}, transcript segments: ${result.segments} (the mock plays tones, so 0 is fine)`,
              ];
              if (result.error) lines.push(`Error:     ${result.error}`);
              for (const problem of result.problems) lines.push(`Problem:   ${problem}`);
              if (!result.ok) lines.push(`Logs: bb meetings logs ${result.meetingId}   Environment: bb meetings doctor`);
              return { exitCode: result.ok ? 0 : 1, stdout: `${lines.join("\n")}\n` };
            }),
        }),

        "zoom-login": cliCommand({
          summary: "Start a Zoom sign-in session for the bot (finish it from the Meetings page)",
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.zoom.loginStart();
            if (input.options.json) return outJson(status);
            return out(
              [
                `Sign-in session ${status.session?.id ?? "-"} started: ${status.session?.detail ?? ""}`,
                `Open ${pageLink()} -> Zoom account, sign in through the live view, then press «Готово».`,
                "Then enable joining with the account: bb plugin config meetings set useZoomAccount true",
              ].join("\n"),
            );
          }),
        }),

        "zoom-logout": cliCommand({
          summary: "Sign the bot out of Zoom (deletes the saved profile)",
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.zoom.logout();
            if (input.options.json) return outJson(status);
            return out("The saved Zoom profile was deleted; bots join as guests.");
          }),
        }),

        "zoom-status": cliCommand({
          summary: "Show whether the bot has a signed-in Zoom profile",
          options: { json },
          run: (input) => guard(async () => {
            const status = await service.zoom.status();
            if (input.options.json) return outJson(status);
            return out(
              [
                `Signed in: ${status.profile.signedIn ? "yes" : "no"}${status.profile.updatedAt ? ` (profile updated ${isoMinute(status.profile.updatedAt)})` : ""}`,
                `useZoomAccount: ${status.useZoomAccount ? "on" : "off"}`,
                status.session ? `Sign-in session ${status.session.id}: ${status.session.phase} ${status.session.detail}` : "No sign-in session running.",
              ].join("\n"),
            );
          }),
        }),
      },
    }),
  );
}

function maskCalendar<T extends { upcoming: Array<{ url: string | null }> }>(status: T): T {
  return { ...status, upcoming: status.upcoming.map((event) => ({ ...event, url: event.url === null ? null : maskMeetingUrl(event.url) })) };
}

function calendarText(status: Awaited<ReturnType<CalendarService["status"]>>): string {
  if (!status.configured) {
    return "No calendars configured. Add ICS feed URLs in the plugin settings (calendarIcsUrls), then: bb meetings calendar sync";
  }
  const lines = [
    `Calendars: ${status.feeds}, auto-join ${status.autoJoin ? "on" : "off"}, last sync ${isoMinute(status.lastSyncAt)}${status.lastError ? `, error: ${status.lastError}` : ""}`,
  ];
  if (status.upcoming.length === 0) lines.push("No meetings in the next 24 h.");
  for (const event of status.upcoming) {
    const length = event.endsAt !== null ? ` (${humanDuration((event.endsAt - event.startsAt) / 1000, "en")})` : "";
    const state = event.skipped ? "skipped" : event.meetingId !== null ? `bot: ${event.meetingId}` : event.url === null ? "no Zoom link" : "not scheduled";
    lines.push(`${isoMinute(event.startsAt)}${length} ${event.title} [${state}]\n  key: ${event.key}`);
  }
  return lines.join("\n");
}
