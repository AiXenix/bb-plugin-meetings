// Rows and cards of the list page: live meetings, scheduled meetings,
// calendar events and past meetings.
import type { CalendarEventView, CalendarStatus, MeetingSummary } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { screenshotUrl } from "./constants";
import { formatDateTime, formatDuration, pluralRu } from "./format";
import { useAsyncAction } from "./hooks";
import { ERROR_TEXT, errorText, liveHint, speakingLabel } from "./labels";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { Chip, ElapsedClock, ErrorText, RecordingDot, Spinner, StatusChip } from "./ui";

export function meetingTitle(meeting: Pick<MeetingSummary, "title">): string {
  return meeting.title.trim() === "" ? "Встреча без названия" : meeting.title;
}

function speakersLine(meeting: MeetingSummary): string | null {
  if (meeting.speakers.length === 0) return null;
  const names = [...meeting.speakers].sort((a, b) => b.talkSec - a.talkSec).map((speaker) => speaker.label);
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} и ещё ${names.length - 3}` : shown;
}

export function LiveMeetingCard({
  meeting,
  nav,
  onChanged,
}: {
  meeting: MeetingSummary;
  nav: MeetingsNav;
  onChanged: () => void;
}) {
  const rpc = useMeetingsRpc();
  const stop = useAsyncAction(async () => {
    await rpc.call("meetings.stop", { id: meeting.id });
    onChanged();
  });
  const title = meetingTitle(meeting);
  const open = () => nav.toMeeting(meeting.id);
  const recording = meeting.status === "recording";
  const since = meeting.recordingStartedAt ?? meeting.joinedAt ?? meeting.startedAt ?? meeting.createdAt;
  const hint = liveHint(meeting) ?? meeting.statusDetail;
  const problem = meeting.errorCode === null ? null : ERROR_TEXT[meeting.errorCode];
  return (
    <article aria-label={title} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row">
      <button
        type="button"
        onClick={open}
        aria-label={`Открыть «${title}»`}
        className="relative flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-44"
      >
        {meeting.screenshotVersion === null ? (
          <Icon name="Mic" className="size-6 text-muted-foreground" aria-hidden />
        ) : (
          <img
            src={screenshotUrl(meeting.id, meeting.screenshotVersion)}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        )}
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          {recording ? <RecordingDot /> : null}
          <button
            type="button"
            onClick={open}
            className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {title}
          </button>
          <StatusChip meeting={meeting} />
        </div>
        {hint === null || hint === "" ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <dt>{recording ? "Запись" : "Прошло"}</dt>
            <dd>
              <ElapsedClock since={since} className="text-foreground" />
            </dd>
          </div>
          {meeting.participantsCount === null ? null : (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Участники</dt>
              <dd className="flex items-center gap-1">
                <Icon name="UserRound" className="size-3.5" aria-hidden />
                {meeting.participantsCount} {pluralRu(meeting.participantsCount, "участник", "участника", "участников")}
              </dd>
            </div>
          )}
          {recording ? (
            <div className="flex min-w-0 items-center gap-1">
              <dt>{speakingLabel(meeting.activeSpeakers.length)}:</dt>
              <dd className="truncate text-foreground">
                {meeting.activeSpeakers.length === 0 ? "—" : meeting.activeSpeakers.join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
        {problem === null ? null : <p className="text-xs text-warning-text">{problem}</p>}
        <ErrorText className="text-xs">{stop.error}</ErrorText>
      </div>
      <div className="flex shrink-0 items-start">
        <Button type="button" size="sm" variant="outline" disabled={stop.pending} onClick={() => void stop.run()}>
          {stop.pending ? <Spinner /> : <Icon name="Square" className="size-3.5" aria-hidden />}
          Остановить
        </Button>
      </div>
    </article>
  );
}

function SkipToggle({ event, onCalendar }: { event: CalendarEventView; onCalendar: (status: CalendarStatus) => void }) {
  const rpc = useMeetingsRpc();
  const toggle = useAsyncAction(async (skip: boolean) => {
    onCalendar(await rpc.call("calendar.setSkip", { key: event.key, skip }));
  });
  return (
    <span className="flex items-center gap-1.5">
      <Checkbox
        checked={event.skipped}
        disabled={toggle.pending}
        onCheckedChange={(checked) => void toggle.run(checked === true)}
        aria-label={`Пропустить «${event.title}»`}
      />
      <span className="text-xs text-muted-foreground" aria-hidden>
        Пропустить
      </span>
      {toggle.error === null ? null : (
        <span role="alert" className="text-xs text-destructive-text">
          {toggle.error}
        </span>
      )}
    </span>
  );
}

export function ScheduledRow({
  meeting,
  event,
  nav,
  onChanged,
  onCalendar,
}: {
  meeting: MeetingSummary;
  event: CalendarEventView | null;
  nav: MeetingsNav;
  onChanged: () => void;
  onCalendar: (status: CalendarStatus) => void;
}) {
  const rpc = useMeetingsRpc();
  const cancel = useAsyncAction(async () => {
    await rpc.call("meetings.cancel", { id: meeting.id });
    onChanged();
  });
  const title = meetingTitle(meeting);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
      <span className="w-full shrink-0 text-sm tabular-nums text-muted-foreground sm:w-36">
        {meeting.scheduledAt === null ? "—" : formatDateTime(meeting.scheduledAt)}
      </span>
      <button
        type="button"
        onClick={() => nav.toMeeting(meeting.id)}
        className="min-w-0 flex-1 basis-full truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none sm:basis-0"
      >
        {title}
      </button>
      {meeting.source === "calendar" ? (
        <Chip tone="neutral">
          <Icon name="Calendar" className="size-3" aria-hidden />
          календарь
        </Chip>
      ) : null}
      {event === null ? null : <SkipToggle event={event} onCalendar={onCalendar} />}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={cancel.pending}
        onClick={() => void cancel.run()}
        aria-label={`Отменить «${title}»`}
      >
        {cancel.pending ? <Spinner /> : null}
        Отменить
      </Button>
      <ErrorText className="w-full text-xs">{cancel.error}</ErrorText>
    </li>
  );
}

export function CalendarEventRow({
  event,
  nav,
  onCalendar,
}: {
  event: CalendarEventView;
  nav: MeetingsNav;
  onCalendar: (status: CalendarStatus) => void;
}) {
  const title = event.title.trim() === "" ? "Событие без названия" : event.title;
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5", event.skipped && "opacity-70")}>
      <span className="w-full shrink-0 text-sm tabular-nums text-muted-foreground sm:w-36">
        {formatDateTime(event.startsAt)}
      </span>
      <span className="min-w-0 flex-1 basis-full sm:basis-0">
        <span className={cn("block truncate text-sm text-foreground", event.skipped && "line-through")}>{title}</span>
        {event.url === null ? (
          <span className="block text-xs text-muted-foreground">Нет ссылки на Zoom — бот не подключится</span>
        ) : null}
      </span>
      <Chip tone="neutral">
        <Icon name="Calendar" className="size-3" aria-hidden />
        календарь
      </Chip>
      {event.url === null ? null : <SkipToggle event={event} onCalendar={onCalendar} />}
      {event.meetingId === null ? null : (
        <Button type="button" size="sm" variant="ghost" onClick={() => nav.toMeeting(event.meetingId!)}>
          Открыть
        </Button>
      )}
    </li>
  );
}

export function PastMeetingRow({ meeting, nav }: { meeting: MeetingSummary; nav: MeetingsNav }) {
  const title = meetingTitle(meeting);
  const when = meeting.startedAt ?? meeting.scheduledAt ?? meeting.createdAt;
  const speakers = speakersLine(meeting);
  const problem = errorText(meeting.errorCode, meeting.errorMessage);
  const transcriptProblem =
    meeting.transcriptStatus === "failed"
      ? `Расшифровка не удалась${meeting.transcriptError === null ? "" : `: ${meeting.transcriptError}`}`
      : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => nav.toMeeting(meeting.id)}
        className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none sm:flex-row sm:items-center sm:gap-3"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{formatDateTime(when)}</span>
            {meeting.durationSec > 0 ? <span>{formatDuration(meeting.durationSec)}</span> : null}
            {speakers === null ? null : <span className="min-w-0 truncate">{speakers}</span>}
          </span>
          {problem === null || meeting.status === "cancelled" ? null : (
            <span
              className={cn(
                "mt-0.5 block text-xs",
                meeting.status === "failed" ? "text-destructive-text" : "text-warning-text",
              )}
            >
              {problem}
            </span>
          )}
          {transcriptProblem === null ? null : (
            <span className="mt-0.5 block text-xs text-destructive-text">{transcriptProblem}</span>
          )}
        </span>
        <StatusChip meeting={meeting} className="self-start sm:self-center" />
      </button>
    </li>
  );
}
