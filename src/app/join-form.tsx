// "Записать встречу": Zoom link, optional title and start time → meetings.join.
import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { MeetingSummary } from "../shared/rpc-contract";
import { MeetingUrlError, parseMeetingUrl } from "../shared/meeting-url";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatDateTime, parseDatetimeLocal, toDatetimeLocal } from "./format";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { ErrorText, Spinner } from "./ui";

/** A time this close to now (or in the past minute) means "join now". */
const NOW_TOLERANCE_MS = 60_000;

export function JoinForm({ nav, onJoined }: { nav: MeetingsNav; onJoined: () => void }) {
  const rpc = useMeetingsRpc();
  const baseId = useId();
  const ids = { url: `${baseId}-url`, title: `${baseId}-title`, time: `${baseId}-time`, hint: `${baseId}-hint` };
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [joined, setJoined] = useState<MeetingSummary | null>(null);
  const join = useAsyncAction(async (input: { url: string; title: string | null; scheduledAt: number | null }) => {
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
      setValidation("Вставьте ссылку на Zoom-встречу");
      return;
    }
    try {
      parseMeetingUrl(link);
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
    void join.run({ url: link, title: title.trim() === "" ? null : title.trim(), scheduledAt });
  };

  const error = validation ?? join.error;
  return (
    <form
      onSubmit={submit}
      aria-labelledby={`${ids.url}-heading`}
      className="rounded-lg border border-border bg-card p-4"
      noValidate
    >
      <h2 id={`${ids.url}-heading`} className="text-sm font-semibold text-foreground">
        Записать встречу
      </h2>
      <p id={ids.hint} className="mt-0.5 text-xs text-muted-foreground">
        Бот войдёт в Zoom-встречу из браузера, запишет звук и расшифрует его локально с GigaAM.
      </p>
      <div className="mt-3 space-y-2">
        <label htmlFor={ids.url} className="sr-only">
          Ссылка на Zoom-встречу
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
