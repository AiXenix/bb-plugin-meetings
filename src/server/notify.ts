// The one message a requesting thread gets when its meeting finishes
// (docs/dev/DESIGN.md §9). Pure text building; the service sends it once.
import { maskMeetingUrl } from "../shared/meeting-url.js";
import type { MeetingRow } from "./db.js";
import { humanDuration } from "./format.js";
import { explainError } from "./status.js";

export function fillPrompt(prompt: string, row: Pick<MeetingRow, "id" | "title">): string {
  return prompt.replaceAll("{id}", row.id).replaceAll("{title}", row.title).trim();
}

function speakerLine(row: MeetingRow): string | null {
  const total = row.speakers.reduce((sum, s) => sum + s.talkSec, 0);
  if (row.speakers.length === 0) return null;
  const parts = row.speakers.slice(0, 12).map((s) => {
    const label = row.speakerNames[s.key] || s.label;
    return total > 0 ? `${label} (${Math.round((s.talkSec / total) * 100)}%)` : label;
  });
  const more = row.speakers.length > 12 ? ` и ещё ${row.speakers.length - 12}` : "";
  return `Спикеры: ${parts.join(", ")}${more}.`;
}

export function notificationText(row: MeetingRow, summaryPrompt: string): string {
  const lines: string[] = [];
  const link = maskMeetingUrl(row.url);
  if (row.status === "done") {
    lines.push(`Встреча «${row.title}» (${row.id}) записана и расшифрована.`);
    const facts = [`Длительность: ${humanDuration(row.durationSec)}.`];
    const speakers = speakerLine(row);
    if (speakers !== null) facts.push(speakers);
    facts.push(`Сегментов: ${row.segmentsCount}.`);
    lines.push(facts.join(" "));
    if (row.errorCode !== null) {
      lines.push(`Запись прервалась раньше времени: ${explainError(row.errorCode)}. Транскрипт содержит то, что успели записать.`);
    }
    if (row.segmentsCount === 0) {
      // Nothing to summarize: don't ask the agent for a summary of silence.
      lines.push("Речь не распознана: транскрипт пуст (в эфире было тихо или бот не слышал звук встречи).");
    } else {
      lines.push(
        `Прочитать транскрипт: инструмент meetings_transcript (id: "${row.id}", постранично) или команда \`bb meetings transcript ${row.id}\`.`,
      );
      const prompt = fillPrompt(summaryPrompt, row);
      if (prompt !== "") lines.push("", prompt);
    }
  } else {
    lines.push(`Не удалось записать встречу «${row.title}» (${row.id}).`);
    const reason = row.errorMessage ?? (row.errorCode !== null ? explainError(row.errorCode) : "неизвестна");
    lines.push(`Причина: ${reason.replace(/[.\s]+$/, "")}.`);
    if (row.segmentsCount > 0) {
      lines.push(
        `Частичный транскрипт (${row.segmentsCount} сегм.) доступен: инструмент meetings_transcript (id: "${row.id}") или \`bb meetings transcript ${row.id}\`.`,
      );
    }
    lines.push(`Подробности: \`bb meetings show ${row.id}\`, журнал: \`bb meetings logs ${row.id}\`. Ссылка: ${link}`);
  }
  // Bot error messages may quote the join URL.
  return maskMeetingUrl(lines.join("\n"));
}
