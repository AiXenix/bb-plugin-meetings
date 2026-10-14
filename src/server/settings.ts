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

/** A Google OAuth client id or secret: no whitespace, ≤ 300 characters; empty = not set. */
function googleCredential(name: string) {
  return z
    .string()
    .max(300, `${name}: не длиннее 300 символов`)
    .refine((value) => !/\s/.test(value), `${name}: без пробелов и переносов строк`);
}

export const DIARIZATION_LABELS: Readonly<Record<DiarizationMode, string>> = {
  "ui+acoustic": "Интерфейс встречи + голоса (точнее)",
  ui: "Только по интерфейсу встречи",
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
    showAvatar: {
      type: "boolean",
      label: "Показывать аватар бота",
      description:
        "Бот включает камеру и показывает картинку с аватаром и своим именем. Картинку загружают на странице «Встречи»; без неё камера выключена.",
      default: true,
    },
    avatarStyle: {
      type: "select",
      label: "Стиль аватара",
      options: ["initials", "circle", "rounded"],
      default: "circle",
    },
    avatarColor: {
      type: "string",
      label: "Цвет аватара",
      experimental_schema: z.string().regex(/^#[0-9a-f]{6}$/i),
      default: "#6366f1",
    },
    avatarText: {
      type: "string",
      label: "Инициалы на аватаре",
      experimental_schema: z.string().max(12),
      default: "NT",
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
      description: "Насколько индикатор говорящего во встрече отстаёт от голоса (0–5000). Сдвигает все сигналы относительно 700 мс: больше — реплики сдвигаются раньше.",
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
    useMeetAccount: {
      type: "boolean",
      label: "Входить под Google-аккаунтом",
      description: "Использовать подключённый профиль Google Meet. Вход выполняется на странице «Встречи» отдельно от Google Calendar.",
      default: false,
    },
    useTelemostAccount: {
      type: "boolean",
      label: "Входить под Яндекс-аккаунтом",
      description: "Использовать подключённый профиль Яндекса для Телемоста.",
      default: false,
    },
    autoTranscribe: {
      type: "boolean",
      label: "Распознавать записи",
      description: "Создавать транскрипт записи. Можно выключить для записи только аудио; для отдельных встреч доступна своя настройка.",
      default: true,
    },
    autoSummarize: {
      type: "boolean",
      label: "Разбирать встречи автоматически",
      description: "После завершения распознавания использовать выбранный шаблон разбора. В режиме «Агент BB» просьба отправляется агенту, который запустил запись.",
      default: true,
    },
    summaryMode: {
      type: "select",
      label: "Как выполнять ИИ-разбор",
      options: ["agent", "api"],
      experimental_optionLabels: { agent: "Агент BB", api: "OpenAI-совместимый API" },
      default: "agent",
    },
    summaryTemplateId: {
      type: "string",
      label: "Шаблон разбора",
      description: "Идентификатор готового или своего шаблона. Шаблоны и полный текст правил доступны на странице «Встречи».",
      experimental_schema: z.string().trim().min(1).max(100),
      default: "executive",
    },
    aiBaseUrl: {
      type: "string",
      label: "Адрес API для разбора",
      description: "OpenAI-совместимый API, включая /v1. Используется только в режиме API.",
      experimental_schema: urlOrEmpty,
      default: "",
    },
    aiModel: {
      type: "string",
      label: "Модель для разбора",
      experimental_schema: z.string().trim().max(200),
      default: "",
    },
    aiApiKey: {
      type: "string",
      label: "Ключ API для разбора",
      secret: true,
      experimental_schema: z.string().max(2000),
    },
    webhookUrl: {
      type: "string",
      label: "Webhook завершения встречи",
      description: "Получает подписанное уведомление после окончательного распознавания встречи.",
      experimental_schema: urlOrEmpty,
      default: "",
    },
    webhookSecret: {
      type: "string",
      label: "Секрет подписи webhook",
      secret: true,
      experimental_schema: z.string().max(2000),
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
      description: "Автоматически отправлять бота на встречи Zoom, Meet, Телемост и Jitsi из календарей.",
      default: false,
    },
    calendarLeadMinutes: {
      type: "number",
      label: "Подключаться заранее, мин",
      description: "За сколько минут до начала события отправлять бота (0–30).",
      experimental_schema: z.number().min(0).max(30),
      default: 1,
    },
    calendarOvertimeMinutes: {
      type: "number",
      label: "Задержаться после конца события, мин",
      description:
        "Бот из календаря уходит не позже чем через это время после запланированного конца события (0–600; 0 — без ограничения, действует только «Максимальная длительность»).",
      experimental_schema: z.number().int().min(0).max(600),
      default: 60,
    },
    calendarFilter: {
      type: "string",
      label: "Фильтр событий",
      description: "Подстрока названия (без учёта регистра) или /регулярное выражение/. Пусто — все события со ссылкой на поддерживаемую встречу.",
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
    googleClientId: {
      type: "string",
      label: "Google Client ID",
      description:
        "OAuth-клиент типа «Веб-приложение» из Google Cloud (включён Google Calendar API). Подключение аккаунта — на странице «Встречи».",
      experimental_schema: googleCredential("Client ID"),
      default: "",
    },
    googleClientSecret: {
      type: "string",
      label: "Google Client Secret",
      description: "Секрет того же OAuth-клиента Google.",
      secret: true,
      experimental_schema: googleCredential("Client Secret"),
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
