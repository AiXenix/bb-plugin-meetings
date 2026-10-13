// Plugin settings (docs/dev/DESIGN.md §11). Keys are part of the public
// surface: `bb plugin config meetings set <key> <value>` and the skill use them.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DIARIZATION_MODES, type DiarizationMode } from "../shared/runtime-files.js";

export const DEFAULT_SUMMARY_PROMPT = [
  "Прочитай транскрипт встречи {id} целиком (инструмент meetings_transcript, все страницы) и сохрани резюме инструментом meetings_save_summary.",
  "Резюме — в Markdown, по-русски, коротко и по делу:",
  "1. Ключевые решения.",
  "2. Задачи (action items): что сделать, ответственный, срок — если они звучали.",
  "3. Открытые вопросы и риски.",
  "Не выдумывай того, чего не было во встрече. После сохранения кратко перескажи резюме здесь.",
].join("\n");

const urlOrEmpty = z
  .string()
  .refine(
    (value) => value.trim() === "" || /^https?:\/\/\S+$/.test(value.trim()),
    "Укажите адрес http:// или https:// либо оставьте поле пустым",
  );

const jsonObjectOrEmpty = z.string().refine((value) => {
  if (value.trim() === "") return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}, "Нужен JSON-объект ({…}) либо пустое поле");

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const icsUrls = z.string().refine(
  (value) =>
    value
      .split(/\s+/)
      .filter(Boolean)
      .every((url) => /^(https?|webcal):\/\/\S+$/i.test(url) && parsesAsUrl(url.replace(/^webcal:/i, "https:"))),
  "Укажите один или несколько адресов https:// или webcal:// через пробел",
);

const regexOrText = z.string().refine((value) => {
  const match = /^\/(.*)\/([a-z]*)$/i.exec(value.trim());
  if (match === null) return true;
  try {
    new RegExp(match[1] ?? "", match[2]);
    return true;
  } catch {
    return false;
  }
}, "Некорректное регулярное выражение");

export const DIARIZATION_LABELS: Readonly<Record<DiarizationMode, string>> = {
  "ui+acoustic": "Интерфейс Zoom + голоса (точнее)",
  ui: "Только по интерфейсу Zoom",
  acoustic: "Только по голосам",
};

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    botName: {
      type: "string",
      label: "Имя бота",
      description: "Под этим именем бот появляется во встрече.",
      experimental_schema: z.string().trim().min(1, "Имя не может быть пустым").max(64, "Не длиннее 64 символов"),
      default: "Notetaker",
    },
    maxDurationMinutes: {
      type: "number",
      label: "Максимальная длительность, мин",
      description: "Бот покидает встречу по истечении этого времени (5–1440).",
      experimental_schema: z.number().int().min(5).max(1440),
      default: 240,
    },
    aloneTimeoutMinutes: {
      type: "number",
      label: "Выйти, если остался один, мин",
      description: "Бот уходит, когда в встрече больше никого нет дольше этого времени (0,5–60).",
      experimental_schema: z.number().min(0.5).max(60),
      default: 2,
    },
    waitingTimeoutMinutes: {
      type: "number",
      label: "Ожидание впуска, мин",
      description: "Сколько ждать в зале ожидания или начала встречи организатором (1–240).",
      experimental_schema: z.number().min(1).max(240),
      default: 20,
    },
    maxConcurrentBots: {
      type: "number",
      label: "Одновременных записей",
      description: "Сколько ботов могут одновременно находиться во встречах (1–8). Каждый — отдельный Chrome.",
      experimental_schema: z.number().int().min(1).max(8),
      default: 2,
    },
    chatAnnouncement: {
      type: "string",
      label: "Сообщение в чат",
      description: "Бот отправит его в чат встречи после подключения. Пусто — ничего не отправлять.",
      experimental_schema: z.string().max(1000),
      default: "",
    },
    notifyThread: {
      type: "boolean",
      label: "Сообщать в тред",
      description: "Когда встреча закончится, написать в тред агента, который отправил бота.",
      default: true,
    },
    autoSummaryPrompt: {
      type: "string",
      label: "Просьба к агенту после встречи",
      description:
        "Добавляется к сообщению в тред, когда транскрипт готов. Пусто — только уведомление. Можно использовать {id} и {title}.",
      experimental_multiline: true,
      experimental_schema: z.string().max(4000),
      default: DEFAULT_SUMMARY_PROMPT,
    },
    liveTranscription: {
      type: "boolean",
      label: "Распознавать во время встречи",
      description: "Транскрипт появляется по ходу встречи. Выключите, чтобы распознать запись целиком после окончания.",
      default: true,
    },
    diarization: {
      type: "select",
      label: "Разделение по спикерам",
      description: "Как определять, кто говорит.",
      options: [...DIARIZATION_MODES],
      experimental_optionLabels: { ...DIARIZATION_LABELS },
      default: "ui+acoustic",
    },
    speakerLagMs: {
      type: "number",
      label: "Задержка индикатора спикера, мс",
      description: "Насколько индикатор говорящего в Zoom отстаёт от голоса (0–5000). Сдвигает все сигналы относительно 700 мс: больше — реплики сдвигаются раньше.",
      experimental_schema: z.number().int().min(0).max(5000),
      default: 700,
    },
    gigaamUrl: {
      type: "string",
      label: "Адрес сервера GigaAM",
      description: "Пусто — найти сервер плагина gigaam автоматически. Иначе OpenAI-совместимый сервер с /v1/audio/transcriptions.",
      experimental_schema: urlOrEmpty,
      default: "",
    },
    keepRawAudio: {
      type: "boolean",
      label: "Хранить несжатый звук",
      description: "Не удалять audio.pcm (16 кГц) после распознавания. Нужно только для отладки.",
      default: false,
    },
    screenshotIntervalSec: {
      type: "number",
      label: "Интервал скриншотов, с",
      description: "Как часто сохранять снимок окна бота (0–300; 0 — только при событиях).",
      experimental_schema: z.number().int().min(0).max(300),
      default: 10,
    },
    silenceTimeoutMinutes: {
      type: "number",
      label: "Выйти при тишине, мин",
      description: "Бот уходит, если всё это время нет никакого звука (0–240; 0 — никогда).",
      experimental_schema: z.number().min(0).max(240),
      default: 30,
    },
    useZoomAccount: {
      type: "boolean",
      label: "Входить под Zoom-аккаунтом",
      description:
        "Подключаться с профилем, в котором выполнен вход в Zoom (bb meetings zoom-login). Помогает, когда Zoom не пускает гостей-ботов.",
      default: false,
    },
    speakerSelectors: {
      type: "string",
      label: "Селекторы спикеров (JSON)",
      description: "Для опытных: переопределение селекторов определения говорящего. Пусто — встроенные.",
      experimental_multiline: true,
      experimental_schema: jsonObjectOrEmpty,
      default: "",
    },
    chromePath: {
      type: "string",
      label: "Путь к Google Chrome",
      description: "Пусто — найти автоматически.",
      default: "",
    },
    calendarIcsUrls: {
      type: "string",
      label: "Календари (ICS)",
      description:
        "Секретные адреса календарей в формате iCal через пробел (Google: «Закрытый адрес в формате iCal»; Outlook/Яндекс: опубликованный ICS).",
      secret: true,
      experimental_schema: icsUrls,
    },
    calendarAutoJoin: {
      type: "boolean",
      label: "Подключаться к встречам из календаря",
      description: "Автоматически отправлять бота на Zoom-встречи из календарей.",
      default: false,
    },
    calendarLeadMinutes: {
      type: "number",
      label: "Подключаться заранее, мин",
      description: "За сколько минут до начала события отправлять бота (0–30).",
      experimental_schema: z.number().min(0).max(30),
      default: 1,
    },
    calendarFilter: {
      type: "string",
      label: "Фильтр событий",
      description: "Подстрока названия (без учёта регистра) или /регулярное выражение/. Пусто — все события со ссылкой Zoom.",
      experimental_schema: regexOrText,
      default: "",
    },
    calendarSyncMinutes: {
      type: "number",
      label: "Синхронизация календаря, мин",
      description: "Как часто перечитывать календари (1–120).",
      experimental_schema: z.number().int().min(1).max(120),
      default: 5,
    },
  });
}

export type SettingsHandle = ReturnType<typeof defineSettings>;
export type MeetingsSettings = Awaited<ReturnType<SettingsHandle["get"]>>;

/** Feed URLs from the secret setting (webcal:// is fetched over https). */
export function calendarFeedUrls(settings: Pick<MeetingsSettings, "calendarIcsUrls">): string[] {
  return (settings.calendarIcsUrls ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((url) => url.replace(/^webcal:\/\//i, "https://"));
}

/** The speakerSelectors setting as an object, or null when empty/invalid. */
export function parseSpeakerSelectors(value: string): Record<string, unknown> | null {
  if (value.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
