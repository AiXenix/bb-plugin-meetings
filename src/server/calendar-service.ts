// Calendar auto-join wiring (docs/dev/DESIGN.md §10, §13): settings, the
// sync state in kv, scheduled meetings for occurrences, skip toggles. Sources
// are the ICS feeds and the watched Google calendars (google-service.ts); the
// parsing and the sync algorithm live in calendar.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseMeetingUrl } from "../shared/meeting-url.js";
import { CHANNEL_CALENDAR_CHANGED, type CalendarStatus } from "../shared/rpc-contract.js";
import { applyAutoJoin, feedId, isTwinOccurrence, syncCalendars, syncWindow, twinOccurrences, type CalendarSyncOptions } from "./calendar.js";
import { newMeetingId, type CalendarEventRow, type MeetingRow, type Repository } from "./db.js";
import { MeetingsError, errorMessage } from "./errors.js";
import { isGoogleFeed } from "./google-calendar.js";
import type { MeetingsService } from "./service.js";
import { calendarFeedUrls, type MeetingsSettings, type SettingsHandle } from "./settings.js";
import { describeStatus } from "./status.js";

const KV_SYNC = "calendar.sync";
const MAX_UPCOMING = 100;

interface SyncState {
  at: number;
  error: string | null;
}

export class CalendarService {
  private running: Promise<CalendarStatus> | null = null;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: SettingsHandle,
    private readonly repo: Repository,
    private readonly service: MeetingsService,
    private readonly fetchText: (url: string, signal?: AbortSignal) => Promise<string>,
  ) {}

  /** Feed ids whose occurrences count: the ICS feeds and the watched Google calendars. */
  private configuredFeeds(settings: MeetingsSettings): Set<string> {
    return new Set([...calendarFeedUrls(settings).map(feedId), ...this.service.google.feedIds()]);
  }

  async status(): Promise<CalendarStatus> {
    const settings = await this.settings.get();
    const feeds = this.configuredFeeds(settings);
    const state = (await this.bb.storage.kv.get<SyncState>(KV_SYNC)) ?? null;
    const window = syncWindow(this.service.now());
    const events = this.repo.calendarEventsBetween(window.from, window.to);
    const upcoming = events
      .filter((event) => event.status !== "cancelled" && feeds.has(event.feed))
      .slice(0, MAX_UPCOMING)
      .map((event) => {
        // The same meeting in two watched calendars has one bot and one skip toggle (applyAutoJoin).
        const twins = events.filter((other) => isTwinOccurrence(event, other));
        return {
          key: event.key,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          url: event.url,
          skipped: event.skipped || twins.some((twin) => twin.skipped),
          meetingId: event.meetingId ?? twins.find((twin) => twin.meetingId !== null)?.meetingId ?? null,
        };
      });
    return {
      configured: feeds.size > 0 || this.service.google.connected(),
      autoJoin: settings.calendarAutoJoin,
      feeds: feeds.size,
      lastSyncAt: state?.at ?? null,
      lastError: state?.error ?? null,
      upcoming,
    };
  }

  /** How scheduled meetings are created, moved and cancelled for occurrences. */
  private actions(settings: MeetingsSettings): Pick<CalendarSyncOptions, "scheduleMeeting" | "rescheduleMeeting" | "cancelMeeting"> {
    const botName = settings.botName.trim().slice(0, 64) || "Notetaker";
    return {
      scheduleMeeting: (event: CalendarEventRow, scheduledAt: number) => {
        const parsed = parseMeetingUrl(event.url ?? "");
        const now = this.service.now();
        const row = this.repo.insertMeeting({
          id: newMeetingId(now),
          title: event.title.slice(0, 200),
          url: parsed.url,
          platform: parsed.platform,
          meetingNumber: parsed.meetingNumber,
          botName,
          source: "calendar",
          status: "scheduled",
          statusDetail: describeStatus("scheduled"),
          scheduledAt,
          createdAt: now,
          options: {},
          requestedByThreadId: null,
          notify: false,
          calendarKey: event.key,
        });
        this.service.publishMeeting(row.id);
        return row;
      },
      rescheduleMeeting: (meeting: MeetingRow, scheduledAt: number, title: string, url: string) => {
        const parsed = parseMeetingUrl(url);
        this.repo.updateMeeting(meeting.id, {
          scheduledAt,
          title: title.slice(0, 200),
          url: parsed.url,
          platform: parsed.platform,
          meetingNumber: parsed.meetingNumber,
        });
        this.service.publishMeeting(meeting.id);
      },
      cancelMeeting: (meeting: MeetingRow, reason: string) => this.cancelScheduled(meeting, reason),
    };
  }

  private cancelScheduled(meeting: MeetingRow, reason: string): void {
    this.repo.updateMeeting(meeting.id, { status: "cancelled", statusDetail: reason, endedAt: this.service.now() });
    this.service.publishMeeting(meeting.id);
  }

  /** Fetch the feeds and Google calendars now; concurrent callers share one run. */
  sync(signal?: AbortSignal): Promise<CalendarStatus> {
    if (this.running !== null) return this.running;
    const run = this.runSync(signal === undefined ? this.service.lifetime : AbortSignal.any([signal, this.service.lifetime]));
    this.running = run;
    void run
      .finally(() => {
        if (this.running === run) this.running = null;
      })
      .catch(() => undefined);
    return run;
  }

  /** Sync in the background soon: now, or right after the run in progress (which may use an old selection). */
  requestSync(): void {
    void (this.running ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.sync())
      .catch((error: unknown) => {
        if (!this.service.lifetime.aborted) this.bb.log.warn(`Calendar sync failed: ${errorMessage(error)}`);
      });
  }

  /** Resolves when no sync is running. */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running.catch(() => undefined);
  }

  private async runSync(signal?: AbortSignal): Promise<CalendarStatus> {
    const settings = await this.settings.get();
    const feeds = calendarFeedUrls(settings);
    const now = this.service.now();
    let error: string | null = null;
    const google = await this.service.google.prepareSync(signal);
    let googleFailures: string[] = [];
    if (feeds.length > 0 || google.sources.length > 0) {
      const result = await syncCalendars({
        repo: this.repo,
        now,
        feeds,
        sources: google.sources,
        autoJoin: settings.calendarAutoJoin,
        leadMinutes: settings.calendarLeadMinutes,
        filter: settings.calendarFilter,
        signal,
        fetchText: this.fetchText,
        ...this.actions(settings),
      });
      const icsErrors = result.failures.filter((failure) => !isGoogleFeed(failure.feed)).map((failure) => failure.error);
      googleFailures = result.failures.filter((failure) => isGoogleFeed(failure.feed)).map((failure) => failure.error);
      error = icsErrors.length > 0 ? icsErrors.join("; ") : null;
      if (error !== null) this.bb.log.warn(`Calendar sync: ${error}`);
      if (result.created.length > 0) this.service.wake();
    }
    // Calendars dropped from the watched set (gone from Google, or deselected while this sync ran): their bots go.
    const watched = new Set(this.service.google.feedIds());
    if (google.selectionChanged || google.sources.some((source) => !watched.has(source.feed))) this.reapply(settings);
    this.service.google.finishSync(google, googleFailures, now);
    await this.bb.storage.kv.set(KV_SYNC, { at: now, error } satisfies SyncState);
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    return this.status();
  }

  /**
   * Forget the occurrences of feeds starting with `prefix` (Google on
   * disconnect) and cancel their still-scheduled bots. Returns how many.
   */
  forgetFeeds(prefix: string, reason: string): number {
    let cancelled = 0;
    for (const meeting of this.repo.meetingsWithStatus(["scheduled"])) {
      if (meeting.source !== "calendar" || meeting.calendarKey === null) continue;
      const event = this.repo.calendarEvent(meeting.calendarKey);
      if (!(event?.feed ?? meeting.calendarKey).startsWith(prefix)) continue;
      this.cancelScheduled(meeting, reason);
      cancelled += 1;
    }
    this.repo.deleteCalendarEventsOfFeeds(prefix);
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    if (cancelled > 0) this.service.wake();
    return cancelled;
  }

  /**
   * Apply the current auto-join settings to the stored occurrences without
   * fetching: cancels bots of removed feeds, of a disabled auto-join or of a
   * stricter filter, moves them for a new lead time, schedules newly wanted ones.
   */
  reapply(settings: MeetingsSettings): void {
    const configured = this.configuredFeeds(settings);
    const now = this.service.now();
    const options = {
      repo: this.repo,
      now,
      autoJoin: settings.calendarAutoJoin,
      leadMinutes: settings.calendarLeadMinutes,
      filter: settings.calendarFilter,
      ...this.actions(settings),
    };
    let changed = false;
    for (const meeting of this.repo.meetingsWithStatus(["scheduled"])) {
      if (meeting.source !== "calendar" || meeting.calendarKey === null) continue;
      const event = this.repo.calendarEvent(meeting.calendarKey);
      if (event === null || !configured.has(event.feed)) {
        const reason =
          event === null
            ? "Событие удалено из календаря"
            : isGoogleFeed(event.feed)
              ? "Календарь Google больше не отслеживается"
              : "Календарь удалён из настроек";
        options.cancelMeeting(meeting, reason);
        changed = true;
      } else if (applyAutoJoin(event, options) !== null) {
        changed = true;
      }
    }
    const window = syncWindow(now);
    for (const event of this.repo.calendarEventsBetween(window.from, window.to)) {
      if (configured.has(event.feed) && applyAutoJoin(event, options) !== null) changed = true;
    }
    if (changed) {
      this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
      this.service.wake();
    }
  }

  /** settings.onChange: calendar settings take effect now, not at the next sync. */
  settingsChanged(next: MeetingsSettings, prev: MeetingsSettings): void {
    const feeds = calendarFeedUrls(next);
    const feedsChanged = feeds.join(" ") !== calendarFeedUrls(prev).join(" ");
    const changed =
      feedsChanged ||
      next.calendarAutoJoin !== prev.calendarAutoJoin ||
      next.calendarFilter !== prev.calendarFilter ||
      next.calendarLeadMinutes !== prev.calendarLeadMinutes;
    if (!changed) return;
    try {
      this.reapply(next);
      this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    } catch (error) {
      this.bb.log.warn(`Could not apply the calendar settings: ${errorMessage(error)}`);
    }
    const running = this.running;
    const fetchNew = feedsChanged && feeds.length > 0;
    if (running === null && !fetchNew) return;
    // A sync already running uses the old settings: apply the new ones once it is done (fetching new feeds).
    void (running ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (fetchNew) await this.sync();
        else this.reapply(await this.settings.get());
      })
      .catch((error: unknown) => {
        if (!this.service.lifetime.aborted) this.bb.log.warn(`Calendar sync failed: ${errorMessage(error)}`);
      });
  }

  /** Called by the scheduler: sync in the background every calendarSyncMinutes. */
  syncIfDue(signal?: AbortSignal): void {
    if (this.running !== null) return;
    void (async () => {
      const settings = await this.settings.get();
      if (calendarFeedUrls(settings).length === 0 && !this.service.google.connected()) return;
      const state = (await this.bb.storage.kv.get<SyncState>(KV_SYNC)) ?? null;
      if (state !== null && this.service.now() - state.at < settings.calendarSyncMinutes * 60_000) return;
      await this.sync(signal);
    })().catch((error: unknown) => {
      if (!signal?.aborted) this.bb.log.warn(`Calendar sync failed: ${errorMessage(error)}`);
    });
  }

  /** calendarAutoJoin; settings.onChange schedules or cancels the calendar bots right away. */
  async setAutoJoin(autoJoin: boolean): Promise<CalendarStatus> {
    await this.settings.experimental_set({ calendarAutoJoin: autoJoin });
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    return this.status();
  }

  async setSkip(key: string, skip: boolean): Promise<CalendarStatus> {
    if (this.repo.calendarEvent(key) === null) {
      throw new MeetingsError(
        "not_found",
        "Событие календаря не найдено",
        `Calendar event ${key} not found`,
        "List events with: bb meetings calendar",
      );
    }
    // The same meeting in another watched calendar is skipped (or joined again) with it.
    const group = [key, ...twinOccurrences(this.repo, this.repo.calendarEvent(key)!).map((twin) => twin.key)];
    for (const member of group) this.repo.setCalendarEventFields(member, { skipped: skip });
    const settings = await this.settings.get();
    const options = {
      repo: this.repo,
      now: this.service.now(),
      autoJoin: settings.calendarAutoJoin,
      leadMinutes: settings.calendarLeadMinutes,
      filter: settings.calendarFilter,
      ...this.actions(settings),
    };
    for (const member of group) {
      const event = this.repo.calendarEvent(member);
      if (event !== null) applyAutoJoin(event, options);
    }
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    this.service.wake();
    return this.status();
  }
}
