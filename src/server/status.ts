// Runtime snapshot (host files) → server-level meeting status
// (docs/dev/DESIGN.md §7.1). Pure, so every phase is unit-tested.
import type { RuntimeSnapshot } from "../shared/contract.js";
import type { MeetingSource, MeetingStatus, TranscriptStatus } from "../shared/rpc-contract.js";
import {
  TERMINAL_BOT_PHASES,
  type BotErrorCode,
  type EndReason,
} from "../shared/runtime-files.js";

/** How long a just-spawned bot may go without writing state.json. */
export const BOT_START_GRACE_MS = 60_000;
/** Failed transcriber runs before the meeting fails (the host backs off between respawns). */
export const MAX_TRANSCRIBER_FAILURES = 3;
/** Give up when no transcriber has run or made progress for this long (as seen by the server). */
export const TRANSCRIBER_STALL_MS = 30 * 60_000;

export interface StatusContext {
  /** The persisted status before this snapshot. */
  readonly status: MeetingStatus;
  readonly source: MeetingSource;
  readonly startedAt: number | null;
  /** Failed transcriber runs so far (see MAX_TRANSCRIBER_FAILURES). */
  readonly transcriberFailures: number;
  /** When the server last saw the transcriber change (start, progress, exit); server clock. */
  readonly transcriberProgressAt: number;
  /**
   * The bot process was already dead with a non-terminal state on an earlier
   * poll. One observation is not enough: the bot writes its final state right
   * before it exits, so a poll can catch the old state and the dead pid.
   */
  readonly botDeathConfirmed: boolean;
  readonly now: number;
}

export interface MappedStatus {
  status: MeetingStatus;
  statusDetail: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptProgress: number | null;
  transcriptError: string | null;
  errorCode: BotErrorCode | null;
  errorMessage: string | null;
  endReason: EndReason | null;
  joinedAt: number | null;
  recordingStartedAt: number | null;
  endedAt: number | null;
  durationSec: number | null;
  participantsCount: number | null;
  participants: string[] | null;
  activeSpeakers: string[];
  hasAudio: boolean;
  screenshotMtime: number | null;
  /** A transcriber should run but does not (crashed mid-meeting, or the bot left and none runs). */
  needsTranscriber: boolean;
  /** The bot has left (or never existed, for imports). */
  botFinished: boolean;
}

const ERROR_TEXT: Readonly<Record<BotErrorCode, { ru: string; en: string }>> = {
  invalid_meeting: {
    ru: "Встреча не найдена: неверный номер или ссылка больше не действует",
    en: "The meeting was not found: wrong meeting id or the link is no longer valid",
  },
  wrong_passcode: {
    ru: "Неверный код доступа. Дайте ссылку с ?pwd=… или правильный код",
    en: "Wrong passcode. Use the invite link with ?pwd=… or the right passcode",
  },
  auth_required: {
    ru: "Организатор пускает только вошедших в Zoom. Войдите в Zoom-аккаунт бота (bb meetings zoom-login) и включите «Входить под Zoom-аккаунтом»",
    en: "The host only admits signed-in Zoom users. Sign the bot in (bb meetings zoom-login) and enable the useZoomAccount setting",
  },
  registration_required: {
    ru: "Встреча требует регистрации: зарегистрируйтесь и дайте боту персональную ссылку участника",
    en: "The meeting requires registration: register and give the bot your personal join link",
  },
  bot_blocked: {
    ru: "Zoom не пускает ботов-гостей в эту встречу. Помогает вход под Zoom-аккаунтом (bb meetings zoom-login)",
    en: "Zoom blocks guest bots from this meeting. Signing the bot in usually helps (bb meetings zoom-login)",
  },
  browser_join_disabled: {
    ru: "Организатор запретил подключение из браузера",
    en: "The host disabled joining from a browser",
  },
  captcha: {
    ru: "Zoom показал капчу. Решите её в живом просмотре на странице «Встречи» (кнопка «Управление»)",
    en: "Zoom showed a captcha. Solve it in the live view on the Meetings page (Control button)",
  },
  meeting_ended: { ru: "Встреча уже закончилась", en: "The meeting has already ended" },
  meeting_locked: { ru: "Организатор заблокировал встречу", en: "The host locked the meeting" },
  meeting_full: { ru: "Во встрече нет свободных мест", en: "The meeting is full" },
  denied: {
    ru: "Организатор не впустил бота или удалил его из встречи",
    en: "The host did not admit the bot or removed it",
  },
  waiting_timeout: {
    ru: "Бота так и не впустили: истекло время ожидания в зале ожидания или начала встречи",
    en: "The bot was never admitted: it timed out in the waiting room or waiting for the host",
  },
  browser_crashed: { ru: "Браузер бота аварийно завершился", en: "The bot's browser crashed" },
  dependency_missing: {
    ru: "На машине записи не хватает компонентов. Выполните bb meetings setup",
    en: "Runtime components are missing on the recording machine. Run bb meetings setup",
  },
  join_failed: { ru: "Не удалось подключиться к встрече", en: "Could not join the meeting" },
  recording_failed: { ru: "Не удалось записать звук встречи", en: "Could not record the meeting audio" },
  unknown: { ru: "Неизвестная ошибка", en: "Unknown error" },
};

export function explainError(code: BotErrorCode, lang: "ru" | "en" = "ru"): string {
  return ERROR_TEXT[code][lang];
}

const STATUS_TEXT: Readonly<Record<MeetingStatus, { ru: string; en: string }>> = {
  scheduled: { ru: "Запланирована", en: "scheduled" },
  starting: { ru: "Запуск бота", en: "starting the bot" },
  joining: { ru: "Подключение к встрече", en: "joining the meeting" },
  waiting_for_host: { ru: "Ждёт, пока организатор начнёт встречу", en: "waiting for the host to start the meeting" },
  waiting_room: { ru: "В зале ожидания: организатор должен впустить бота", en: "in the waiting room: the host must admit the bot" },
  recording: { ru: "Идёт запись", en: "recording" },
  processing: { ru: "Распознавание", en: "transcribing" },
  done: { ru: "Готово", en: "done" },
  failed: { ru: "Ошибка", en: "failed" },
  cancelled: { ru: "Отменена", en: "cancelled" },
};

export function describeStatus(status: MeetingStatus, lang: "ru" | "en" = "ru"): string {
  return STATUS_TEXT[status][lang];
}

/** The Russian explanation plus the bot's own (English) message when it adds something. */
export function errorMessageFor(code: BotErrorCode, raw: string | null): string {
  const explained = explainError(code);
  const detail = raw?.trim() ?? "";
  return detail === "" || detail === explained ? explained : `${explained}. ${detail}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lostStatus(snapshot: RuntimeSnapshot): MappedStatus {
  return {
    ...emptyMapped(snapshot),
    status: "failed",
    statusDetail: "lost",
    errorCode: "unknown",
    errorMessage: "Каталог встречи пропал с машины записи (lost): запись и транскрипт недоступны",
    transcriptStatus: "failed",
  };
}

function emptyMapped(snapshot: RuntimeSnapshot): MappedStatus {
  return {
    status: "starting",
    statusDetail: null,
    transcriptStatus: "none",
    transcriptProgress: null,
    transcriptError: null,
    errorCode: null,
    errorMessage: null,
    endReason: null,
    joinedAt: null,
    recordingStartedAt: null,
    endedAt: null,
    durationSec: null,
    participantsCount: null,
    participants: null,
    activeSpeakers: [],
    hasAudio: (snapshot.files.audioBytes ?? 0) > 0,
    screenshotMtime: snapshot.files.screenshotMtime,
    needsTranscriber: false,
    botFinished: false,
  };
}

/** Epoch ms, or null for the "not set" values the host may write (0). */
function timestamp(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

export function mapRuntime(snapshot: RuntimeSnapshot, ctx: StatusContext): MappedStatus {
  if (!snapshot.exists) {
    // meeting.start may still be creating the directory (say, the server reloaded mid-start).
    if (ctx.status === "starting" && ctx.startedAt !== null && ctx.now - ctx.startedAt < BOT_START_GRACE_MS) {
      return { ...emptyMapped(snapshot), status: "starting", statusDetail: describeStatus("starting") };
    }
    return lostStatus(snapshot);
  }

  const out = emptyMapped(snapshot);
  const { bot, transcriber } = snapshot;

  if (bot !== null) {
    out.joinedAt = timestamp(bot.joinedAt);
    // Imports write recordingStartedAt 0: there was no live recording.
    out.recordingStartedAt = timestamp(bot.recordingStartedAt);
    out.endedAt = timestamp(bot.endedAt);
    out.endReason = bot.endReason;
    out.participantsCount = snapshot.roster?.count ?? bot.participants.count;
    out.participants = snapshot.roster?.names ?? bot.participants.names;
    out.durationSec = bot.audio.seconds;
    if (bot.audio.bytes > 0) out.hasAudio = true;
    if (bot.error !== null) {
      out.errorCode = bot.error.code;
      out.errorMessage = errorMessageFor(bot.error.code, bot.error.message);
    }
  }
  if (out.durationSec === null || out.durationSec === 0) {
    const fromTranscriber = transcriber?.audioSec ?? 0;
    if (fromTranscriber > 0) out.durationSec = fromTranscriber;
  }

  // Transcript side.
  if (snapshot.files.transcriptFinal) {
    out.transcriptStatus = "done";
  } else if (transcriber !== null) {
    const progress = transcriber.audioSec > 0 ? clamp01(transcriber.processedSec / transcriber.audioSec) : 0;
    switch (transcriber.phase) {
      case "waiting_audio":
      case "live":
      case "waiting_asr":
        out.transcriptStatus = transcriber.mode === "offline" ? "finalizing" : "live";
        break;
      case "finalizing":
        out.transcriptStatus = "finalizing";
        break;
      case "done":
        out.transcriptStatus = "finalizing";
        break;
      case "failed":
        out.transcriptStatus = snapshot.transcriberAlive ? "finalizing" : "failed";
        out.transcriptError = transcriber.error ?? transcriber.detail;
        break;
    }
    if (transcriber.phase === "waiting_asr") out.transcriptError = transcriber.detail || "GigaAM недоступен, жду сервер";
    out.transcriptProgress = progress;
  }

  // Bot side.
  const botTerminal = bot !== null && (TERMINAL_BOT_PHASES.has(bot.phase) || (!snapshot.botAlive && ctx.botDeathConfirmed));
  const botFinished =
    bot === null ? !snapshot.botAlive && (ctx.source === "import" || transcriber !== null) : botTerminal;
  out.botFinished = botFinished;

  if (!botFinished) {
    out.transcriptProgress = null;
    if (bot === null) {
      const started = ctx.startedAt ?? ctx.now;
      if (snapshot.botAlive || ctx.now - started < BOT_START_GRACE_MS) {
        out.status = "starting";
        out.statusDetail = describeStatus("starting");
        return out;
      }
      out.status = "failed";
      out.statusDetail = "Бот не запустился";
      out.errorCode = "unknown";
      out.errorMessage = "Бот не запустился: процесс завершился, не записав состояние. Смотрите bb meetings logs";
      return out;
    }
    out.activeSpeakers = bot.activeSpeakers;
    // A live transcriber that died mid-meeting is restarted (it resumes from its checkpoint).
    out.needsTranscriber =
      snapshot.botAlive &&
      transcriber !== null &&
      !snapshot.transcriberAlive &&
      transcriber.phase !== "done" &&
      ctx.transcriberFailures < MAX_TRANSCRIBER_FAILURES;
    switch (bot.phase) {
      case "starting":
      case "joining":
        out.status = "joining";
        break;
      case "waiting_for_host":
        out.status = "waiting_for_host";
        break;
      case "waiting_room":
        out.status = "waiting_room";
        break;
      case "in_meeting":
      case "leaving":
        out.status = "recording";
        break;
      default:
        out.status = "recording";
    }
    out.statusDetail = bot.phase === "leaving" ? "Бот выходит из встречи" : describeStatus(out.status);
    return out;
  }

  // The bot has finished (or crashed without a terminal state).
  if (bot !== null && !TERMINAL_BOT_PHASES.has(bot.phase) && out.errorCode === null) {
    out.errorCode = "browser_crashed";
    out.errorMessage = errorMessageFor("browser_crashed", "the bot process exited without a final state");
  }

  if (!out.hasAudio && !snapshot.files.transcriptFinal) {
    if (bot !== null && bot.phase === "ended" && bot.endReason === "stopped") {
      out.status = "cancelled";
      out.statusDetail = "Остановлено до начала записи";
      return out;
    }
    if (ctx.source === "import" && transcriber === null && ctx.now - (ctx.startedAt ?? ctx.now) < BOT_START_GRACE_MS) {
      out.status = "processing";
      out.statusDetail = "Подготовка файла";
      return out;
    }
    out.status = "failed";
    if (out.errorCode === null) {
      const fromReason = errorFromEndReason(bot?.endReason ?? null);
      out.errorCode = fromReason;
      out.errorMessage = errorMessageFor(fromReason, bot?.detail ?? null);
    }
    out.statusDetail = "Записи нет";
    return out;
  }

  if (snapshot.files.transcriptFinal) {
    out.status = "done";
    out.statusDetail = describeStatus("done");
    out.transcriptProgress = null;
    out.transcriptError = null;
    return out;
  }

  const transcriberDead = !snapshot.transcriberAlive;
  const stalled = ctx.now - ctx.transcriberProgressAt > TRANSCRIBER_STALL_MS;
  if (transcriberDead && (ctx.transcriberFailures >= MAX_TRANSCRIBER_FAILURES || stalled)) {
    out.status = "failed";
    out.statusDetail = "Распознавание не удалось";
    out.transcriptStatus = "failed";
    out.transcriptError ??= stalled
      ? "Транскрибатор не запускается. Смотрите bb meetings logs"
      : "Транскрибатор несколько раз завершился с ошибкой. Смотрите bb meetings logs";
    out.errorCode ??= "unknown";
    out.errorMessage ??= `Не удалось распознать запись: ${out.transcriptError}`;
    return out;
  }
  out.status = "processing";
  out.needsTranscriber = transcriberDead;
  if (out.transcriptStatus === "none" || out.transcriptStatus === "live" || out.transcriptStatus === "failed") {
    out.transcriptStatus = "finalizing";
  }
  out.transcriptProgress ??= 0;
  out.statusDetail =
    transcriber?.phase === "waiting_asr"
      ? "Ждёт сервер GigaAM"
      : `${describeStatus("processing")}: ${Math.round((out.transcriptProgress ?? 0) * 100)}%`;
  return out;
}

function errorFromEndReason(reason: EndReason | null): BotErrorCode {
  switch (reason) {
    case "waiting_timeout":
      return "waiting_timeout";
    case "meeting_ended":
      return "meeting_ended";
    case "removed":
      return "denied";
    default:
      return "join_failed";
  }
}
