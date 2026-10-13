// Meeting detail page: header (title, status, timings, link, errors), actions,
// live view, audio player, summary, speakers and the transcript.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { MeetingDetail } from "../shared/rpc-contract";
import { maskMeetingUrl } from "../shared/meeting-url";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { AudioPlayer } from "./audio-player";
import type { PlayerHandle } from "./audio-player";
import { ACTIVE_STATUSES, CHANNEL_MEETING_CHANGED, LIVE_STATUSES, TERMINAL_STATUSES, downloadUrl } from "./constants";
import type { DownloadFormat } from "./constants";
import { formatDateTime, formatDuration, formatPercent, formatTime, pluralRu } from "./format";
import { useAsyncAction, useDebouncedCallback, useInterval, useMountedRef, useOnReconnect } from "./hooks";
import {
  END_REASON_TEXT,
  TRANSCRIPT_STATUS_TEXT,
  ZOOM_LOGIN_ERRORS,
  errorText,
  liveHint,
  speakingLabel,
} from "./labels";
import { LiveView } from "./live-view";
import { meetingTitle } from "./meeting-cards";
import { messageOf, useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { speakerColors } from "./speaker-colors";
import { SpeakersPanel } from "./speakers-panel";
import { SummaryPanel } from "./summary-panel";
import { speakerOrder, speakerStats } from "./transcript-model";
import { TranscriptView } from "./transcript-view";
import {
  ConfirmDialog,
  CopyButton,
  ElapsedClock,
  EmptyState,
  ErrorText,
  InlineTextInput,
  Notice,
  PageFrame,
  RecordingDot,
  Spinner,
  StatusChip,
} from "./ui";
import { useSegments } from "./use-segments";
import { useZoomLoginStart } from "./zoom-card";

const NO_NAMES: Readonly<Record<string, string>> = {};

function useMeetingDetail(id: string) {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("meetings.get", { id }).then(
      (result) => {
        if (!mounted.current) return;
        setMeeting(result.meeting);
        setError(null);
      },
      (cause: unknown) => {
        if (mounted.current) setError(messageOf(cause));
      },
    );
  }, [rpc, id, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 250);
  useRealtime(CHANNEL_MEETING_CHANGED, (payload: unknown) => {
    const target = typeof payload === "object" && payload !== null ? (payload as { id?: unknown }).id : undefined;
    if (target === undefined || target === id) debounced();
  });
  useOnReconnect(refetch);
  const active = meeting !== null && (ACTIVE_STATUSES.has(meeting.status) || meeting.status === "scheduled");
  useInterval(refetch, active ? 10_000 : null);
  return { meeting, error, refetch };
}

function triggerDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const DOWNLOADS: ReadonlyArray<{ format: DownloadFormat; label: string }> = [
  { format: "md", label: "Markdown (.md)" },
  { format: "txt", label: "Текст (.txt)" },
  { format: "srt", label: "Субтитры SRT (.srt)" },
  { format: "vtt", label: "Субтитры WebVTT (.vtt)" },
  { format: "json", label: "JSON (.json)" },
  { format: "audio", label: "Аудиозапись (.ogg)" },
];

function DownloadMenu({ meeting }: { meeting: MeetingDetail }) {
  const hasText = meeting.segmentsCount > 0;
  if (!hasText && !meeting.hasAudio) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Icon name="Download" className="size-3.5" aria-hidden />
          Скачать
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Скачать">
        {DOWNLOADS.map((item) => (
          <DropdownMenuItem
            key={item.format}
            disabled={item.format === "audio" ? !meeting.hasAudio : !hasText}
            onSelect={() => triggerDownload(downloadUrl(meeting.id, item.format))}
          >
            <Icon name={item.format === "audio" ? "Mic" : "FileText"} className="size-4" aria-hidden />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LogsPanel({ id, regionId }: { id: string; regionId: string }) {
  const rpc = useMeetingsRpc();
  const [text, setText] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const load = useAsyncAction(async () => {
    const result = await rpc.call("meetings.logs", { id, lines: 300 });
    setText(result.text);
  });
  const run = load.run;
  useEffect(() => {
    void run();
  }, [run]);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre !== null) pre.scrollTop = pre.scrollHeight;
  }, [text]);
  return (
    <div id={regionId} className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-foreground">Логи бота и расшифровки</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7"
          disabled={load.pending}
          onClick={() => void run()}
        >
          {load.pending ? <Spinner /> : <Icon name="RotateCcw" className="size-3.5" aria-hidden />}
          Обновить
        </Button>
      </div>
      <ErrorText className="px-3 py-2 text-xs">{load.error}</ErrorText>
      {text === null ? (
        load.error === null ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Загружаем логи…
          </p>
        ) : null
      ) : (
        <pre
          ref={preRef}
          tabIndex={0}
          aria-label="Логи"
          className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground"
        >
          {text === "" ? "Логи пусты." : text}
        </pre>
      )}
    </div>
  );
}

function TitleEditor({ meeting, onSaved }: { meeting: MeetingDetail; onSaved: () => void }) {
  const rpc = useMeetingsRpc();
  const [editing, setEditing] = useState(false);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const save = useAsyncAction(async (title: string) => {
    setPendingTitle(title);
    try {
      await rpc.call("meetings.update", { id: meeting.id, title });
      onSaved();
    } finally {
      setPendingTitle(null);
    }
  });
  const title = pendingTitle ?? meetingTitle(meeting);
  return (
    <div className="min-w-0 flex-1">
      {editing ? (
        <InlineTextInput
          initial={meeting.title}
          label="Название встречи"
          maxLength={200}
          className="h-9 text-base font-semibold"
          onCommit={(value) => {
            setEditing(false);
            if (value !== "") void save.run(value);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex min-w-0 items-start gap-1">
          <h1 className="min-w-0 break-words text-lg font-semibold leading-snug text-foreground">{title}</h1>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Переименовать встречу"
            disabled={save.pending}
            onClick={() => setEditing(true)}
          >
            {save.pending ? <Spinner className="size-3.5" /> : <Icon name="Edit" className="size-3.5" aria-hidden />}
          </Button>
        </div>
      )}
      <ErrorText className="mt-1 text-xs">{save.error}</ErrorText>
    </div>
  );
}

function transcriptEmptyText(meeting: MeetingDetail): string {
  switch (meeting.status) {
    case "scheduled":
      return "Встреча ещё не началась.";
    case "starting":
    case "joining":
    case "waiting_for_host":
    case "waiting_room":
      return "Расшифровка начнётся, когда бот войдёт во встречу.";
    case "recording":
      return "Текст появится через несколько секунд после того, как кто-нибудь заговорит.";
    case "processing":
      return "Идёт расшифровка записи…";
    case "done":
      return "В записи не нашлось речи.";
    case "failed":
      if (meeting.hasAudio) return "Расшифровки нет.";
      if (meeting.source === "import") return "Не удалось прочитать звук из файла.";
      return "Записи нет — бот не попал во встречу.";
    case "cancelled":
      return "Встреча отменена.";
  }
}

/** A cancelled meeting whose start is still ahead: "again" means scheduling it, not joining now. */
function rejoinLater(meeting: MeetingDetail): boolean {
  return meeting.status === "cancelled" && meeting.scheduledAt !== null && meeting.scheduledAt > Date.now();
}

function transcriptStatusLine(meeting: MeetingDetail, final: boolean): string | null {
  if (final || (TERMINAL_STATUSES.has(meeting.status) && meeting.transcriptStatus !== "finalizing")) return null;
  if (meeting.transcriptStatus === "finalizing" || meeting.status === "processing") {
    return meeting.transcriptProgress === null
      ? TRANSCRIPT_STATUS_TEXT.finalizing
      : `${TRANSCRIPT_STATUS_TEXT.finalizing}: ${formatPercent(meeting.transcriptProgress)}`;
  }
  return null;
}

export function DetailPage({ id, segmentId, nav }: { id: string; segmentId: number | null; nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const { meeting, error, refetch } = useMeetingDetail(id);
  const live = meeting !== null && LIVE_STATUSES.has(meeting.status);
  const active = meeting !== null && ACTIVE_STATUSES.has(meeting.status);
  const segments = useSegments(id, meeting?.transcriptStatus ?? null, active);
  const player = useRef<PlayerHandle>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const [follow, setFollow] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "retranscribe" | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [dumpMessage, setDumpMessage] = useState<string | null>(null);
  const logsId = useId();
  const zoomLogin = useZoomLoginStart(nav);

  const stop = useAsyncAction(async () => {
    await rpc.call("meetings.stop", { id });
    refetch();
  });
  const cancel = useAsyncAction(async () => {
    await rpc.call("meetings.cancel", { id });
    refetch();
  });
  const retranscribe = useAsyncAction(async () => {
    await rpc.call("meetings.retranscribe", { id });
    setConfirm(null);
    refetch();
    segments.reload();
  });
  // A failed or cancelled meeting can be retried with the same link (e.g. after signing in to Zoom);
  // a cancelled one that has not started yet is scheduled again for its time.
  const rejoin = useAsyncAction(async (source: MeetingDetail) => {
    const minutes = source.maxDurationMinutes;
    const { meeting: next } = await rpc.call("meetings.join", {
      url: source.url,
      title: source.title.trim() === "" ? null : source.title,
      botName: source.botName,
      scheduledAt: rejoinLater(source) ? source.scheduledAt : null,
      maxDurationMinutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440 ? minutes : null,
    });
    nav.toMeeting(next.id);
  });
  const remove = useAsyncAction(async () => {
    await rpc.call("meetings.delete", { id });
    setConfirm(null);
    nav.toList({ replace: true });
  });
  const dump = useAsyncAction(async () => {
    const result = await rpc.call("meetings.debugDump", { id });
    setDumpMessage(
      result.requested
        ? "Снимок DOM запрошен — бот сохранит его в папку debug/ встречи."
        : "Бот не запущен — снимок DOM сейчас недоступен.",
    );
  });

  const onSeek = useCallback((seconds: number) => player.current?.seek(seconds), []);
  const names = meeting?.speakerNames ?? NO_NAMES;
  const serverSpeakers = meeting?.speakers;
  const stats = useMemo(
    () => speakerStats(serverSpeakers ?? [], segments.segments, names),
    [serverSpeakers, segments.segments, names],
  );
  const colors = useMemo(() => speakerColors(speakerOrder(segments.segments, stats)), [segments.segments, stats]);
  const labels = useMemo(() => new Map(stats.map((stat) => [stat.key, stat.label])), [stats]);
  const onRenamed = useCallback(() => {
    refetch();
    if ((serverSpeakers?.length ?? 0) === 0) segments.reload();
  }, [refetch, serverSpeakers, segments.reload]);

  if (meeting === null) {
    return (
      <PageFrame wide>
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => nav.toList()}>
          <Icon name="ArrowLeft" className="size-4" aria-hidden />
          Все встречи
        </Button>
        {error === null ? (
          <EmptyState className="mt-4">
            <span className="inline-flex items-center gap-2">
              <Spinner /> Загружаем встречу…
            </span>
          </EmptyState>
        ) : (
          <Notice tone="danger" title="Не удалось открыть встречу" className="mt-4" role="alert">
            <p className="text-muted-foreground">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refetch}>
              Повторить
            </Button>
          </Notice>
        )}
      </PageFrame>
    );
  }

  const title = meetingTitle(meeting);
  const when = meeting.startedAt ?? meeting.scheduledAt ?? meeting.createdAt;
  const since = meeting.recordingStartedAt ?? meeting.joinedAt ?? meeting.startedAt;
  const problem = errorText(meeting.errorCode, meeting.errorMessage);
  const hint = live ? (liveHint(meeting) ?? meeting.statusDetail) : null;
  const canRetranscribe = meeting.hasAudio && TERMINAL_STATUSES.has(meeting.status);
  const imported = meeting.source === "import";
  // Imports have a file:// path instead of a meeting link: there is nothing to join.
  const canRejoin = !imported && (meeting.status === "failed" || meeting.status === "cancelled");
  const final = segments.final;
  // Summary and speakers only make sense once there is something recorded.
  const hasContent = meeting.hasAudio || segments.segments.length > 0 || (meeting.summaryMd ?? "") !== "";

  return (
    <PageFrame wide>
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => nav.toList()}>
        <Icon name="ArrowLeft" className="size-4" aria-hidden />
        Все встречи
      </Button>

      <header className="mt-2">
        <div className="flex items-start gap-2">
          {meeting.status === "recording" ? <RecordingDot className="mt-2.5" /> : null}
          <TitleEditor meeting={meeting} onSaved={refetch} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <StatusChip meeting={meeting} />
          <span>
            {meeting.status === "scheduled" && meeting.scheduledAt !== null
              ? `Начало: ${formatDateTime(meeting.scheduledAt)}`
              : formatDateTime(when)}
            {meeting.endedAt === null || meeting.status === "scheduled" ? null : ` – ${formatTime(meeting.endedAt)}`}
          </span>
          {live && since !== null ? (
            <ElapsedClock since={since} className="text-foreground" />
          ) : meeting.durationSec > 0 ? (
            <span>{formatDuration(meeting.durationSec)}</span>
          ) : null}
          {meeting.participantsCount === null ? null : (
            <span>
              {meeting.participantsCount} {pluralRu(meeting.participantsCount, "участник", "участника", "участников")}
            </span>
          )}
          <span>Бот: {meeting.botName}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <Icon name={imported ? "FileText" : "Link"} className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-mono" title={maskMeetingUrl(meeting.url)}>
            {maskMeetingUrl(meeting.url)}
          </span>
          <CopyButton
            text={meeting.url}
            label={imported ? "Скопировать путь к файлу записи" : "Скопировать ссылку на встречу"}
          />
        </div>
        {hint === null || hint === "" ? null : (
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
            {hint}
          </p>
        )}
        {live && meeting.status === "recording" && meeting.activeSpeakers.length > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {speakingLabel(meeting.activeSpeakers.length)}:{" "}
            <span className="text-foreground">{meeting.activeSpeakers.join(", ")}</span>
          </p>
        ) : null}
        {meeting.endReason === null || live ? null : (
          <p className="mt-1 text-sm text-muted-foreground">Завершение: {END_REASON_TEXT[meeting.endReason]}</p>
        )}
      </header>
      <ErrorText className="mt-2 text-xs">
        {error === null ? null : `Не удалось обновить данные встречи: ${error}`}
      </ErrorText>

      {problem === null || meeting.status === "cancelled" ? null : (
        <Notice tone={meeting.status === "failed" ? "danger" : "warning"} title={problem} role="alert" className="mt-3">
          {meeting.errorCode !== null && meeting.errorMessage !== null && meeting.errorMessage !== "" ? (
            <p className="break-words text-xs text-muted-foreground">{meeting.errorMessage}</p>
          ) : null}
          {meeting.errorCode !== null && ZOOM_LOGIN_ERRORS.has(meeting.errorCode) ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={zoomLogin.pending} onClick={() => void zoomLogin.run()}>
                {zoomLogin.pending ? <Spinner /> : <Icon name="SquareUnlock02" className="size-4" aria-hidden />}
                Войти в Zoom
              </Button>
              <span className="text-xs text-muted-foreground">
                После входа включите <code className="font-mono">useZoomAccount</code> и запустите бота снова.
              </span>
            </div>
          ) : null}
          {meeting.errorCode === "captcha" && live ? (
            <p className="text-xs text-muted-foreground">
              Включите «Управление» в живом просмотре ниже и пройдите проверку.
            </p>
          ) : null}
          <ErrorText className="text-xs">{zoomLogin.error}</ErrorText>
        </Notice>
      )}
      {meeting.transcriptError !== null && meeting.transcriptStatus !== "failed" && !final ? (
        // E.g. GigaAM is down: the transcriber waits for it, and the text (or its progress) stands still meanwhile.
        <Notice tone="warning" title="Расшифровка ждёт" className="mt-3">
          <p className="break-words text-xs text-muted-foreground">{meeting.transcriptError}</p>
          <p className="text-xs text-muted-foreground">
            Текст продолжит появляться, когда распознавание снова заработает. Состояние сервера GigaAM:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">bb gigaam status</code>
          </p>
        </Notice>
      ) : null}
      {meeting.transcriptStatus === "failed" ? (
        <Notice tone="danger" title={TRANSCRIPT_STATUS_TEXT.failed} className="mt-3">
          {meeting.transcriptError === null ? null : (
            <p className="break-words text-xs text-muted-foreground">{meeting.transcriptError}</p>
          )}
          {canRetranscribe ? (
            <p className="text-xs text-muted-foreground">Попробуйте «Повторить расшифровку».</p>
          ) : null}
        </Notice>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {live ? (
          <Button type="button" variant="destructive" size="sm" disabled={stop.pending} onClick={() => void stop.run()}>
            {stop.pending ? <Spinner /> : <Icon name="Square" className="size-3.5" aria-hidden />}
            {meeting.status === "recording" ? "Остановить запись" : "Отключить бота"}
          </Button>
        ) : null}
        {canRejoin ? (
          <Button type="button" size="sm" disabled={rejoin.pending} onClick={() => void rejoin.run(meeting)}>
            {rejoin.pending ? <Spinner /> : <Icon name="Repeat" className="size-3.5" aria-hidden />}
            {rejoinLater(meeting) ? "Запланировать снова" : "Подключить снова"}
          </Button>
        ) : null}
        {meeting.status === "scheduled" ? (
          <Button type="button" variant="outline" size="sm" disabled={cancel.pending} onClick={() => void cancel.run()}>
            {cancel.pending ? <Spinner /> : <Icon name="X" className="size-3.5" aria-hidden />}
            Отменить
          </Button>
        ) : null}
        {canRetranscribe ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              retranscribe.setError(null);
              setConfirm("retranscribe");
            }}
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden />
            Повторить расшифровку
          </Button>
        ) : null}
        <DownloadMenu meeting={meeting} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={logsOpen}
          aria-controls={logsOpen ? logsId : undefined}
          onClick={() => setLogsOpen((open) => !open)}
        >
          <Icon name="FileText" className="size-3.5" aria-hidden />
          Логи
        </Button>
        {live ? (
          <Button type="button" variant="ghost" size="sm" disabled={dump.pending} onClick={() => void dump.run()}>
            {dump.pending ? <Spinner /> : <Icon name="Bug" className="size-3.5" aria-hidden />}
            Снимок DOM
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive-text hover:text-destructive-text sm:ml-auto"
          onClick={() => {
            remove.setError(null);
            setConfirm("delete");
          }}
        >
          <Icon name="Trash2" className="size-3.5" aria-hidden />
          Удалить
        </Button>
      </div>
      <ErrorText className="mt-2">{stop.error ?? cancel.error ?? rejoin.error ?? dump.error}</ErrorText>
      {dumpMessage === null ? null : (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {dumpMessage}
        </p>
      )}
      {logsOpen ? <LogsPanel id={id} regionId={logsId} /> : null}

      {live ? <LiveView id={id} defaultOpen={meeting.status !== "recording"} className="mt-4" /> : null}

      {meeting.hasAudio ? (
        <div className="sticky top-0 z-10 -mx-1 mt-4 bg-background px-1 py-1">
          <AudioPlayer
            meetingId={id}
            fallbackDurationSec={meeting.durationSec}
            growing={live}
            segments={segments.segments}
            onActiveSegment={setActiveSegmentId}
            handleRef={player}
          />
        </div>
      ) : null}

      {hasContent && (!live || (meeting.summaryMd ?? "") !== "") ? (
        <SummaryPanel meeting={meeting} onSaved={refetch} />
      ) : null}
      {hasContent ? <SpeakersPanel meetingId={id} stats={stats} colors={colors} onRenamed={onRenamed} /> : null}
      <TranscriptView
        segments={segments.segments}
        final={final}
        loaded={segments.loaded}
        error={segments.error}
        onRetry={segments.reload}
        live={live || (meeting.status === "processing" && !final)}
        emptyText={transcriptEmptyText(meeting)}
        statusLine={transcriptStatusLine(meeting, final)}
        labels={labels}
        colors={colors}
        activeSegmentId={activeSegmentId}
        onSeek={meeting.hasAudio ? onSeek : null}
        follow={follow}
        onFollowChange={setFollow}
        focusSegmentId={segmentId}
      />

      <ConfirmDialog
        open={confirm === "retranscribe"}
        onOpenChange={(open) => setConfirm(open ? "retranscribe" : null)}
        title="Повторить расшифровку?"
        description="Расшифровка будет построена заново из аудиозаписи: текущий текст заменится новым, это может занять несколько минут."
        confirmLabel="Расшифровать заново"
        pending={retranscribe.pending}
        error={retranscribe.error}
        onConfirm={() => void retranscribe.run()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => setConfirm(open ? "delete" : null)}
        title="Удалить встречу?"
        description={
          <>
            Запись, расшифровка и саммари встречи «{title}» будут удалены без возможности восстановления.
            {live ? " Бот покинет встречу." : ""}
          </>
        }
        confirmLabel="Удалить"
        destructive
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => void remove.run()}
      />
    </PageFrame>
  );
}
