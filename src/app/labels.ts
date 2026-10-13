// Russian texts for statuses, error codes, end reasons and bot phases.
import type { MeetingStatus, MeetingSummary, TranscriptStatus } from "../shared/rpc-contract";
import type { BotErrorCode, EndReason } from "../shared/runtime-files";
import { formatPercent } from "./format";

export const STATUS_TEXT: Readonly<Record<MeetingStatus, string>> = {
  scheduled: "Запланирована",
  starting: "Запуск бота",
  joining: "Подключение",
  waiting_for_host: "Ждёт организатора",
  waiting_room: "В зале ожидания",
  recording: "Идёт запись",
  processing: "Расшифровка",
  done: "Готово",
  failed: "Ошибка",
  cancelled: "Отменена",
};

/** Chip text; processing shows its progress ("Расшифровка 45 %"). */
export function statusText(meeting: Pick<MeetingSummary, "status" | "transcriptProgress">): string {
  if (meeting.status === "processing" && meeting.transcriptProgress !== null) {
    return `${STATUS_TEXT.processing} ${formatPercent(meeting.transcriptProgress)}`;
  }
  return STATUS_TEXT[meeting.status];
}

export type StatusTone = "live" | "progress" | "attention" | "success" | "danger" | "neutral";

export function statusTone(status: MeetingStatus): StatusTone {
  switch (status) {
    case "recording":
      return "live";
    case "starting":
    case "joining":
    case "processing":
      return "progress";
    case "waiting_for_host":
    case "waiting_room":
      return "attention";
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "scheduled":
    case "cancelled":
      return "neutral";
  }
}

/** What went wrong, per bot error code, in words the user can act on. */
export const ERROR_TEXT: Readonly<Record<BotErrorCode, string>> = {
  invalid_meeting: "Неверная ссылка или встреча ещё не началась",
  wrong_passcode: "Неверный код доступа — проверьте пароль в ссылке (pwd=…)",
  auth_required: "Встреча только для авторизованных пользователей Zoom",
  registration_required: "Встреча требует регистрации — зарегистрируйтесь и дайте боту персональную ссылку участника",
  bot_blocked: "Zoom не пустил бота как автоматического участника — войдите в аккаунт Zoom (кнопка ниже)",
  browser_join_disabled: "Организатор запретил подключение из браузера",
  captcha: "Нужно пройти капчу — откройте живой просмотр",
  meeting_ended: "Встреча уже закончилась",
  meeting_locked: "Организатор заблокировал встречу для новых участников",
  meeting_full: "Встреча переполнена — достигнут лимит участников",
  denied: "Организатор отклонил вход бота",
  waiting_timeout: "Организатор не впустил бота вовремя",
  browser_crashed: "Браузер бота аварийно завершился",
  dependency_missing: "Не хватает компонентов — нажмите «Установить компоненты» на странице встреч",
  recording_failed: "Не удалось записать звук встречи",
  join_failed: "Не удалось подключиться к встрече",
  unknown: "Неизвестная ошибка",
};

/** Error codes that a signed-in Zoom account can fix. */
export const ZOOM_LOGIN_ERRORS: ReadonlySet<BotErrorCode> = new Set<BotErrorCode>(["bot_blocked", "auth_required"]);

export function errorText(code: BotErrorCode | null, message: string | null): string | null {
  if (code !== null) return ERROR_TEXT[code] ?? ERROR_TEXT.unknown;
  return message;
}

export const END_REASON_TEXT: Readonly<Record<EndReason, string>> = {
  stopped: "Запись остановлена вручную",
  meeting_ended: "Встреча завершилась",
  removed: "Бота удалили из встречи",
  alone: "Бот остался один и вышел",
  silence: "Долго не было звука — бот вышел",
  max_duration: "Достигнута максимальная длительность записи",
  waiting_timeout: "Бота так и не впустили",
  error: "Запись прервана из-за ошибки",
};

export const TRANSCRIPT_STATUS_TEXT: Readonly<Record<TranscriptStatus, string>> = {
  none: "Расшифровки нет",
  live: "Расшифровка идёт по ходу встречи",
  finalizing: "Уточняем спикеров и собираем итоговую расшифровку",
  done: "Расшифровка готова",
  failed: "Расшифровка не удалась",
};

/** Bot phases from state.json (BOT_PHASES in src/shared/runtime-files.ts). */
const PHASE_TEXT: Readonly<Record<string, string>> = {
  starting: "Запуск браузера",
  joining: "Подключение к встрече",
  waiting_for_host: "Ждёт, пока организатор начнёт встречу",
  waiting_room: "В зале ожидания",
  in_meeting: "Во встрече",
  leaving: "Выходит из встречи",
  ended: "Завершено",
  failed: "Ошибка",
};

/** The same phases in a Zoom sign-in session (a "login" bot run on zoom.us/signin). */
const LOGIN_PHASE_TEXT: Readonly<Record<string, string>> = {
  starting: "Запуск браузера",
  joining: "Ждём входа в Zoom",
  leaving: "Сохраняем профиль Zoom",
  ended: "Сеанс входа завершён",
  failed: "Сеанс входа не удался",
};

export function phaseText(phase: string | null): string | null {
  if (phase === null || phase === "") return null;
  return PHASE_TEXT[phase] ?? phase;
}

export function loginPhaseText(phase: string | null): string | null {
  if (phase === null || phase === "") return null;
  return LOGIN_PHASE_TEXT[phase] ?? phaseText(phase);
}

/** The bot's own state details are English: the useful ones are translated here. */
const BOT_DETAIL_TEXT: ReadonlyArray<readonly [RegExp, string | ((match: RegExpExecArray) => string)]> = [
  [/^Sign in to Zoom in the live view/i, "Войдите в Zoom через снимок экрана ниже и нажмите «Готово»"],
  [/^Signed in to Zoom; saving/i, "Вход выполнен — сохраняем профиль"],
  [/^Signed in to Zoom/i, "Вход в Zoom выполнен"],
  [/^Sign-in session timed out/i, "Время сеанса входа истекло"],
  [/without a Zoom sign-in/i, "Сеанс закрыт, вход в Zoom не выполнен"],
  [/captcha/i, "Zoom показывает капчу — пройдите её через «Управление»"],
  [/computer audio is not joined/i, "Звук компьютера в Zoom не подключён — подключаем снова"],
  [/^In the waiting room: ask the host to admit "(.*)"/i, (match) => `Попросите организатора впустить «${match[1]}»`],
];

/**
 * A bot (or sign-in session) detail for the Russian UI: known English details translated, Russian ones
 * (written by the server) as is; other English details are left out (the phase says enough, the logs say more).
 */
export function botDetailText(detail: string | null): string | null {
  const text = detail?.trim() ?? "";
  if (text === "") return null;
  for (const [pattern, russian] of BOT_DETAIL_TEXT) {
    const match = pattern.exec(text);
    if (match !== null) return typeof russian === "string" ? russian : russian(match);
  }
  return /[а-яё]/i.test(text) ? text : null;
}

/** "Говорит" for one speaker, "Говорят" for several. */
export function speakingLabel(count: number): string {
  return count > 1 ? "Говорят" : "Говорит";
}

/** A one-line explanation of what a live bot is doing right now. */
export function liveHint(meeting: Pick<MeetingSummary, "status" | "botName">): string | null {
  switch (meeting.status) {
    case "starting":
      return "Запускаем браузер бота…";
    case "joining":
      return "Бот подключается к встрече…";
    case "waiting_for_host":
      return "Организатор ещё не начал встречу — бот ждёт";
    case "waiting_room":
      return `Бот в зале ожидания — впустите «${meeting.botName}» во встречу`;
    default:
      return null;
  }
}
