// The Meetings list page: join form, environment banner, global search,
// "Сейчас" / "Запланированные" / "Прошедшие" and the Zoom account card.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { CalendarEventView, CalendarStatus, MeetingSummary } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  CHANNEL_CALENDAR_CHANGED,
  CHANNEL_MEETING_CHANGED,
  CHANNEL_MEETING_SEGMENTS,
  LIVE_STATUSES,
  PAST_PAGE_SIZE,
} from "./constants";
import { EnvBanner, useEnvStatus } from "./env-banner";
import { formatDateTime } from "./format";
import { useAsyncAction, useDebouncedCallback, useInterval, useMountedRef, useOnReconnect } from "./hooks";
import { JoinForm } from "./join-form";
import { CalendarEventRow, LiveMeetingCard, PastMeetingRow, ScheduledRow } from "./meeting-cards";
import { messageOf, useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { SearchPanel } from "./search-panel";
import { EmptyState, ErrorText, PageFrame, Section, Spinner } from "./ui";
import { ZoomAccountCard } from "./zoom-card";

interface ListState {
  active: MeetingSummary[];
  upcoming: MeetingSummary[];
  past: MeetingSummary[];
  /** Cursor for "Показать ещё"; null = no more pages. */
  pastNext: number | null;
  /** More than the first page of past meetings is loaded. */
  extraPages: boolean;
}

/** Keep pages loaded with "Показать ещё" when the first page is refreshed. */
function mergeFirstPage(prev: ListState, firstPage: MeetingSummary[], firstNext: number | null) {
  if (!prev.extraPages || firstNext === null || firstPage.length === 0) {
    return { past: firstPage, pastNext: firstNext, extraPages: false };
  }
  const oldest = Math.min(...firstPage.map((meeting) => meeting.createdAt));
  const ids = new Set(firstPage.map((meeting) => meeting.id));
  const older = prev.past.filter((meeting) => meeting.createdAt < oldest && !ids.has(meeting.id));
  return { past: firstPage.concat(older), pastNext: prev.pastNext, extraPages: older.length > 0 };
}

function useMeetingLists() {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [state, setState] = useState<ListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const refetch = useCallback(() => {
    const seq = ++sequence.current;
    Promise.all([
      rpc.call("meetings.list", { filter: "active", limit: 200, before: null }),
      rpc.call("meetings.list", { filter: "upcoming", limit: 200, before: null }),
      rpc.call("meetings.list", { filter: "past", limit: PAST_PAGE_SIZE, before: null }),
    ]).then(
      ([active, upcoming, past]) => {
        if (!mounted.current || seq !== sequence.current) return;
        setError(null);
        setState((prev) => ({
          active: active.meetings,
          upcoming: upcoming.meetings,
          ...(prev === null
            ? { past: past.meetings, pastNext: past.nextBefore, extraPages: false }
            : mergeFirstPage(prev, past.meetings, past.nextBefore)),
        }));
      },
      (cause: unknown) => {
        if (mounted.current && seq === sequence.current) setError(messageOf(cause));
      },
    );
  }, [rpc, mounted]);

  const loadMore = useAsyncAction(async () => {
    const before = state?.pastNext ?? null;
    if (before === null) return;
    const page = await rpc.call("meetings.list", { filter: "past", limit: PAST_PAGE_SIZE, before });
    if (!mounted.current) return;
    setState((prev) => {
      if (prev === null) return prev;
      const ids = new Set(prev.past.map((meeting) => meeting.id));
      return {
        ...prev,
        past: prev.past.concat(page.meetings.filter((meeting) => !ids.has(meeting.id))),
        pastNext: page.nextBefore,
        extraPages: true,
      };
    });
  });

  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  const debouncedSlow = useDebouncedCallback(refetch, 1500);
  useRealtime(CHANNEL_MEETING_CHANGED, debounced);
  useRealtime(CHANNEL_MEETING_SEGMENTS, debouncedSlow);
  useOnReconnect(refetch);
  const anyActive = (state?.active.length ?? 0) > 0;
  useInterval(refetch, anyActive ? 10_000 : null);
  return { state, error, refetch, loadMore };
}

function useCalendarStatus() {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("calendar.status").then(
      (result) => {
        if (!mounted.current) return;
        setCalendar(result);
        setError(null);
      },
      (cause: unknown) => {
        if (mounted.current) setError(messageOf(cause));
      },
    );
  }, [rpc, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  useRealtime(CHANNEL_CALENDAR_CHANGED, debounced);
  useOnReconnect(refetch);
  const sync = useAsyncAction(async () => {
    const result = await rpc.call("calendar.sync");
    if (mounted.current) setCalendar(result);
  });
  const update = useCallback(
    (next: CalendarStatus) => {
      if (mounted.current) setCalendar(next);
    },
    [mounted],
  );
  return { calendar, error, sync, update };
}

export function ListPage({ nav }: { nav: MeetingsNav }) {
  const env = useEnvStatus();
  const { state, error, refetch, loadMore } = useMeetingLists();
  const { calendar, error: calendarError, sync, update: setCalendar } = useCalendarStatus();

  const sections = useMemo(() => {
    if (state === null) return null;
    const live = state.active
      .filter((meeting) => LIVE_STATUSES.has(meeting.status))
      .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
    // Processing meetings are listed with the past ones, newest first, whichever filter returned them.
    const processing = state.active.filter((meeting) => !LIVE_STATUSES.has(meeting.status));
    const shown = new Set([...live, ...processing].map((meeting) => meeting.id));
    const past = processing
      .sort((a, b) => b.createdAt - a.createdAt)
      .concat(state.past.filter((meeting) => !shown.has(meeting.id) && meeting.status !== "scheduled"));
    const upcoming = [...state.upcoming].sort(
      (a, b) => (a.scheduledAt ?? a.createdAt) - (b.scheduledAt ?? b.createdAt),
    );
    return { live, past, upcoming };
  }, [state]);

  const calendarByMeeting = useMemo(() => {
    const map = new Map<string, CalendarEventView>();
    for (const event of calendar?.upcoming ?? []) if (event.meetingId !== null) map.set(event.meetingId, event);
    return map;
  }, [calendar]);
  // Scheduled meetings and calendar events in one timeline; an event that already has a
  // scheduled, live or past meeting is shown by that meeting instead.
  const upcomingRows = useMemo(() => {
    if (sections === null) return [];
    const known = new Set([...sections.upcoming, ...sections.live, ...sections.past].map((meeting) => meeting.id));
    const rows: Array<
      { kind: "meeting"; at: number; meeting: MeetingSummary } | { kind: "event"; at: number; event: CalendarEventView }
    > = sections.upcoming.map((meeting) => ({
      kind: "meeting" as const,
      at: meeting.scheduledAt ?? meeting.createdAt,
      meeting,
    }));
    for (const event of calendar?.upcoming ?? []) {
      if (event.meetingId === null || !known.has(event.meetingId))
        rows.push({ kind: "event", at: event.startsAt, event });
    }
    return rows.sort((a, b) => a.at - b.at);
  }, [sections, calendar]);

  const hasUpcoming = upcomingRows.length > 0;
  return (
    <PageFrame>
      <EnvBanner env={env} />
      <JoinForm nav={nav} onJoined={refetch} />
      <SearchPanel nav={nav} />

      {error === null ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ErrorText>Не удалось загрузить встречи: {error}</ErrorText>
          <Button type="button" variant="outline" size="sm" onClick={refetch}>
            Повторить
          </Button>
        </div>
      )}

      {sections === null ? (
        error === null ? (
          <EmptyState className="mt-6">
            <span className="inline-flex items-center gap-2">
              <Spinner /> Загружаем встречи…
            </span>
          </EmptyState>
        ) : null
      ) : (
        <>
          {sections.live.length === 0 ? null : (
            <Section title="Сейчас" count={sections.live.length}>
              <div className="space-y-2">
                {sections.live.map((meeting) => (
                  <LiveMeetingCard key={meeting.id} meeting={meeting} nav={nav} onChanged={refetch} />
                ))}
              </div>
            </Section>
          )}

          {hasUpcoming || calendar?.configured === true ? (
            <Section
              title="Запланированные"
              count={upcomingRows.length}
              actions={
                calendar?.configured === true ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={sync.pending}
                    onClick={() => void sync.run()}
                    aria-label="Синхронизировать календарь"
                  >
                    {sync.pending ? <Spinner /> : <Icon name="RotateCcw" className="size-3.5" aria-hidden />}
                    Календарь
                  </Button>
                ) : undefined
              }
            >
              {hasUpcoming ? (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {upcomingRows.map((row) =>
                    row.kind === "meeting" ? (
                      <ScheduledRow
                        key={row.meeting.id}
                        meeting={row.meeting}
                        event={calendarByMeeting.get(row.meeting.id) ?? null}
                        nav={nav}
                        onChanged={refetch}
                        onCalendar={setCalendar}
                      />
                    ) : (
                      <CalendarEventRow key={row.event.key} event={row.event} nav={nav} onCalendar={setCalendar} />
                    ),
                  )}
                </ul>
              ) : (
                <EmptyState>В ближайшие сутки в календаре нет встреч.</EmptyState>
              )}
              {calendar?.configured === true ? (
                <p className="mt-1.5 px-1 text-xs text-muted-foreground">
                  {calendar.autoJoin
                    ? "Автоподключение по календарю включено"
                    : "Автоподключение по календарю выключено"}
                  {calendar.lastSyncAt === null ? "" : ` · синхронизировано ${formatDateTime(calendar.lastSyncAt)}`}
                </p>
              ) : null}
              <ErrorText className="mt-1 text-xs">
                {calendar?.lastError == null ? null : `Календарь: ${calendar.lastError}`}
              </ErrorText>
              <ErrorText className="mt-1 text-xs">{sync.error ?? calendarError}</ErrorText>
            </Section>
          ) : null}

          <Section title="Прошедшие">
            {sections.past.length === 0 ? (
              <EmptyState>
                Записей пока нет. Вставьте ссылку на Zoom выше или попросите агента: «запиши встречу …».
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {sections.past.map((meeting) => (
                  <PastMeetingRow key={meeting.id} meeting={meeting} nav={nav} />
                ))}
              </ul>
            )}
            {state?.pastNext == null ? null : (
              <div className="mt-2 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loadMore.pending}
                  onClick={() => void loadMore.run()}
                >
                  {loadMore.pending ? <Spinner /> : null}
                  Показать ещё
                </Button>
              </div>
            )}
            <ErrorText className="mt-1 text-center text-xs">{loadMore.error}</ErrorText>
          </Section>
        </>
      )}

      <ZoomAccountCard nav={nav} />
    </PageFrame>
  );
}
