// Agent-facing text shared by the CLI (English) and the agent tools
// (bilingual next steps). Meeting links always go through maskMeetingUrl.
import { maskMeetingUrl } from "../shared/meeting-url.js";
import type { MeetingRow } from "./db.js";
import { formatDateTime, humanDuration } from "./format.js";
import { describeStatus, explainError } from "./status.js";

export function isoMinute(epochMs: number | null): string {
  if (epochMs === null) return "-";
  return formatDateTime(epochMs).replace(",", "");
}

export function speakerListEn(row: MeetingRow): string {
  if (row.speakers.length === 0) return "-";
  const total = row.speakers.reduce((sum, s) => sum + s.talkSec, 0);
  return row.speakers
    .map((s) => {
      const label = row.speakerNames[s.key] || s.label;
      const share = total > 0 ? ` ${Math.round((s.talkSec / total) * 100)}%` : "";
      return `${label} [${s.key}]${share}`;
    })
    .join(", ");
}

/** "recording, 12 min, 3 participants" */
export function statusLineEn(row: MeetingRow): string {
  const parts = [`${row.status} (${describeStatus(row.status, "en")})`];
  if (row.durationSec > 0) parts.push(humanDuration(row.durationSec, "en"));
  if (row.participantsCount !== null) parts.push(`${row.participantsCount} participants`);
  if (row.status === "processing" && row.transcriptProgress !== null) {
    parts.push(`transcribed ${Math.round(row.transcriptProgress * 100)}%`);
  }
  return parts.join(", ");
}

export interface NextStep {
  ru: string;
  en: string;
  /** The join did not work out (tool results set isError). */
  failed: boolean;
}

/** What the agent should tell the user right after a join request. */
export function joinOutcome(row: MeetingRow, notifying: boolean): NextStep {
  const bot = row.botName;
  const later = notifying
    ? { ru: " Когда встреча закончится, я пришлю сюда сообщение с транскриптом.", en: " This thread gets a message with the transcript when the meeting ends." }
    : { ru: "", en: "" };
  switch (row.status) {
    case "scheduled":
      return {
        ru: `Бот подключится ${isoMinute(row.scheduledAt)} (по времени сервера).${later.ru}`,
        en: `The bot will join at ${isoMinute(row.scheduledAt)} (server time).${later.en}`,
        failed: false,
      };
    case "recording":
      return {
        ru: `Бот «${bot}» во встрече и записывает.${later.ru}`,
        en: `The bot "${bot}" is in the meeting and recording.${later.en}`,
        failed: false,
      };
    case "waiting_room":
      return {
        ru: `Бот в зале ожидания: попросите организатора впустить «${bot}».${later.ru}`,
        en: `The bot is in the waiting room: ask the host to admit "${bot}".${later.en}`,
        failed: false,
      };
    case "waiting_for_host":
      return {
        ru: `Организатор ещё не начал встречу; бот «${bot}» ждёт и подключится сам.${later.ru}`,
        en: `The host has not started the meeting yet; "${bot}" waits and joins by itself.${later.en}`,
        failed: false,
      };
    case "starting":
    case "joining":
      return {
        ru: `Бот ещё подключается. Проверьте статус чуть позже (meetings_status).${later.ru}`,
        en: `The bot is still joining. Check again shortly (meetings_status / bb meetings show ${row.id}).${later.en}`,
        failed: false,
      };
    case "failed": {
      const ru = row.errorMessage ?? (row.errorCode !== null ? explainError(row.errorCode) : "неизвестная ошибка");
      const en = row.errorCode !== null ? explainError(row.errorCode, "en") : "unknown error";
      return {
        ru: maskMeetingUrl(`Не удалось подключиться: ${ru.replace(/[.\s]+$/, "")}.`),
        en: `Joining failed: ${en}. Details: bb meetings logs ${row.id}`,
        failed: true,
      };
    }
    case "cancelled":
      return { ru: "Запись отменена.", en: "The recording was cancelled.", failed: true };
    case "processing":
    case "done":
      return {
        ru: "Встреча уже закончилась; транскрипт готовится или готов.",
        en: "The meeting is already over; the transcript is being prepared or ready.",
        failed: false,
      };
  }
}

/** Multi-line English description for `bb meetings show` and meetings_status. */
export function describeMeetingEn(row: MeetingRow): string {
  const lines = [
    `Meeting ${row.id}: ${row.title}`,
    `Status:       ${statusLineEn(row)}`,
    `Link:         ${row.source === "import" ? row.url : maskMeetingUrl(row.url)}`,
    `Bot name:     ${row.botName}`,
    `Source:       ${row.source}${row.calendarKey !== null ? " (calendar)" : ""}`,
  ];
  if (row.scheduledAt !== null) lines.push(`Scheduled:    ${isoMinute(row.scheduledAt)}`);
  lines.push(`Created:      ${isoMinute(row.createdAt)}`);
  if (row.joinedAt !== null) lines.push(`Joined:       ${isoMinute(row.joinedAt)}`);
  if (row.endedAt !== null) lines.push(`Ended:        ${isoMinute(row.endedAt)}${row.endReason ? ` (${row.endReason})` : ""}`);
  if (row.durationSec > 0) lines.push(`Duration:     ${humanDuration(row.durationSec, "en")}`);
  if (row.participants.length > 0 || row.participantsCount !== null) {
    const names = row.participants.slice(0, 20).join(", ");
    lines.push(`Participants: ${row.participantsCount ?? row.participants.length}${names ? ` (${names})` : ""}`);
  }
  if (row.activeSpeakers.length > 0) lines.push(`Speaking now: ${row.activeSpeakers.join(", ")}`);
  lines.push(`Speakers:     ${speakerListEn(row)}`);
  lines.push(
    `Transcript:   ${row.transcriptStatus}${row.transcriptFinal ? " (final)" : ""}, ${row.segmentsCount} segments${row.transcriptError ? `; ${row.transcriptError}` : ""}`,
  );
  if (row.errorCode !== null) {
    lines.push(`Error:        ${row.errorCode}: ${explainError(row.errorCode, "en")}`);
    if (row.errorMessage) lines.push(`              ${row.errorMessage}`);
  }
  lines.push(`Summary:      ${row.summaryMd ? "saved" : "none"}`);
  return maskMeetingUrl(lines.join("\n"));
}
