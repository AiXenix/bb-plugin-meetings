// MeetingsService: the server-side brain (docs/dev/DESIGN.md §7–§10). Owns
// the registry, talks to the host entry on the recording machine, maps runtime
// snapshots to statuses, ingests segments, notifies threads and runs the
// scheduler/reconcile loop. RPC, CLI, tools and HTTP are thin layers over it.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { MAX_SEGMENTS_PAGE, type EnvReport, type HostContract, type RuntimeSnapshot } from "../shared/contract.js";
import { MeetingUrlError, maskMeetingUrl, parseMeetingUrl, type ParsedMeetingUrl } from "../shared/meeting-url.js";
import {
  ACTIVE_STATUSES,
  CHANNEL_CALENDAR_CHANGED,
  CHANNEL_ENV_CHANGED,
  CHANNEL_MEETING_CHANGED,
  CHANNEL_MEETING_SEGMENTS,
  LIVE_STATUSES,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  TERMINAL_STATUSES,
  type LiveView,
  type MeetingDetail,
  type MeetingSource,
  type MeetingStatus,
  type MeetingSummary,
  type SearchHit,
  type SegmentView,
} from "../shared/rpc-contract.js";
import {
  CONTROL_ACTIONS,
  TERMINAL_BOT_PHASES,
  botConfigSchema,
  type BotConfig,
  type DiarizationMode,
  type Segment,
  type TranscriberConfig,
} from "../shared/runtime-files.js";
import { fetchIcs } from "./calendar.js";
import { CalendarService } from "./calendar-service.js";
import {
  ftsQuery,
  newMeetingId,
  speakerViews,
  speakersFromSegments,
  type MeetingPatch,
  type MeetingRow,
  type Repository,
  type SegmentRow,
} from "./db.js";
import { MeetingsError, errorMessage, notFound, sleep } from "./errors.js";
import type { FormatMeeting } from "./format.js";
import { notificationText } from "./notify.js";
import { parseSpeakerSelectors, type MeetingsSettings, type SettingsHandle } from "./settings.js";
import { describeStatus, mapRuntime, type MappedStatus } from "./status.js";
import { ZoomAccount } from "./zoom-account.js";

export type HostClient = ExperimentalHostClient<HostContract>;
type HostMethod = keyof HostContract & string;
type HostInput<M extends HostMethod> = z.input<HostContract[M]["input"]>;
type HostOutput<M extends HostMethod> = z.output<HostContract[M]["output"]>;

export const ACTIVE_POLL_MS = 2_000;
export const IDLE_POLL_MS = 15_000;
const ENV_CACHE_MS = 10_000;
/** Runtime pieces env.setup installs on its own, without sudo; a plugin update needs only these. */
const USER_LEVEL_ITEMS: ReadonlySet<string> = new Set(["runtime", "playwright", "uv", "venv", "sherpa-onnx", "vad-model", "speaker-model"]);
const AUTO_SETUP_WAIT_MS = 120_000;
const AUTO_SETUP_RETRY_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
/** A scheduled meeting this late is not started any more. */
const MISSED_AFTER_MS = 2 * 3600_000;
/** statusDetail of a due scheduled meeting held back by maxConcurrentBots. */
const WAITING_FOR_BOT = "Ждёт свободного бота";
const VIEWER_TTL_MS = 30_000;
const PRIMARY_HOST_CACHE_MS = 30_000;
const GIGAAM_CACHE_MS = 30_000;
/** A dead bot with a non-terminal state counts as crashed once seen this long (see StatusContext.botDeathConfirmed). */
const BOT_DEATH_CONFIRM_MS = 1_500;

export interface ServiceOptions {
  readonly now?: () => number;
  /** Poll interval while waiting for a join outcome. */
  readonly joinPollMs?: number;
  readonly fetchText?: (url: string, signal?: AbortSignal) => Promise<string>;
}

export interface JoinRequest {
  readonly url: string;
  readonly title?: string | null;
  readonly botName?: string | null;
  /** Epoch ms; null/undefined = now. */
  readonly scheduledAt?: number | null;
  readonly maxDurationMinutes?: number | null;
  readonly source: MeetingSource;
  readonly requestedByThreadId?: string | null;
  readonly notify?: boolean;
  readonly calendarKey?: string | null;
}

/** Outcomes meetings_join / `join --wait` report right away. */
const JOIN_OUTCOMES: ReadonlySet<MeetingStatus> = new Set([
  "recording",
  "waiting_room",
  "waiting_for_host",
  "processing",
  "done",
  "failed",
  "cancelled",
]);

export class MeetingsService {
  readonly now: () => number;
  private readonly joinPollMs: number;
  readonly zoom: ZoomAccount;
  readonly calendar: CalendarService;
  private envCache: { at: number; report: EnvReport } | null = null;
  private autoSetupAt = 0;
  private readonly locks = new Map<string, Promise<unknown>>();
  private startLock: Promise<unknown> = Promise.resolve();
  /** Meetings whose meeting.start call is in flight (their directory may not exist yet). */
  private readonly starting = new Set<string>();
  /** Settles once an in-flight start has recorded its outcome (a stop waits for it). */
  private readonly startSettled = new Map<string, Promise<void>>();
  /** Joins whose caller is waiting and reports a failure itself (no thread message). */
  private readonly quietFailures = new Set<string>();
  private wakeScheduler: (() => void) | null = null;
  private lastTickProblem: string | null = null;
  private lastSetupPhase: string | null = null;
  private primaryHost: { id: string; at: number } | null = null;
  private gigaamCache: { key: string; at: number; url: string | null } | null = null;
  /** Aborted on plugin dispose: cancels background work started outside the scheduler. */
  private readonly disposed = new AbortController();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: SettingsHandle,
    private readonly repo: Repository,
    private readonly host: HostClient,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.joinPollMs = options.joinPollMs ?? 2_000;
    this.zoom = new ZoomAccount(bb, settings, this);
    this.calendar = new CalendarService(bb, settings, repo, this, options.fetchText ?? fetchIcs);
  }

  // ---------- plumbing ----------

  async primaryHostId(): Promise<string> {
    const now = this.now();
    if (this.primaryHost !== null && now - this.primaryHost.at < PRIMARY_HOST_CACHE_MS) return this.primaryHost.id;
    const id = (await this.bb.sdk.system.config()).primaryHostId;
    if (id === null || id === undefined) {
      this.primaryHost = null;
      throw new MeetingsError(
        "no_primary_host",
        "К bb не подключена основная машина: записывать встречи негде",
        "No primary machine is connected to bb, so there is nowhere to record",
        "Start the bb daemon on the machine that should run the bots",
      );
    }
    this.primaryHost = { id, at: now };
    return id;
  }

  async call<M extends HostMethod>(
    method: M,
    input: HostInput<M>,
    options: { hostId?: string | null; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<HostOutput<M>> {
    const hostId = options.hostId ?? (await this.primaryHostId());
    return (await this.host.call(method, input as never, {
      hostId,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
    })) as HostOutput<M>;
  }

  publishMeeting(id: string): void {
    this.bb.realtime.publish(CHANNEL_MEETING_CHANGED, { id });
  }

  wake(): void {
    this.wakeScheduler?.();
  }

  /** Signal for background work that must stop when the plugin unloads. */
  get lifetime(): AbortSignal {
    return this.disposed.signal;
  }

  dispose(): void {
    this.disposed.abort();
    this.wakeScheduler?.();
  }

  /** Serialize work per meeting so the scheduler and handlers never interleave. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  private async withStartLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.startLock.catch(() => undefined).then(fn);
    this.startLock = run.catch(() => undefined);
    return run;
  }

  /** Mark a start in flight; the returned function settles it. */
  private trackStart(id: string): () => void {
    let resolve: () => void = () => undefined;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    this.startSettled.set(id, settled);
    return () => {
      if (this.startSettled.get(id) === settled) this.startSettled.delete(id);
      resolve();
    };
  }

  /** The row vanished (deleted) while the host was creating the meeting: remove what the host made. */
  private async discardRuntime(id: string, hostId: string | null): Promise<void> {
    try {
      await this.call("meeting.delete", { meetingId: id }, { hostId, timeoutMs: 30_000 });
      this.bb.log.info(`Meeting ${id} was deleted while its bot was starting; removed it from the host`);
    } catch (error) {
      this.bb.log.warn(`Could not remove the deleted meeting ${id} from the host: ${errorMessage(error)}`);
    }
  }

  requireMeeting(id: string): MeetingRow {
    const row = this.repo.getMeeting(id);
    if (row === null) throw notFound(id);
    return row;
  }

  // ---------- views ----------

  toSummary(row: MeetingRow): MeetingSummary {
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      platform: row.platform,
      meetingNumber: row.meetingNumber,
      botName: row.botName,
      source: row.source,
      status: row.status,
      statusDetail: row.statusDetail,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      endReason: row.endReason,
      scheduledAt: row.scheduledAt,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      joinedAt: row.joinedAt,
      recordingStartedAt: row.recordingStartedAt,
      endedAt: row.endedAt,
      durationSec: Math.round(row.durationSec * 10) / 10,
      transcriptStatus: row.transcriptStatus,
      transcriptProgress: row.transcriptProgress === null ? null : Math.round(row.transcriptProgress * 1000) / 1000,
      transcriptError: row.transcriptError,
      participantsCount: row.participantsCount,
      activeSpeakers: row.activeSpeakers,
      speakers: speakerViews(row.speakers, row.speakerNames),
      segmentsCount: row.segmentsCount,
      hasAudio: row.hasAudio,
      screenshotVersion: row.screenshotMtime,
      hasSummary: row.summaryMd !== null && row.summaryMd.trim() !== "",
      requestedByThreadId: row.requestedByThreadId,
    };
  }

  async toDetail(row: MeetingRow): Promise<MeetingDetail> {
    const settings = await this.settings.get();
    return {
      ...this.toSummary(row),
      participants: row.participants,
      summaryMd: row.summaryMd,
      speakerNames: row.speakerNames,
      maxDurationMinutes: row.options.maxDurationMinutes ?? settings.maxDurationMinutes,
      calendarEventKey: row.calendarKey,
    };
  }

  // ---------- list / get / segments ----------

  list(filter: "all" | "active" | "upcoming" | "past", limit: number, before: number | null): { meetings: MeetingSummary[]; nextBefore: number | null } {
    const statuses: readonly MeetingStatus[] | null =
      filter === "active"
        ? [...ACTIVE_STATUSES]
        : filter === "upcoming"
          ? ["scheduled"]
          : filter === "past"
            ? [...TERMINAL_STATUSES]
            : null;
    // A page may run a little over `limit`: it never splits meetings created in the same millisecond.
    const rows = this.repo.listMeetings({ statuses, before, limit });
    const last = rows.at(-1);
    return {
      meetings: rows.map((row) => this.toSummary(row)),
      nextBefore: rows.length >= limit && last !== undefined ? last.createdAt : null,
    };
  }

  /** The newest meetings with exactly this status. */
  listWithStatus(status: MeetingStatus, limit: number): MeetingRow[] {
    return this.repo.listMeetings({ statuses: [status], before: null, limit }).slice(0, limit);
  }

  /** Whether the requesting thread will get the end-of-meeting message (DESIGN §9). */
  async notifiesThread(row: MeetingRow): Promise<boolean> {
    if (row.requestedByThreadId === null || !row.notify) return false;
    return (await this.settings.get()).notifyThread;
  }

  segments(id: string, afterId: number, limit: number): { segments: SegmentView[]; final: boolean; lastId: number; total: number } {
    const row = this.requireMeeting(id);
    const rows = this.repo.segments(id, afterId, limit);
    const stats = this.repo.segmentStats(id);
    return {
      segments: rows.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        speakerKey: s.speakerKey,
        speaker: row.speakerNames[s.speakerKey] || s.speaker,
        source: s.source,
        text: s.text,
      })),
      final: row.transcriptFinal,
      lastId: rows.at(-1)?.id ?? afterId,
      total: stats.count,
    };
  }

  segmentCount(id: string): number {
    return this.repo.segmentStats(id).count;
  }

  /** Stored segments (transcriber labels; apply renames with format.withNames). */
  transcriptSegments(id: string, afterId = -1, limit = Number.MAX_SAFE_INTEGER): SegmentRow[] {
    this.requireMeeting(id);
    return this.repo.segments(id, afterId, limit);
  }

  /** Meeting facts for the transcript renderers; the link's passcode is masked. */
  formatMeta(row: MeetingRow): FormatMeeting {
    return {
      id: row.id,
      title: row.title,
      url: row.source === "import" ? null : maskMeetingUrl(row.url),
      startedAt: row.recordingStartedAt ?? row.joinedAt ?? row.startedAt,
      durationSec: row.durationSec,
      final: row.transcriptFinal,
      summaryMd: row.summaryMd,
    };
  }

  // ---------- join / start ----------

  async join(request: JoinRequest): Promise<MeetingRow> {
    let parsed: ParsedMeetingUrl;
    try {
      parsed = parseMeetingUrl(request.url);
    } catch (error) {
      if (error instanceof MeetingUrlError) {
        throw new MeetingsError("invalid_url", error.message, `Not a joinable Zoom link: ${error.message}`, "Pass a link like https://zoom.us/j/<number>?pwd=…");
      }
      throw error;
    }
    const settings = await this.settings.get();
    const now = this.now();
    const scheduledAt = request.scheduledAt ?? null;
    const future = scheduledAt !== null && scheduledAt > now + 5_000;
    const title = request.title?.trim() || defaultTitle(parsed, future ? scheduledAt : now);
    const botName = (request.botName?.trim() || settings.botName.trim() || "Notetaker").slice(0, 64);
    const base = {
      title: title.slice(0, 200),
      url: parsed.url,
      platform: parsed.platform,
      meetingNumber: parsed.meetingNumber,
      botName,
      source: request.source,
      createdAt: now,
      options: request.maxDurationMinutes ? { maxDurationMinutes: request.maxDurationMinutes } : {},
      requestedByThreadId: request.requestedByThreadId ?? null,
      notify: request.notify ?? true,
      calendarKey: request.calendarKey ?? null,
    };

    this.assertNotDuplicate(parsed, future ? scheduledAt : null);

    if (future) {
      const row = this.repo.insertMeeting({
        ...base,
        id: newMeetingId(now),
        status: "scheduled",
        statusDetail: describeStatus("scheduled"),
        scheduledAt,
      });
      this.publishMeeting(row.id);
      this.wake();
      return row;
    }

    const row = await this.withStartLock(async () => {
      this.assertCapacity(settings);
      await this.assertEnvReady();
      return this.repo.insertMeeting({
        ...base,
        id: newMeetingId(now),
        status: "starting",
        statusDetail: describeStatus("starting"),
        scheduledAt,
      });
    });
    this.publishMeeting(row.id);
    return this.startMeeting(row, { throwOnError: true });
  }

  /** One bot per meeting: refuse a second live bot, or a second schedule within 30 min of an existing one. */
  private assertNotDuplicate(parsed: ParsedMeetingUrl, scheduledAt: number | null): void {
    if (parsed.platform !== "zoom") return;
    if (scheduledAt === null) {
      const [live] = this.repo.meetingsOf(parsed.platform, parsed.meetingNumber, parsed.url, [...LIVE_STATUSES]);
      if (live !== undefined) {
        throw new MeetingsError(
          "duplicate_meeting",
          `Бот уже в этой встрече: ${live.id} («${live.title}»)`,
          `A bot is already in this meeting: ${live.id} ("${live.title}")`,
          `Follow it with: bb meetings show ${live.id}`,
        );
      }
    }
    const when = scheduledAt ?? this.now();
    const scheduled = this.repo
      .meetingsOf(parsed.platform, parsed.meetingNumber, parsed.url, ["scheduled"])
      .find((row) => row.scheduledAt !== null && Math.abs(row.scheduledAt - when) < 30 * 60_000);
    if (scheduled !== undefined) {
      throw new MeetingsError(
        "duplicate_meeting",
        `Эта встреча уже запланирована: ${scheduled.id} («${scheduled.title}»)`,
        `This meeting is already scheduled: ${scheduled.id} ("${scheduled.title}")`,
        `Cancel it first: bb meetings cancel ${scheduled.id}`,
      );
    }
  }

  private liveCount(): number {
    return this.repo.countWithStatus([...LIVE_STATUSES]);
  }

  private assertCapacity(settings: MeetingsSettings): void {
    const live = this.liveCount();
    if (live >= settings.maxConcurrentBots) {
      throw new MeetingsError(
        "too_many_bots",
        `Уже идёт ${live} записей — это лимит «Одновременных записей» (${settings.maxConcurrentBots}). Остановите одну из встреч или увеличьте лимит в настройках`,
        `${live} recordings are already running, the maxConcurrentBots limit is ${settings.maxConcurrentBots}`,
        "Stop one (bb meetings stop <id>) or raise it: bb plugin config meetings set maxConcurrentBots <n>",
      );
    }
  }

  /**
   * Each plugin version ships its own runtime directory, so after an update the
   * bot files (and maybe the venv or models) are missing. Install them without
   * asking when nothing else is missing: it needs no sudo and reuses downloads.
   */
  async autoSetup(report: EnvReport, wait: boolean, signal?: AbortSignal): Promise<EnvReport> {
    const missing = report.items.filter((item) => item.required && !item.ok && item.id !== "gigaam");
    if (missing.length === 0 || !missing.every((item) => USER_LEVEL_ITEMS.has(item.id))) return report;
    if (report.setup.phase !== "running") {
      if (this.now() - this.autoSetupAt < AUTO_SETUP_RETRY_MS) return report;
      this.autoSetupAt = this.now();
      this.bb.log.info(`Installing runtime pieces for this plugin version: ${missing.map((item) => item.id).join(", ")}`);
      report = await this.envSetup(false);
    }
    const deadline = this.now() + AUTO_SETUP_WAIT_MS;
    while (wait && report.setup.phase === "running" && this.now() < deadline) {
      await sleep(1_000, signal);
      report = await this.envReport(true);
    }
    return report;
  }

  private async assertEnvReady(): Promise<EnvReport> {
    const report = await this.autoSetup(await this.envReport(false), true);
    const missing = report.items.filter((item) => item.required && !item.ok && item.id !== "gigaam");
    if (missing.length > 0) {
      const names = missing.map((item) => item.label).join(", ");
      throw new MeetingsError(
        "dependency_missing",
        `Не хватает компонентов для записи: ${names}. Нажмите «Установить компоненты» на странице «Встречи» или выполните bb meetings setup`,
        `Missing runtime components: ${names}`,
        "Install them with: bb meetings setup (then check: bb meetings doctor)",
      );
    }
    return report;
  }

  transcriberConfig(settings: MeetingsSettings, gigaamUrl: string | null): TranscriberConfig {
    return {
      gigaamUrl,
      diarization: settings.diarization as DiarizationMode,
      speakerLagMs: clampInt(settings.speakerLagMs, 0, 5000),
      keepRawAudio: settings.keepRawAudio,
      threads: 0,
    };
  }

  /** GigaAM URL on the host (also refreshes <hostData>/gigaam.json for running transcribers); cached briefly. */
  private async discoverGigaam(settings: MeetingsSettings, hostId: string, signal?: AbortSignal): Promise<string | null> {
    const configuredUrl = settings.gigaamUrl.trim();
    const key = `${hostId}\n${configuredUrl}`;
    const now = this.now();
    if (this.gigaamCache !== null && this.gigaamCache.key === key && now - this.gigaamCache.at < GIGAAM_CACHE_MS) {
      return this.gigaamCache.url;
    }
    try {
      const status = await this.call("gigaam.discover", { configuredUrl }, { hostId, signal });
      this.gigaamCache = { key, at: now, url: status.url };
      return status.url;
    } catch (error) {
      this.bb.log.warn(`GigaAM discovery failed: ${errorMessage(error)}`);
      return settings.gigaamUrl.trim() || null;
    }
  }

  async resolveChromePath(settings: MeetingsSettings): Promise<string> {
    const configured = settings.chromePath.trim();
    if (configured !== "") return configured;
    const report = await this.envReport(false);
    if (report.chromePath === null || report.chromePath === "") {
      throw new MeetingsError(
        "dependency_missing",
        "Google Chrome не найден на машине записи. Установите компоненты (bb meetings setup) или укажите путь в настройке «Путь к Google Chrome»",
        "Google Chrome was not found on the recording machine",
        "Run bb meetings setup, or set it: bb plugin config meetings set chromePath /usr/bin/google-chrome-stable",
      );
    }
    return report.chromePath;
  }

  async buildBotConfig(row: MeetingRow, hostId: string, signal?: AbortSignal): Promise<BotConfig> {
    const settings = await this.settings.get();
    const parsed = parseMeetingUrl(row.url);
    const chromePath = await this.resolveChromePath(settings);
    const gigaamUrl = await this.discoverGigaam(settings, hostId, signal);
    let zoomProfileDir: string | null = null;
    if (settings.useZoomAccount && parsed.platform === "zoom") {
      try {
        const profile = await this.call("zoom.profile", { action: "status" }, { hostId, signal });
        if (profile.exists) zoomProfileDir = profile.path;
        else this.bb.log.warn("useZoomAccount is on but there is no signed-in Zoom profile; joining as a guest");
      } catch (error) {
        this.bb.log.warn(`Could not read the Zoom profile: ${errorMessage(error)}`);
      }
    }
    const maxDurationMinutes = row.options.maxDurationMinutes ?? settings.maxDurationMinutes;
    return botConfigSchema.parse({
      version: 1,
      meetingId: row.id,
      mode: "meeting",
      platform: parsed.platform,
      url: parsed.url,
      joinUrl: parsed.joinUrl,
      meetingNumber: parsed.meetingNumber,
      passcode: parsed.passcode,
      botName: row.botName,
      maxDurationSec: clampInt(maxDurationMinutes * 60, 60, 24 * 3600),
      aloneTimeoutSec: clampInt(settings.aloneTimeoutMinutes * 60, 10, 3600),
      waitingTimeoutSec: clampInt(settings.waitingTimeoutMinutes * 60, 30, 4 * 3600),
      silenceTimeoutSec: clampInt(settings.silenceTimeoutMinutes * 60, 0, 4 * 3600),
      screenshotIntervalSec: clampInt(settings.screenshotIntervalSec, 0, 300),
      chatAnnouncement: settings.chatAnnouncement.slice(0, 1000),
      speakerSelectors: parseSpeakerSelectors(settings.speakerSelectors),
      chromePath,
      zoomProfileDir,
      liveTranscription: settings.liveTranscription,
      transcriber: this.transcriberConfig(settings, gigaamUrl),
      createdAt: row.createdAt,
    } satisfies BotConfig);
  }

  /** Spawn the bot for a row that is already `starting` (or `scheduled`). */
  private async startMeeting(row: MeetingRow, options: { throwOnError: boolean; signal?: AbortSignal }): Promise<MeetingRow> {
    this.starting.add(row.id);
    const settle = this.trackStart(row.id);
    let hostId: string | null = null;
    // Deleted while starting (delete() skips the host then): remove what meeting.start created.
    const discarded = async (): Promise<MeetingRow> => {
      await this.discardRuntime(row.id, hostId);
      if (options.throwOnError) throw notFound(row.id);
      return row;
    };
    try {
      hostId = await this.primaryHostId();
      let current = this.repo.updateMeeting(
        row.id,
        { status: "starting", statusDetail: describeStatus("starting"), startedAt: this.now(), hostId },
        this.now(),
      );
      this.publishMeeting(row.id);
      const config = await this.buildBotConfig(current, hostId, options.signal);
      if (this.repo.getMeeting(row.id) === null) throw notFound(row.id); // deleted meanwhile: spawn nothing
      const snapshot = await this.call("meeting.start", { config }, { hostId, signal: options.signal, timeoutMs: START_TIMEOUT_MS });
      this.starting.delete(row.id);
      if (this.repo.getMeeting(row.id) === null) throw notFound(row.id); // cleaned up below
      current = await this.withLock(row.id, () => this.applySnapshot(this.requireMeeting(row.id), snapshot, options.signal));
      this.wake();
      return current;
    } catch (error) {
      this.starting.delete(row.id);
      if (this.repo.getMeeting(row.id) === null) return discarded();
      // Shutting down mid-start: the next load reconciles the row from the host.
      if (options.signal?.aborted) return this.repo.getMeeting(row.id) ?? row;
      const failure = error instanceof MeetingsError ? error : null;
      if (failure === null) {
        // A timeout or a lost connection does not mean the bot did not start.
        const started = await this.adoptIfStarted(row.id);
        if (started !== null) return started;
        if (this.repo.getMeeting(row.id) === null) return discarded();
      }
      const failed = this.repo.updateMeeting(row.id, {
        status: "failed",
        statusDetail: "Не удалось запустить бота",
        errorCode: failure?.code === "dependency_missing" ? "dependency_missing" : "unknown",
        errorMessage: `Не удалось запустить бота: ${errorMessage(error)}`,
        endedAt: this.now(),
      });
      this.publishMeeting(row.id);
      this.bb.log.warn(`Meeting ${row.id} failed to start: ${errorMessage(error)}`);
      // An interactive caller reports the error itself; don't message its thread again.
      if (options.throwOnError) this.repo.claimNotification(row.id, this.now());
      else await this.notify(failed);
      if (options.throwOnError) {
        if (error instanceof MeetingsError) throw error;
        throw new MeetingsError(
          "start_failed",
          `Не удалось запустить бота: ${errorMessage(error)}`,
          `Could not start the bot: ${errorMessage(error)}`,
          "Check the machine with: bb meetings doctor",
        );
      }
      return failed;
    } finally {
      this.starting.delete(row.id);
      settle();
    }
  }

  /** After a failed meeting.start call: if the bot runs anyway, keep following it. */
  private async adoptIfStarted(id: string): Promise<MeetingRow | null> {
    try {
      const row = this.requireMeeting(id);
      const { snapshots } = await this.call("meeting.status", { meetingIds: [id] }, { hostId: row.hostId, timeoutMs: 5_000 });
      const snapshot = snapshots.find((s) => s.meetingId === id);
      if (snapshot === undefined || !snapshot.exists || (!snapshot.botAlive && snapshot.bot === null)) return null;
      this.bb.log.warn(`meeting.start for ${id} failed, but the bot is running; following it`);
      return await this.withLock(id, () => this.applySnapshot(this.requireMeeting(id), snapshot));
    } catch {
      return null;
    }
  }

  /** Poll one meeting now (tools wait on this); returns the fresh row. */
  /** The bot's own phase and (English) detail right now, e.g. "Zoom shows a captcha…"; null when no bot runs. */
  async botState(id: string, signal?: AbortSignal): Promise<{ phase: string; detail: string; alive: boolean } | null> {
    const row = this.requireMeeting(id);
    if (!ACTIVE_STATUSES.has(row.status) || row.hostId === null) return null;
    const { snapshots } = await this.call("meeting.status", { meetingIds: [id] }, { hostId: row.hostId, signal });
    const bot = snapshots.find((s) => s.meetingId === id);
    return bot?.bot ? { phase: bot.bot.phase, detail: maskMeetingUrl(bot.bot.detail), alive: bot.botAlive } : null;
  }

  async refresh(id: string, signal?: AbortSignal): Promise<MeetingRow> {
    const row = this.requireMeeting(id);
    if (!ACTIVE_STATUSES.has(row.status) || this.starting.has(id)) return row;
    const { snapshots } = await this.call("meeting.status", { meetingIds: [id] }, { hostId: row.hostId, signal });
    const snapshot = snapshots.find((s) => s.meetingId === id);
    if (snapshot === undefined) return row;
    return this.withLock(id, () => this.applySnapshot(this.requireMeeting(id), snapshot, signal));
  }

  /**
   * Wait until the join has an outcome worth reporting, or the timeout. With
   * `reportsFailure` the caller tells the user about a failure itself, so the
   * thread notification for a failure seen during the wait is skipped.
   */
  async waitForJoin(id: string, timeoutMs: number, options: { signal?: AbortSignal; reportsFailure?: boolean } = {}): Promise<MeetingRow> {
    const { signal } = options;
    const deadline = this.now() + timeoutMs;
    if (options.reportsFailure) this.quietFailures.add(id);
    try {
      let row = this.requireMeeting(id);
      while (!signal?.aborted) {
        if (row.status === "scheduled" || JOIN_OUTCOMES.has(row.status)) return row;
        if (this.now() >= deadline) return row;
        await sleep(Math.min(this.joinPollMs, Math.max(0, deadline - this.now())), signal);
        try {
          row = await this.refresh(id, signal);
        } catch (error) {
          this.bb.log.warn(`Polling ${id} failed: ${errorMessage(error)}`);
          row = this.requireMeeting(id);
        }
      }
      return row;
    } finally {
      this.quietFailures.delete(id);
    }
  }

  // ---------- reconcile ----------

  /** Persist a snapshot: status, segments, transcriber respawn, notification. */
  private async applySnapshot(row: MeetingRow, snapshot: RuntimeSnapshot, signal?: AbortSignal): Promise<MeetingRow> {
    const before = JSON.stringify(this.toSummary(row));
    const now = this.now();
    // Count each failed transcriber run once (the host backs off between respawns). A run that is
    // gone without finishing failed too, even when it never wrote phase "failed" (SIGKILL, OOM, crash).
    let failures = row.transcriberFailures;
    let options = row.options;
    const transcriber = snapshot.transcriber;
    if (transcriber !== null && transcriber.phase !== "done" && !snapshot.transcriberAlive && options.lastFailedTranscriberStart !== transcriber.startedAt) {
      failures += 1;
      options = { ...options, lastFailedTranscriberStart: transcriber.startedAt };
      const reason = transcriber.phase === "failed" ? (transcriber.error ?? transcriber.detail) : `exited during ${transcriber.phase}`;
      this.bb.log.warn(`Transcriber of ${row.id} failed (${failures}): ${reason}`);
    }
    const mark = `${snapshot.transcriberAlive}:${transcriber?.startedAt ?? 0}:${transcriber?.phase ?? ""}:${transcriber?.processedSec ?? 0}`;
    if (options.transcriberMark !== mark) options = { ...options, transcriberMark: mark, transcriberMarkAt: now };
    const botDead = snapshot.bot !== null && !snapshot.botAlive && !TERMINAL_BOT_PHASES.has(snapshot.bot.phase);
    const deadSince = botDead ? (options.botDeadSince ?? now) : undefined;
    if (options.botDeadSince !== deadSince) options = { ...options, botDeadSince: deadSince };
    const mapped = mapRuntime(snapshot, {
      status: row.status,
      source: row.source,
      startedAt: row.startedAt,
      transcriberFailures: failures,
      transcriberProgressAt: options.transcriberMarkAt ?? now,
      botDeathConfirmed: deadSince !== undefined && now - deadSince >= BOT_DEATH_CONFIRM_MS,
      now,
    });

    let current = row;
    if (snapshot.exists && (snapshot.files.segments > 0 || snapshot.files.transcriptFinal)) {
      try {
        current = await this.ingestSegments(current, snapshot, signal);
      } catch (error) {
        this.bb.log.warn(`Could not load segments of ${row.id}: ${errorMessage(error)}`);
      }
    }

    const patch = statusPatch(current, mapped, now);
    if (failures !== row.transcriberFailures) patch.transcriberFailures = failures;
    if (options !== row.options) patch.options = { ...current.options, ...options };
    if (patch.status === "done" && !current.transcriptFinal) {
      patch.status = "processing";
      patch.statusDetail = "Загрузка транскрипта";
    }
    if (mapped.needsTranscriber && patch.status !== "failed") await this.ensureTranscriber(current, signal);
    // GigaAM may have restarted on another port: rediscovering rewrites <hostData>/gigaam.json,
    // which a waiting transcriber re-reads (both sides cache the lookup for 30 s).
    if (snapshot.transcriberAlive && transcriber?.phase === "waiting_asr") {
      try {
        await this.discoverGigaam(await this.settings.get(), row.hostId ?? (await this.primaryHostId()), signal);
      } catch (error) {
        this.bb.log.warn(`GigaAM rediscovery for ${row.id} failed: ${errorMessage(error)}`);
      }
    }
    const next = this.repo.updateMeeting(row.id, patch, now);
    if (JSON.stringify(this.toSummary(next)) !== before) this.publishMeeting(row.id);
    if (!TERMINAL_STATUSES.has(row.status) && (next.status === "done" || next.status === "failed")) {
      await this.notify(next);
    }
    return next;
  }

  /** Ask the host to (re)start the transcriber; it resumes live from the checkpoint and backs off by itself. */
  private async ensureTranscriber(row: MeetingRow, signal?: AbortSignal): Promise<void> {
    try {
      const settings = await this.settings.get();
      const hostId = row.hostId ?? (await this.primaryHostId());
      const gigaamUrl = await this.discoverGigaam(settings, hostId, signal);
      const after = await this.call(
        "meeting.ensureTranscriber",
        { meetingId: row.id, mode: "live", transcriber: this.transcriberConfig(settings, gigaamUrl) },
        { hostId, signal },
      );
      if (after.transcriberAlive) this.bb.log.info(`Started the transcriber for ${row.id}`);
    } catch (error) {
      this.bb.log.warn(`Could not start the transcriber for ${row.id}: ${errorMessage(error)}`);
    }
  }

  private async ingestSegments(row: MeetingRow, snapshot: RuntimeSnapshot, signal?: AbortSignal): Promise<MeetingRow> {
    if (row.transcriptFinal) return row;
    if (snapshot.files.transcriptFinal) return this.ingestFinal(row, signal);

    let stats = this.repo.segmentStats(row.id);
    if (snapshot.files.segments < stats.count) {
      // The transcriber resumed from a checkpoint and dropped lines: load the live segments again.
      this.repo.deleteSegments(row.id);
      stats = this.repo.segmentStats(row.id);
    }
    if (snapshot.files.segments <= stats.count) {
      return stats.count === row.segmentsCount ? row : this.storeSegmentStats(row);
    }
    const page = await this.call(
      "meeting.segments",
      { meetingId: row.id, afterId: stats.maxId, limit: MAX_SEGMENTS_PAGE },
      { hostId: row.hostId, signal },
    );
    if (page.final) return this.ingestFinal(row, signal);
    if (page.segments.length === 0) return row;
    this.repo.upsertSegments(row.id, page.segments, false);
    const next = this.storeSegmentStats(row);
    this.bb.realtime.publish(CHANNEL_MEETING_SEGMENTS, { id: row.id, lastId: page.lastId });
    return next;
  }

  private async ingestFinal(row: MeetingRow, signal?: AbortSignal): Promise<MeetingRow> {
    const all: Segment[] = [];
    let afterId = -1;
    for (let pageNo = 0; pageNo < 1000; pageNo += 1) {
      const page = await this.call(
        "meeting.segments",
        { meetingId: row.id, afterId, limit: MAX_SEGMENTS_PAGE },
        { hostId: row.hostId, signal, timeoutMs: 30_000 },
      );
      if (!page.final) return row; // not final after all; the next tick retries
      all.push(...page.segments);
      if (page.segments.length < MAX_SEGMENTS_PAGE || page.lastId <= afterId) break;
      afterId = page.lastId;
    }
    this.repo.replaceSegments(row.id, all, true);
    const next = this.repo.updateMeeting(row.id, {
      transcriptFinal: true,
      segmentsCount: all.length,
      speakers: speakersFromSegments(all),
    });
    this.bb.realtime.publish(CHANNEL_MEETING_SEGMENTS, { id: row.id, lastId: all.at(-1)?.id ?? -1 });
    return next;
  }

  private storeSegmentStats(row: MeetingRow): MeetingRow {
    const segments = this.repo.allSegments(row.id);
    return this.repo.updateMeeting(row.id, { segmentsCount: segments.length, speakers: speakersFromSegments(segments) });
  }

  /** Message the requesting thread once (DESIGN §9). */
  private async notify(row: MeetingRow): Promise<void> {
    if (row.requestedByThreadId === null || !row.notify) return;
    const settings = await this.settings.get();
    if (!settings.notifyThread) return;
    if (!this.repo.claimNotification(row.id, this.now())) return;
    // A tool call that is waiting on this join reports the failure in its own result.
    if (row.status === "failed" && this.quietFailures.has(row.id)) return;
    const text = notificationText(row, settings.autoSummaryPrompt);
    try {
      await this.bb.sdk.threads.send({
        threadId: row.requestedByThreadId,
        mode: "queue-if-active",
        input: [{ type: "text", text, mentions: [] }],
      });
    } catch (error) {
      this.bb.log.warn(`Could not notify thread ${row.requestedByThreadId} about ${row.id}: ${errorMessage(error)}`);
    }
  }

  /** Start scheduled meetings whose time has come (within the concurrency limit). */
  private async startDueMeetings(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const due = this.repo.meetingsWithStatus(["scheduled"]).filter((row) => (row.scheduledAt ?? 0) <= now);
    if (due.length === 0) return;
    const settings = await this.settings.get();
    // Calendar settings may have changed since the last sync (auto-join off, feed removed, filter).
    if (due.some((row) => row.source === "calendar")) {
      try {
        this.calendar.reapply(settings);
      } catch (error) {
        this.bb.log.warn(`Could not apply the calendar settings: ${errorMessage(error)}`);
      }
    }
    for (const listed of due.sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))) {
      if (signal?.aborted) return;
      const row = this.repo.getMeeting(listed.id);
      if (row === null || row.status !== "scheduled" || (row.scheduledAt ?? 0) > now) continue;
      if (now - (row.scheduledAt ?? now) > MISSED_AFTER_MS) {
        const waitedForBot = row.statusDetail?.startsWith(WAITING_FOR_BOT) ?? false;
        const missed = this.repo.updateMeeting(row.id, {
          status: "failed",
          statusDetail: "Пропущена",
          errorCode: "unknown",
          errorMessage: waitedForBot
            ? `Встреча пропущена: все боты были заняты другими встречами (лимит «Одновременных записей» — ${settings.maxConcurrentBots})`
            : "Встреча пропущена: в назначенное время bb не работал",
          endedAt: now,
        });
        this.publishMeeting(row.id);
        await this.notify(missed);
        continue;
      }
      const claimed = await this.withStartLock(async () => {
        const fresh = this.repo.getMeeting(row.id);
        if (fresh === null || fresh.status !== "scheduled") return null;
        if (this.liveCount() >= settings.maxConcurrentBots) {
          const detail = `${WAITING_FOR_BOT} (лимит ${settings.maxConcurrentBots})`;
          if (fresh.statusDetail !== detail) {
            this.repo.updateMeeting(row.id, { statusDetail: detail });
            this.publishMeeting(row.id);
          }
          return null;
        }
        return this.repo.updateMeeting(row.id, { status: "starting", statusDetail: describeStatus("starting") });
      });
      if (claimed !== null) await this.startMeeting(claimed, { throwOnError: false, signal });
    }
  }

  /** Poll all active meetings once; returns whether any are still active. */
  private async reconcileActive(signal?: AbortSignal): Promise<void> {
    const rows = this.repo.meetingsWithStatus([...ACTIVE_STATUSES]).filter((row) => !this.starting.has(row.id));
    if (rows.length === 0) return;
    const primary = await this.primaryHostId();
    const byHost = new Map<string, MeetingRow[]>();
    for (const row of rows) {
      const hostId = row.hostId ?? primary;
      byHost.set(hostId, [...(byHost.get(hostId) ?? []), row]);
    }
    for (const [hostId, hostRows] of byHost) {
      for (let index = 0; index < hostRows.length; index += 100) {
        const batch = hostRows.slice(index, index + 100);
        const { snapshots } = await this.call(
          "meeting.status",
          { meetingIds: batch.map((row) => row.id) },
          { hostId, signal },
        );
        const byId = new Map(snapshots.map((snapshot) => [snapshot.meetingId, snapshot]));
        for (const row of batch) {
          const snapshot = byId.get(row.id);
          if (snapshot === undefined || this.starting.has(row.id)) continue;
          await this.withLock(row.id, async () => {
            const fresh = this.repo.getMeeting(row.id);
            if (fresh === null || !ACTIVE_STATUSES.has(fresh.status)) return;
            await this.applySnapshot(fresh, snapshot, signal);
          });
        }
      }
    }
  }

  /** One scheduler pass. Returns the delay until the next one. */
  async tick(signal?: AbortSignal): Promise<number> {
    await this.startDueMeetings(signal);
    await this.reconcileActive(signal);
    let busy = this.repo.countWithStatus([...ACTIVE_STATUSES]) > 0;
    const signingIn = await this.zoom.active(signal).catch((error: unknown) => {
      this.bb.log.warn(`Zoom sign-in session check failed: ${errorMessage(error)}`);
      return false;
    });
    if (signingIn) busy = true;
    if (this.envCache?.report.setup.phase === "running" || this.lastSetupPhase === "running") {
      busy = true;
      await this.envReport(true).catch(() => undefined);
    }
    this.calendar.syncIfDue(signal);
    let delay = busy ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const now = this.now();
    for (const row of this.repo.meetingsWithStatus(["scheduled"])) {
      // Overdue ones (waiting for a free bot) are retried on every regular tick.
      if (row.scheduledAt !== null && row.scheduledAt > now) delay = Math.min(delay, Math.max(500, row.scheduledAt - now));
    }
    return delay;
  }

  /** The background `scheduler` service body: returns promptly after abort. */
  async runScheduler(signal: AbortSignal): Promise<void> {
    try {
      await this.autoSetup(await this.envReport(true), false, signal);
    } catch (error) {
      if (!signal.aborted) this.bb.log.warn(`Runtime check at startup failed: ${errorMessage(error)}`);
    }
    while (!signal.aborted) {
      let delay = IDLE_POLL_MS;
      try {
        delay = await this.tick(signal);
        this.lastTickProblem = null;
      } catch (error) {
        if (signal.aborted) break;
        const problem = errorMessage(error);
        if (problem !== this.lastTickProblem) this.bb.log.warn(`Reconcile failed: ${problem}`);
        this.lastTickProblem = problem;
      }
      await sleep(delay, signal, (wake) => {
        this.wakeScheduler = wake;
      });
      this.wakeScheduler = null;
    }
  }

  // ---------- user actions ----------

  async stop(id: string): Promise<MeetingRow> {
    let row = this.requireMeeting(id);
    if (row.status === "scheduled") return this.cancel(id);
    if (!LIVE_STATUSES.has(row.status)) return row;
    const starting = this.startSettled.get(id);
    if (starting !== undefined) {
      // The host may not have created the meeting yet, so it could not deliver the stop: wait for meeting.start.
      await starting;
      row = this.requireMeeting(id);
      if (!LIVE_STATUSES.has(row.status)) return row;
    }
    const snapshot = await this.call("meeting.stop", { meetingId: id }, { hostId: row.hostId, timeoutMs: 30_000 });
    const next = await this.withLock(id, () => this.applySnapshot(this.requireMeeting(id), snapshot));
    this.wake();
    return next;
  }

  cancel(id: string): MeetingRow {
    const row = this.requireMeeting(id);
    if (row.status !== "scheduled") {
      throw new MeetingsError(
        "not_scheduled",
        "Отменить можно только запланированную встречу. Чтобы бот вышел из идущей встречи, используйте «Остановить»",
        `Only scheduled meetings can be cancelled; ${id} is ${row.status}`,
        `Use: bb meetings stop ${id}`,
      );
    }
    if (row.calendarKey !== null) this.repo.setCalendarEventFields(row.calendarKey, { skipped: true });
    const next = this.repo.updateMeeting(id, { status: "cancelled", statusDetail: "Отменена", endedAt: this.now() });
    this.publishMeeting(id);
    if (row.calendarKey !== null) this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    return next;
  }

  async delete(id: string): Promise<boolean> {
    // Under the meeting's lock: an in-flight reconcile must not write segments for a deleted row.
    return this.withLock(id, async () => {
      const row = this.requireMeeting(id);
      // While meeting.start/import is in flight the host may not have the meeting yet;
      // the starter removes it from the host once that call returns and finds the row gone.
      if (!this.starting.has(id) && (row.startedAt !== null || row.hostId !== null)) {
        await this.call("meeting.delete", { meetingId: id }, { hostId: row.hostId, timeoutMs: 30_000 });
      }
      if (row.calendarKey !== null) this.repo.setCalendarEventFields(row.calendarKey, { skipped: true });
      const deleted = this.repo.deleteMeeting(id);
      this.publishMeeting(id);
      return deleted;
    });
  }

  async retranscribe(id: string): Promise<MeetingRow> {
    const row = this.requireMeeting(id);
    if (!TERMINAL_STATUSES.has(row.status) && row.status !== "processing") {
      throw new MeetingsError(
        "still_recording",
        "Встреча ещё идёт: распознать заново можно после окончания записи",
        `${id} is still ${row.status}; re-transcribe after the recording ends`,
      );
    }
    if (!row.hasAudio) {
      throw new MeetingsError("no_audio", "У этой встречи нет записи звука", `${id} has no recorded audio`);
    }
    const settings = await this.settings.get();
    const hostId = row.hostId ?? (await this.primaryHostId());
    const gigaamUrl = await this.discoverGigaam(settings, hostId);
    return this.withLock(id, async () => {
      await this.call(
        "meeting.ensureTranscriber",
        { meetingId: id, mode: "offline", transcriber: this.transcriberConfig(settings, gigaamUrl) },
        { hostId, timeoutMs: 30_000 },
      );
      this.repo.deleteSegments(id);
      const current = this.requireMeeting(id);
      // Acoustic clusters are renumbered by a new run (only ui: keys are stable, DESIGN §4.5).
      const speakerNames = Object.fromEntries(Object.entries(current.speakerNames).filter(([key]) => !key.startsWith("spk:")));
      const next = this.repo.updateMeeting(id, {
        status: "processing",
        statusDetail: "Распознавание заново",
        transcriptStatus: "finalizing",
        transcriptProgress: 0,
        transcriptError: null,
        transcriptFinal: false,
        transcriberFailures: 0,
        segmentsCount: 0,
        speakers: [],
        speakerNames,
        // The bot's own error comes back from state.json on the next poll; a transcription error must not stay.
        errorCode: null,
        errorMessage: null,
        // The thread was told about the failure: tell it the outcome of this run too.
        ...(current.status === "failed" ? { notifiedAt: null } : {}),
        hostId,
      });
      this.publishMeeting(id);
      this.bb.realtime.publish(CHANNEL_MEETING_SEGMENTS, { id, lastId: -1 });
      this.wake();
      return next;
    });
  }

  update(id: string, fields: { title?: string; summaryMd?: string | null }): MeetingRow {
    this.requireMeeting(id);
    const patch: MeetingPatch = {};
    if (fields.title !== undefined) {
      const title = fields.title.trim();
      if (title === "") throw new MeetingsError("invalid_title", "Название не может быть пустым", "The title cannot be empty");
      patch.title = title.slice(0, 200);
    }
    if (fields.summaryMd !== undefined) {
      patch.summaryMd = fields.summaryMd === null || fields.summaryMd.trim() === "" ? null : fields.summaryMd;
    }
    const next = this.repo.updateMeeting(id, patch);
    this.publishMeeting(id);
    return next;
  }

  /** Resolve a speaker key or a (current or original) label to the key. */
  resolveSpeakerKey(row: MeetingRow, keyOrLabel: string): string {
    const wanted = keyOrLabel.trim();
    if (row.speakers.some((s) => s.key === wanted)) return wanted;
    const lower = wanted.toLocaleLowerCase();
    const byLabel = row.speakers.filter(
      (s) => (row.speakerNames[s.key] ?? s.label).toLocaleLowerCase() === lower || s.label.toLocaleLowerCase() === lower,
    );
    if (byLabel.length === 1) return byLabel[0]!.key;
    if (wanted in row.speakerNames) return wanted;
    const known = row.speakers.map((s) => `${s.key} (${row.speakerNames[s.key] ?? s.label})`).join(", ") || "—";
    throw new MeetingsError(
      byLabel.length > 1 ? "ambiguous_speaker" : "unknown_speaker",
      `Спикер «${wanted}» не найден. Есть: ${known}`,
      `Speaker "${wanted}" ${byLabel.length > 1 ? "is ambiguous" : "not found"}. Speakers: ${known}`,
      "Pass the speaker key, e.g. spk:1 or ui:<name>",
    );
  }

  renameSpeaker(id: string, keyOrLabel: string, name: string): MeetingRow {
    const row = this.requireMeeting(id);
    const key = this.resolveSpeakerKey(row, keyOrLabel);
    const names = { ...row.speakerNames };
    const trimmed = name.trim().slice(0, 100);
    if (trimmed === "") delete names[key];
    else names[key] = trimmed;
    const next = this.repo.updateMeeting(id, { speakerNames: names });
    this.publishMeeting(id);
    this.bb.realtime.publish(CHANNEL_MEETING_SEGMENTS, { id, lastId: -1 });
    return next;
  }

  search(query: string, limit: number): SearchHit[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    return this.repo.search(match, limit, SNIPPET_OPEN, SNIPPET_CLOSE).map((hit) => {
      let names: Record<string, string> = {};
      try {
        names = JSON.parse(hit.speakerNamesJson) as Record<string, string>;
      } catch {
        names = {};
      }
      return {
        meetingId: hit.meetingId,
        meetingTitle: hit.meetingTitle,
        meetingDate: hit.meetingDate,
        segmentId: hit.segmentId,
        start: hit.start,
        speaker: names[hit.speakerKey] || hit.speaker,
        snippet: hit.snippet,
      };
    });
  }

  async logs(id: string, lines: number): Promise<string> {
    const row = this.requireMeeting(id);
    if (row.startedAt === null && row.hostId === null) return "";
    return (await this.call("meeting.logs", { meetingId: id, lines }, { hostId: row.hostId })).text;
  }

  async debugDump(id: string): Promise<boolean> {
    const row = this.requireMeeting(id);
    if (!LIVE_STATUSES.has(row.status)) return false;
    return (await this.call("meeting.debugDump", { meetingId: id }, { hostId: row.hostId })).requested;
  }

  async filePath(
    id: string,
    file: HostInput<"meeting.filePath">["file"],
  ): Promise<string | null> {
    const row = this.requireMeeting(id);
    if (row.startedAt === null && row.hostId === null) return null;
    return (await this.call("meeting.filePath", { meetingId: id, file }, { hostId: row.hostId })).path;
  }

  /** Host for a meeting id or the Zoom sign-in session id (live view, control, screenshots). */
  async hostForViewable(id: string): Promise<string> {
    const row = this.repo.getMeeting(id);
    if (row !== null) {
      if (row.hostId === null && row.startedAt === null) {
        throw new MeetingsError("not_started", "Бот для этой встречи ещё не запускался", `The bot for ${id} has not started yet`);
      }
      return row.hostId ?? (await this.primaryHostId());
    }
    const sessionHost = await this.zoom.sessionHost(id);
    if (sessionHost !== null) return sessionHost;
    throw notFound(id);
  }

  async liveView(id: string): Promise<LiveView> {
    const hostId = await this.hostForViewable(id);
    await this.call("meeting.viewer", { meetingId: id, untilMs: this.now() + VIEWER_TTL_MS }, { hostId });
    const { snapshots } = await this.call("meeting.status", { meetingIds: [id] }, { hostId });
    const snapshot = snapshots.find((s) => s.meetingId === id);
    if (snapshot === undefined || !snapshot.exists) {
      return { screenshotVersion: null, phase: null, detail: null, controllable: false };
    }
    const bot = snapshot.bot;
    return {
      screenshotVersion: snapshot.files.screenshotMtime,
      phase: bot?.phase ?? null,
      detail: bot?.detail ?? null,
      controllable: snapshot.botAlive && bot !== null && !TERMINAL_BOT_PHASES.has(bot.phase),
    };
  }

  async control(input: {
    id: string;
    action: (typeof CONTROL_ACTIONS)[number];
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    dy?: number;
  }): Promise<{ queued: boolean; seq: number }> {
    const hostId = await this.hostForViewable(input.id);
    const command: HostInput<"meeting.control"> = { meetingId: input.id, action: input.action };
    if (input.x !== undefined) command.x = input.x;
    if (input.y !== undefined) command.y = input.y;
    if (input.text !== undefined) command.text = input.text;
    if (input.key !== undefined) command.key = input.key;
    if (input.dy !== undefined) command.dy = input.dy;
    return this.call("meeting.control", command, { hostId });
  }

  // ---------- environment ----------

  async envReport(force: boolean): Promise<EnvReport> {
    const now = this.now();
    if (!force && this.envCache !== null && now - this.envCache.at < ENV_CACHE_MS) return this.envCache.report;
    const settings = await this.settings.get();
    const report = await this.call(
      "env.check",
      { chromePath: settings.chromePath.trim(), gigaamUrl: settings.gigaamUrl.trim() },
      { timeoutMs: 30_000 },
    );
    this.rememberEnv(report);
    return report;
  }

  private rememberEnv(report: EnvReport): void {
    const previous = this.envCache?.report;
    this.envCache = { at: this.now(), report };
    if (previous !== undefined && (previous.ready !== report.ready || previous.setup.phase !== report.setup.phase)) {
      this.bb.realtime.publish(CHANNEL_ENV_CHANGED, {});
    }
    this.lastSetupPhase = report.setup.phase;
  }

  async envStatus(): Promise<{ env: EnvReport | null; error: string | null }> {
    try {
      return { env: await this.envReport(false), error: null };
    } catch (error) {
      return { env: null, error: errorMessage(error) };
    }
  }

  async envSetup(force: boolean): Promise<EnvReport> {
    const settings = await this.settings.get();
    const report = await this.call(
      "env.setup",
      { force, chromePath: settings.chromePath.trim(), gigaamUrl: settings.gigaamUrl.trim() },
      { timeoutMs: 30_000 },
    );
    this.envCache = { at: this.now(), report };
    this.lastSetupPhase = report.setup.phase;
    this.bb.realtime.publish(CHANNEL_ENV_CHANGED, {});
    this.wake();
    return report;
  }

  // ---------- import ----------

  async importFile(sourcePath: string, title: string | null, requestedByThreadId: string | null): Promise<MeetingRow> {
    const path = sourcePath.trim();
    if (!path.startsWith("/")) {
      throw new MeetingsError("invalid_path", "Нужен абсолютный путь к файлу", "The file path must be absolute", "Pass /full/path/to/recording.mp4");
    }
    const settings = await this.settings.get();
    const hostId = await this.primaryHostId();
    const now = this.now();
    const fileName = path.split("/").pop() || "recording";
    const url = `file://${path}`;
    let row = this.repo.insertMeeting({
      id: newMeetingId(now),
      title: (title?.trim() || fileName.replace(/\.[^.]+$/, "") || `Запись ${formatShort(now)}`).slice(0, 200),
      url,
      platform: "zoom",
      meetingNumber: null,
      botName: settings.botName,
      source: "import",
      status: "processing",
      statusDetail: "Подготовка файла",
      scheduledAt: null,
      createdAt: now,
      options: { sourcePath: path },
      requestedByThreadId,
      notify: requestedByThreadId !== null,
      calendarKey: null,
    });
    row = this.repo.updateMeeting(row.id, { startedAt: now, hostId, transcriptStatus: "finalizing", transcriptProgress: 0 });
    this.publishMeeting(row.id);
    this.starting.add(row.id);
    try {
      const gigaamUrl = await this.discoverGigaam(settings, hostId);
      const config = botConfigSchema.parse({
        version: 1,
        meetingId: row.id,
        mode: "meeting",
        platform: "zoom",
        url,
        joinUrl: url,
        meetingNumber: null,
        passcode: null,
        botName: row.botName,
        maxDurationSec: 24 * 3600,
        aloneTimeoutSec: 3600,
        waitingTimeoutSec: 30,
        silenceTimeoutSec: 0,
        screenshotIntervalSec: 0,
        chatAnnouncement: "",
        speakerSelectors: null,
        chromePath: settings.chromePath.trim(),
        zoomProfileDir: null,
        liveTranscription: false,
        transcriber: this.transcriberConfig(settings, gigaamUrl),
        createdAt: now,
      } satisfies BotConfig);
      const snapshot = await this.call("meeting.import", { config, sourcePath: path }, { hostId, timeoutMs: 30 * 60_000 });
      this.starting.delete(row.id);
      row = await this.withLock(row.id, () => this.applySnapshot(this.requireMeeting(row.id), snapshot));
      this.wake();
      return row;
    } catch (error) {
      this.starting.delete(row.id);
      if (this.repo.getMeeting(row.id) === null) {
        // Deleted while importing (delete() skips the host then): drop the host's copy and its transcriber.
        await this.discardRuntime(row.id, hostId);
        throw notFound(row.id);
      }
      const failed = this.repo.updateMeeting(row.id, {
        status: "failed",
        statusDetail: "Не удалось импортировать файл",
        errorCode: "unknown",
        errorMessage: `Не удалось импортировать файл: ${errorMessage(error)}`,
        endedAt: this.now(),
      });
      this.publishMeeting(row.id);
      throw new MeetingsError("import_failed", failed.errorMessage ?? "", `Import failed: ${errorMessage(error)}`);
    } finally {
      this.starting.delete(row.id);
    }
  }
}

// ---------- helpers ----------

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatShort(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}.${get("month")} ${get("hour")}:${get("minute")}`;
}

export function defaultTitle(parsed: ParsedMeetingUrl, at: number): string {
  if (parsed.platform === "zoom" && parsed.meetingNumber !== null) return `Zoom ${parsed.meetingNumber}`;
  return `Встреча ${formatShort(at)}`;
}

/** The row fields a mapped snapshot changes; earlier facts survive when the snapshot lacks them. */
function statusPatch(row: MeetingRow, mapped: MappedStatus, now: number): MeetingPatch {
  return {
    status: mapped.status,
    statusDetail: mapped.statusDetail,
    transcriptStatus: row.transcriptFinal ? "done" : mapped.transcriptStatus,
    transcriptProgress: mapped.transcriptProgress,
    transcriptError: mapped.transcriptError,
    errorCode: mapped.errorCode ?? row.errorCode,
    errorMessage: mapped.errorMessage ?? row.errorMessage,
    endReason: mapped.endReason ?? row.endReason,
    joinedAt: mapped.joinedAt ?? row.joinedAt,
    recordingStartedAt: mapped.recordingStartedAt ?? row.recordingStartedAt,
    endedAt: mapped.endedAt ?? row.endedAt ?? (TERMINAL_STATUSES.has(mapped.status) ? now : null),
    durationSec: mapped.durationSec !== null && mapped.durationSec > 0 ? mapped.durationSec : row.durationSec,
    participantsCount: mapped.participantsCount ?? row.participantsCount,
    participants: mapped.participants ?? row.participants,
    activeSpeakers: mapped.status === "recording" ? mapped.activeSpeakers : [],
    hasAudio: mapped.hasAudio || row.hasAudio,
    screenshotMtime: mapped.screenshotMtime ?? row.screenshotMtime,
  };
}
