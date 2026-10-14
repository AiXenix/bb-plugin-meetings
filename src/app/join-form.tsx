// "Записать встречу": Zoom link, optional title and start time → meetings.join.
import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { MeetingSummary } from "../shared/rpc-contract";
import type { SummaryTemplate } from "../shared/analysis";
import type { Platform } from "../shared/runtime-files";
import { MeetingUrlError, parseMeetingUrl } from "../shared/meeting-url";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatDateTime, parseDatetimeLocal, toDatetimeLocal } from "./format";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { ErrorText, Spinner } from "./ui";
import { fieldClass, Field } from "./feature-controls";
import { ImportRecording } from "./import-recording";

/** A time this close to now (or in the past minute) means "join now". */
const NOW_TOLERANCE_MS = 60_000;
type JoinPlatform = Exclude<Platform, "mock">;

export function JoinForm({ nav, onJoined }: { nav: MeetingsNav; onJoined: () => void }) {
  const rpc = useMeetingsRpc();
  const baseId = useId();
  const ids = { url: `${baseId}-url`, title: `${baseId}-title`, time: `${baseId}-time`, hint: `${baseId}-hint` };
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [joined, setJoined] = useState<MeetingSummary | null>(null);
  const [platform, setPlatform] = useState<JoinPlatform | "">("");
  const [templateId, setTemplateId] = useState("");
  const [autoTranscribe, setAutoTranscribe] = useState("");
  const [autoSummarize, setAutoSummarize] = useState("");
  const [chatMode, setChatMode] = useState("inherit");
  const [chatAnnouncement, setChatAnnouncement] = useState("");
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const loadTemplates = useAsyncAction(async () => setTemplates((await rpc.call("templates.list", {})).templates));
  const join = useAsyncAction(async (input: { url: string; title: string | null; scheduledAt: number | null; platform?: JoinPlatform; templateId?: string; autoTranscribe?: boolean; autoSummarize?: boolean; chatAnnouncement?: string }) => {
    const { meeting } = await rpc.call("meetings.join", input);
    setJoined(meeting);
    setUrl("");
    setTitle("");
    setTime("");
    onJoined();
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (join.pending) return;
    setJoined(null);
    join.setError(null);
    const link = url.trim();
    if (link === "") {
      setValidation("Вставьте ссылку на встречу");
      return;
    }
    try {
      parseMeetingUrl(link, platform ? { platform } : {});
    } catch (cause) {
      setValidation(cause instanceof MeetingUrlError ? cause.message : "Не удалось разобрать ссылку");
      return;
    }
    let scheduledAt: number | null = null;
    if (time !== "") {
      scheduledAt = parseDatetimeLocal(time);
      if (scheduledAt === null) {
        setValidation("Неверное время начала");
        return;
      }
      if (scheduledAt < Date.now() - NOW_TOLERANCE_MS) {
        setValidation("Это время уже прошло — оставьте поле пустым, чтобы подключиться сейчас");
        return;
      }
      if (scheduledAt <= Date.now() + NOW_TOLERANCE_MS) scheduledAt = null;
    }
    setValidation(null);
    void join.run({ url: link, title: title.trim() === "" ? null : title.trim(), scheduledAt,
      ...(platform ? { platform } : {}), ...(templateId ? { templateId } : {}),
      ...(autoTranscribe ? { autoTranscribe: autoTranscribe === "true" } : {}),
      ...(autoSummarize ? { autoSummarize: autoSummarize === "true" } : {}),
      ...(chatMode === "off" ? { chatAnnouncement: "" } : chatMode === "custom" ? { chatAnnouncement } : {}),
    });
  };

  const error = validation ?? join.error;
  return (
    <form
      onSubmit={submit}
      aria-labelledby={`${ids.url}-heading`}
      className="rounded-lg border border-border bg-card p-4"
      noValidate
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${ids.url}-heading`} className="text-sm font-semibold text-foreground">Записать встречу</h2>
        <ImportRecording nav={nav} onImported={onJoined} />
      </div>
      <p id={ids.hint} className="mt-0.5 text-xs text-muted-foreground">
        Zoom, Google Meet, Яндекс Телемост или Jitsi. Бот запишет звук и расшифрует русскую речь локально.
      </p>
      <div className="mt-3 space-y-2">
        <label htmlFor={ids.url} className="sr-only">
          Ссылка на встречу
        </label>
        <Input
          id={ids.url}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setValidation(null);
          }}
          placeholder="https://zoom.us/j/81234567890?pwd=…"
          inputMode="url"
          spellCheck={false}
          aria-describedby={ids.hint}
          aria-invalid={validation !== null}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <label htmlFor={ids.title} className="sr-only">
              Название (необязательно)
            </label>
            <Input
              id={ids.title}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Название (необязательно)"
            />
          </div>
          <div className="flex items-center gap-2 sm:w-64">
            <label htmlFor={ids.time} className="shrink-0 text-xs text-muted-foreground">
              Начало
            </label>
            <Input
              id={ids.time}
              type="datetime-local"
              value={time}
              min={toDatetimeLocal(Date.now())}
              onChange={(event) => {
                setTime(event.target.value);
                setValidation(null);
              }}
              aria-describedby={`${ids.time}-hint`}
              className="min-w-0"
            />
          </div>
        </div>
        <p id={`${ids.time}-hint`} className="text-xs text-muted-foreground">
          Без времени бот подключится сразу.
        </p>
      </div>
      <details className="mt-3" onToggle={event => { if (event.currentTarget.open && templates.length === 0 && !loadTemplates.pending) void loadTemplates.run(); }}>
        <summary className="cursor-pointer text-xs text-muted-foreground">Параметры этой встречи</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Платформа"><select className={fieldClass} value={platform} onChange={event => setPlatform(event.target.value as JoinPlatform | "")}><option value="">Определить по ссылке</option><option value="zoom">Zoom</option><option value="meet">Google Meet</option><option value="telemost">Яндекс Телемост</option><option value="jitsi">Jitsi, включая свой сервер</option></select></Field>
          <Field label="Шаблон разбора"><select className={fieldClass} value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">Из настроек</option>{templates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></Field>
          <Field label="Расшифровка"><select className={fieldClass} value={autoTranscribe} onChange={event => setAutoTranscribe(event.target.value)}><option value="">Из настроек</option><option value="true">Расшифровать автоматически</option><option value="false">Только аудиозапись</option></select></Field>
          <Field label="ИИ-разбор"><select className={fieldClass} value={autoSummarize} onChange={event => setAutoSummarize(event.target.value)}><option value="">Из настроек</option><option value="true">Разобрать автоматически</option><option value="false">Разобрать вручную позже</option></select></Field>
          <Field label="Сообщение в чат"><select className={fieldClass} value={chatMode} onChange={event => setChatMode(event.target.value)}><option value="inherit">Из настроек</option><option value="custom">Свой текст</option><option value="off">Без сообщения</option></select></Field>
          {chatMode === "custom" ? <Field label="Текст сообщения"><input className={fieldClass} maxLength={1000} value={chatAnnouncement} onChange={event => setChatAnnouncement(event.target.value)} /></Field> : null}
        </div>
        <ErrorText className="mt-2 text-xs">{loadTemplates.error}</ErrorText>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={join.pending}>
          {join.pending ? <Spinner /> : <Icon name="Mic" className="size-4" aria-hidden />}
          Подключить бота
        </Button>
        {joined === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {joined.status === "scheduled" && joined.scheduledAt !== null
              ? `Запланировано: ${formatDateTime(joined.scheduledAt)}. `
              : "Бот подключается. "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => nav.toMeeting(joined.id)}
            >
              Открыть встречу
            </button>
          </p>
        )}
      </div>
      <ErrorText className="mt-2">{error}</ErrorText>
    </form>
  );
}
