// Calendar auto-join wiring (docs/dev/DESIGN.md §10): settings, the sync
// state in kv, scheduled meetings for occurrences, skip toggles. The parsing
// and the sync algorithm live in calendar.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseMeetingUrl } from "../shared/meeting-url.js";
import { CHANNEL_CALENDAR_CHANGED, type CalendarStatus } from "../shared/rpc-contract.js";
import { applyAutoJoin, feedId, syncCalendars, syncWindow, type CalendarSyncOptions } from "./calendar.js";
import { newMeetingId, type CalendarEventRow, type MeetingRow, type Repository } from "./db.js";
import { MeetingsError, errorMessage } from "./errors.js";
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

  async status(): Promise<CalendarStatus> {
    const settings = await this.settings.get();
    const feeds = calendarFeedUrls(settings).map(feedId);
    const state = (await this.bb.storage.kv.get<SyncState>(KV_SYNC)) ?? null;
    const window = syncWindow(this.service.now());
    const upcoming = this.repo
      .calendarEventsBetween(window.from, window.to)
      .filter((event) => event.status !== "cancelled" && feeds.includes(event.feed))
      .slice(0, MAX_UPCOMING)
      .map((event) => ({
        key: event.key,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        url: event.url,
        skipped: event.skipped,
        meetingId: event.meetingId,
      }));
    return {
      configured: feeds.length > 0,
      autoJoin: settings.calendarAutoJoin,
      feeds: feeds.length,
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
      cancelMeeting: (meeting: MeetingRow, reason: string) => {
        this.repo.updateMeeting(meeting.id, { status: "cancelled", statusDetail: reason, endedAt: this.service.now() });
        this.service.publishMeeting(meeting.id);
      },
    };
  }

  /** Fetch the feeds now; concurrent callers share one run. */
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

  private async runSync(signal?: AbortSignal): Promise<CalendarStatus> {
    const settings = await this.settings.get();
    const feeds = calendarFeedUrls(settings);
    const now = this.service.now();
    let error: string | null = null;
    if (feeds.length > 0) {
      const result = await syncCalendars({
        repo: this.repo,
        now,
        feeds,
        autoJoin: settings.calendarAutoJoin,
        leadMinutes: settings.calendarLeadMinutes,
        filter: settings.calendarFilter,
        signal,
        fetchText: this.fetchText,
        ...this.actions(settings),
      });
      error = result.errors.length > 0 ? result.errors.join("; ") : null;
      if (error !== null) this.bb.log.warn(`Calendar sync: ${error}`);
      if (result.created.length > 0) this.service.wake();
    }
    await this.bb.storage.kv.set(KV_SYNC, { at: now, error } satisfies SyncState);
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    return this.status();
  }

  /**
   * Apply the current auto-join settings to the stored occurrences without
   * fetching: cancels bots of removed feeds, of a disabled auto-join or of a
   * stricter filter, moves them for a new lead time, schedules newly wanted ones.
   */
  reapply(settings: MeetingsSettings): void {
    const configured = new Set(calendarFeedUrls(settings).map(feedId));
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
        options.cancelMeeting(meeting, event === null ? "Событие удалено из календаря" : "Календарь удалён из настроек");
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
      if (calendarFeedUrls(settings).length === 0) return;
      const state = (await this.bb.storage.kv.get<SyncState>(KV_SYNC)) ?? null;
      if (state !== null && this.service.now() - state.at < settings.calendarSyncMinutes * 60_000) return;
      await this.sync(signal);
    })().catch((error: unknown) => {
      if (!signal?.aborted) this.bb.log.warn(`Calendar sync failed: ${errorMessage(error)}`);
    });
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
    this.repo.setCalendarEventFields(key, { skipped: skip });
    const settings = await this.settings.get();
    applyAutoJoin(this.repo.calendarEvent(key)!, {
      repo: this.repo,
      now: this.service.now(),
      autoJoin: settings.calendarAutoJoin,
      leadMinutes: settings.calendarLeadMinutes,
      filter: settings.calendarFilter,
      ...this.actions(settings),
    });
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    this.service.wake();
    return this.status();
  }
}
