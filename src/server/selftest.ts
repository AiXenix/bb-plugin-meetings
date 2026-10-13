// `bb meetings selftest` (docs/dev/DESIGN.md §8.1): the bot records the
// built-in mock meeting, served by this plugin's own HTTP routes on the bb
// loopback URL, through the full pipeline (Chrome, PulseAudio, ffmpeg,
// speaker detection, transcriber), with no Zoom involved.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LIVE_STATUSES, TERMINAL_STATUSES, type MeetingStatus } from "../shared/rpc-contract.js";
import { errorMessage, sleep } from "./errors.js";
import type { MeetingsService } from "./service.js";

const POLL_MS = 1_000;

export interface SelftestResult {
  ok: boolean;
  meetingId: string;
  status: MeetingStatus;
  /** Distinct statuses in the order they were seen. */
  statuses: MeetingStatus[];
  speakers: string[];
  participants: number;
  audioSec: number;
  segments: number;
  error: string | null;
  problems: string[];
  seconds: number;
  /** The meeting was kept for inspection (failures, or --keep). */
  kept: boolean;
}

export function mockMeetingUrl(bb: BbPluginApi): string {
  const base = bb.server.loopbackBaseUrl.replace(/\/+$/, "");
  return `${base}/api/v1/plugins/${bb.pluginId}/http/mock-meeting/index.html?popup=0`;
}

export async function runSelftest(
  bb: BbPluginApi,
  service: MeetingsService,
  options: { timeoutMs: number; signal?: AbortSignal; keep: boolean },
): Promise<SelftestResult> {
  const started = service.now();
  let row = await service.join({ url: mockMeetingUrl(bb), title: "Самопроверка (mock)", source: "cli", notify: false });
  const statuses: MeetingStatus[] = [row.status];
  const speakers = new Set<string>();
  let participants = 0;
  const deadline = started + options.timeoutMs;
  while (!options.signal?.aborted && !TERMINAL_STATUSES.has(row.status) && service.now() < deadline) {
    await sleep(POLL_MS, options.signal);
    try {
      row = await service.refresh(row.id, options.signal);
    } catch (error) {
      bb.log.warn(`Selftest poll failed: ${errorMessage(error)}`);
    }
    if (statuses.at(-1) !== row.status) statuses.push(row.status);
    for (const name of row.activeSpeakers) speakers.add(name);
    participants = Math.max(participants, row.participantsCount ?? 0);
  }
  const timedOut = !TERMINAL_STATUSES.has(row.status);
  if (timedOut && LIVE_STATUSES.has(row.status)) row = await service.stop(row.id).catch(() => row);

  const problems: string[] = [];
  if (!statuses.includes("recording")) problems.push("the bot never got into the mock meeting");
  if (!row.hasAudio) problems.push("no audio was recorded");
  if (speakers.size === 0) problems.push("no active speaker was detected");
  if (row.status !== "done") {
    problems.push(timedOut ? `not finished within ${Math.round(options.timeoutMs / 1000)} s (${row.status})` : `ended as ${row.status}`);
  }
  const kept = options.keep || problems.length > 0;
  if (!kept) await service.delete(row.id).catch(() => undefined);
  return {
    ok: problems.length === 0,
    meetingId: row.id,
    status: row.status,
    statuses,
    speakers: [...speakers],
    participants,
    audioSec: row.durationSec,
    segments: row.segmentsCount,
    error: row.errorMessage,
    problems,
    seconds: Math.round((service.now() - started) / 1000),
    kept,
  };
}
