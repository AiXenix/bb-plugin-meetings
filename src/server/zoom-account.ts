// The bot's optional Zoom account (docs/dev/DESIGN.md §6.6): a "login" bot
// run opens zoom.us/signin in the persistent profile and a human signs in
// through the live view. The running session lives in kv; the profile on the host.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNEL_ZOOM_CHANGED, type ZoomStatus } from "../shared/rpc-contract.js";
import { TERMINAL_BOT_PHASES, botConfigSchema, type BotConfig } from "../shared/runtime-files.js";
import { newMeetingId } from "./db.js";
import { errorMessage } from "./errors.js";
import type { MeetingsService } from "./service.js";
import type { SettingsHandle } from "./settings.js";

const SIGNIN_URL = "https://zoom.us/signin";
const KV_SESSION = "zoom.session";
/** The bot ends a login run by itself after 15 minutes. */
const LOGIN_MAX_SEC = 15 * 60;
/** Keep a finished session's outcome visible this long, then delete its directory. */
const KEEP_FINISHED_MS = 10 * 60_000;
const START_GRACE_MS = 60_000;

interface ZoomSession {
  id: string;
  hostId: string;
  startedAt: number;
  finishedAt: number | null;
  phase: string;
  detail: string;
  error: string | null;
}

export class ZoomAccount {
  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: SettingsHandle,
    private readonly service: MeetingsService,
  ) {}

  private async stored(): Promise<ZoomSession | null> {
    return (await this.bb.storage.kv.get<ZoomSession>(KV_SESSION)) ?? null;
  }

  private changed(): void {
    this.bb.realtime.publish(CHANNEL_ZOOM_CHANGED, {});
  }

  /** The host of the sign-in session with this id, or null when `id` is not the session. */
  async sessionHost(id: string): Promise<string | null> {
    const session = await this.stored();
    return session !== null && session.id === id ? session.hostId : null;
  }

  /** Re-read the session from the host; returns it, or null when there is none. */
  async refresh(signal?: AbortSignal): Promise<ZoomSession | null> {
    const session = await this.stored();
    if (session === null) return null;
    const now = this.service.now();
    if (session.finishedAt !== null) {
      if (now - session.finishedAt <= KEEP_FINISHED_MS) return session;
      await this.bb.storage.kv.delete(KV_SESSION);
      await this.service.call("meeting.delete", { meetingId: session.id }, { hostId: session.hostId, signal }).catch(() => undefined);
      this.changed();
      return null;
    }
    const { snapshots } = await this.service.call("meeting.status", { meetingIds: [session.id] }, { hostId: session.hostId, signal });
    const snapshot = snapshots.find((s) => s.meetingId === session.id);
    const bot = snapshot?.bot ?? null;
    const next: ZoomSession = { ...session };
    if (snapshot === undefined || !snapshot.exists) {
      next.phase = "failed";
      next.detail = "Сеанс входа пропал с машины";
      next.finishedAt = now;
    } else if (bot === null) {
      const starting = snapshot.botAlive || now - session.startedAt < START_GRACE_MS;
      next.phase = starting ? "starting" : "failed";
      next.detail = starting ? "Запуск браузера" : "Браузер не запустился";
      if (!starting) next.finishedAt = now;
    } else {
      next.phase = bot.phase;
      next.detail = bot.detail;
      next.error = bot.error?.message ?? null;
      if (!TERMINAL_BOT_PHASES.has(bot.phase) && !snapshot.botAlive) {
        // The browser died without a final state: show the session as failed, not running.
        next.phase = "failed";
        next.detail = "Браузер сеанса входа закрылся";
      }
      if (TERMINAL_BOT_PHASES.has(bot.phase) || !snapshot.botAlive) next.finishedAt = now;
    }
    if (JSON.stringify(next) !== JSON.stringify(session)) {
      await this.bb.storage.kv.set(KV_SESSION, next);
      this.changed();
    }
    return next;
  }

  /** A session is running (the scheduler polls faster meanwhile). */
  async active(signal?: AbortSignal): Promise<boolean> {
    const session = await this.refresh(signal);
    return session !== null && session.finishedAt === null;
  }

  async status(): Promise<ZoomStatus> {
    const settings = await this.settings.get();
    let profile: ZoomStatus["profile"] = { exists: false, signedIn: false, updatedAt: null };
    try {
      const result = await this.service.call("zoom.profile", { action: "status" });
      profile = { exists: result.exists, signedIn: result.signedIn, updatedAt: result.updatedAt };
    } catch (error) {
      this.bb.log.warn(`Could not read the Zoom profile: ${errorMessage(error)}`);
    }
    const session = await this.refresh().catch(() => null);
    return {
      useZoomAccount: settings.useZoomAccount,
      profile,
      session: session === null ? null : { id: session.id, phase: session.phase, detail: session.detail, error: session.error },
    };
  }

  async loginStart(): Promise<ZoomStatus> {
    const existing = await this.refresh();
    if (existing !== null && existing.finishedAt === null) return this.status();
    if (existing !== null) {
      await this.bb.storage.kv.delete(KV_SESSION);
      await this.service.call("meeting.delete", { meetingId: existing.id }, { hostId: existing.hostId }).catch(() => undefined);
    }
    const settings = await this.settings.get();
    const hostId = await this.service.primaryHostId();
    const profile = await this.service.call("zoom.profile", { action: "status" }, { hostId });
    const chromePath = await this.service.resolveChromePath(settings);
    const now = this.service.now();
    const id = newMeetingId(now);
    const config = botConfigSchema.parse({
      version: 1,
      meetingId: id,
      mode: "login",
      platform: "zoom",
      url: SIGNIN_URL,
      joinUrl: SIGNIN_URL,
      meetingNumber: null,
      passcode: null,
      botName: settings.botName.trim().slice(0, 64) || "Notetaker",
      maxDurationSec: LOGIN_MAX_SEC,
      aloneTimeoutSec: 3600,
      waitingTimeoutSec: LOGIN_MAX_SEC,
      silenceTimeoutSec: 0,
      screenshotIntervalSec: 1,
      chatAnnouncement: "",
      speakerSelectors: null,
      chromePath,
      zoomProfileDir: profile.path,
      liveTranscription: false,
      transcriber: this.service.transcriberConfig(settings, null),
      createdAt: now,
    } satisfies BotConfig);
    await this.service.call("meeting.start", { config }, { hostId, timeoutMs: 60_000 });
    await this.bb.storage.kv.set(KV_SESSION, {
      id,
      hostId,
      startedAt: now,
      finishedAt: null,
      phase: "starting",
      detail: "Запуск браузера",
      error: null,
    } satisfies ZoomSession);
    this.changed();
    this.service.wake();
    return this.status();
  }

  /** The human is done: the bot saves the profile and exits. */
  async loginFinish(): Promise<ZoomStatus> {
    const session = await this.refresh();
    if (session !== null && session.finishedAt === null) {
      await this.service.call("meeting.control", { meetingId: session.id, action: "done" }, { hostId: session.hostId });
      this.service.wake();
    }
    return this.status();
  }

  async logout(): Promise<ZoomStatus> {
    const session = await this.stored();
    if (session !== null) {
      if (session.finishedAt === null) {
        await this.service.call("meeting.stop", { meetingId: session.id }, { hostId: session.hostId }).catch(() => undefined);
      }
      await this.service.call("meeting.delete", { meetingId: session.id }, { hostId: session.hostId }).catch(() => undefined);
      await this.bb.storage.kv.delete(KV_SESSION);
    }
    await this.service.call("zoom.profile", { action: "delete" });
    this.changed();
    return this.status();
  }
}
