// Google Calendar connection (docs/dev/DESIGN.md §13): the OAuth client
// settings, consents in flight, tokens in the google_auth table, the watched
// calendars, and the Google part of the calendar sync (calendar-service.ts
// runs it together with the ICS feeds). Tokens and the client secret never
// leave the server: not over RPC, not in logs, not in error messages.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CHANNEL_CALENDAR_CHANGED,
  CHANNEL_GOOGLE_CHANGED,
  GOOGLE_CALLBACK_PATH,
  type GoogleStatus,
} from "../shared/rpc-contract.js";
import { syncWindow, type CalendarSource } from "./calendar.js";
import type { GoogleAuthRow, GoogleCalendarInfo, Repository } from "./db.js";
import { MeetingsError, errorMessage } from "./errors.js";
import {
  CALENDAR_SCOPE,
  ConsentStates,
  DEFAULT_GOOGLE_ENDPOINTS,
  GoogleOAuthError,
  REFRESH_SKEW_MS,
  authorizationUrl,
  exchangeCode,
  fetchUserEmail,
  idTokenEmail,
  redirectOrigin,
  refreshAccessToken,
  revokeToken,
  type GoogleEndpoints,
} from "./google-auth.js";
import {
  GOOGLE_FEED_PREFIX,
  GoogleApiError,
  GoogleAuthBrokenError,
  calendarApiGet,
  describeGoogleError,
  googleCalendarSource,
  googleFeedId,
  listCalendars,
  type GoogleGet,
} from "./google-calendar.js";
import type { MeetingsService } from "./service.js";
import type { MeetingsSettings, SettingsHandle } from "./settings.js";

export const GOOGLE_BROKEN_MESSAGE = "Доступ к Google отозван или истёк — подключите заново";
export const GOOGLE_CLIENT_CHANGED_MESSAGE = "Client ID изменён — подключите Google Календарь заново";
/** Stands for the account's primary calendar until calendarList names it. */
const PRIMARY = "primary";
const MAX_SELECTED = 50;
const MEETINGS_PAGE = "/plugins/meetings/meetings";

export interface GoogleCallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface GoogleCallbackOutcome {
  readonly ok: boolean;
  readonly title: string;
  readonly message: string;
  /** Where the page links back to (the Meetings page). */
  readonly backPath: string;
}

/** What a calendar sync fetches from Google this time. */
export interface GoogleSyncPlan {
  /** A connection exists, so this sync tried Google. */
  readonly attempted: boolean;
  readonly sources: CalendarSource[];
  /** Token refresh or calendarList failure. */
  readonly error: string | null;
  /** connectedAt of the connection the plan was made for (results of an older one are dropped). */
  readonly generation: number | null;
  /** The watched calendars changed (primary resolved, a calendar disappeared): bots of dropped ones must go. */
  readonly selectionChanged: boolean;
}

class GoogleNotConnectedError extends MeetingsError {
  constructor() {
    super(
      "google_not_connected",
      "Google Календарь не подключён",
      "Google Calendar is not connected",
      "Connect it on the Meetings page (Google Календарь → Подключить); it needs a browser",
    );
  }
}

export class GoogleService {
  /** Outcome of the latest consent started by this server (google.status.lastConsent). */
  private lastConsent: { at: number; ok: boolean; message: string } | null = null;

  private readonly consents: ConsentStates;
  private readonly endpoints: GoogleEndpoints;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly settings: SettingsHandle,
    private readonly repo: Repository,
    private readonly service: MeetingsService,
    endpoints: Partial<GoogleEndpoints> = {},
  ) {
    this.endpoints = { ...DEFAULT_GOOGLE_ENDPOINTS, ...endpoints };
    this.consents = new ConsentStates(() => this.service.now());
  }

  private changed(): void {
    this.bb.realtime.publish(CHANNEL_GOOGLE_CHANGED, {});
  }

  private async client(): Promise<{ clientId: string; clientSecret: string } | null> {
    const settings = await this.settings.get();
    const clientId = settings.googleClientId.trim();
    const clientSecret = (settings.googleClientSecret ?? "").trim();
    return clientId === "" || clientSecret === "" ? null : { clientId, clientSecret };
  }

  // ---------- state ----------

  /** A refresh token is stored (the connection works or may work). */
  connected(): boolean {
    return (this.repo.googleAuth()?.refreshToken ?? null) !== null;
  }

  /**
   * Feed ids of the watched calendars while a connection row exists, also a
   * broken one: their known events and bots are kept until the user
   * reconnects, changes the selection or disconnects.
   */
  feedIds(): string[] {
    const row = this.repo.googleAuth();
    return row === null ? [] : row.selectedCalendars.map(googleFeedId);
  }

  async status(): Promise<GoogleStatus> {
    const settings = await this.settings.get();
    const clientId = settings.googleClientId.trim();
    const row = this.repo.googleAuth();
    const connected = (row?.refreshToken ?? null) !== null;
    const selected = new Set(row?.selectedCalendars ?? []);
    const calendars =
      connected && row !== null
        ? row.calendars
            .map((calendar) => ({
              id: calendar.id,
              summary: calendar.summary,
              primary: calendar.primary,
              selected: selected.has(calendar.id) || (calendar.primary && selected.has(PRIMARY)),
              color: calendar.color,
              hidden: calendar.hidden === true,
            }))
            .filter((calendar) => !calendar.hidden || calendar.selected || calendar.primary)
            .map(({ hidden: _hidden, ...calendar }) => calendar)
        : [];
    return {
      configured: clientId !== "" && (settings.googleClientSecret ?? "").trim() !== "",
      clientId,
      callbackPath: GOOGLE_CALLBACK_PATH,
      connected,
      email: row?.email ?? null,
      calendars,
      lastSyncAt: row?.lastSyncAt ?? null,
      lastError: row?.lastError ?? null,
      upcomingCount: row === null ? 0 : this.upcomingCount(row),
      connectedAt: connected ? (row?.connectedAt ?? null) : null,
      lastConsent: this.lastConsent,
    };
  }

  private upcomingCount(row: GoogleAuthRow): number {
    const feeds = new Set(row.selectedCalendars.map(googleFeedId));
    const window = syncWindow(this.service.now());
    return this.repo
      .calendarEventsBetween(window.from, window.to)
      .filter((event) => feeds.has(event.feed) && event.status !== "cancelled" && event.url !== null).length;
  }

  // ---------- client and consent ----------

  async saveClient(clientId: string, clientSecret?: string): Promise<GoogleStatus> {
    const id = clientId.trim();
    const secret = clientSecret?.trim();
    if (id.length < 10 || id.length > 300 || /\s/.test(id)) {
      throw new MeetingsError("invalid_client_id", "Client ID: от 10 до 300 символов без пробелов", "Client ID must be 10-300 characters without spaces");
    }
    if (secret !== undefined && (secret.length < 5 || secret.length > 300 || /\s/.test(secret))) {
      throw new MeetingsError("invalid_client_secret", "Client Secret: от 5 до 300 символов без пробелов", "Client secret must be 5-300 characters without spaces");
    }
    await this.settings.experimental_set(secret === undefined ? { googleClientId: id } : { googleClientId: id, googleClientSecret: secret });
    this.changed();
    return this.status();
  }

  async authStart(origin: string): Promise<{ authUrl: string; redirectUri: string }> {
    const client = await this.client();
    if (client === null) {
      throw new MeetingsError(
        "google_not_configured",
        "Сначала сохраните Client ID и Client Secret OAuth-клиента Google",
        "Save the Google OAuth client ID and secret first",
        "bb plugin config meetings set googleClientId <id> (the secret: on the Meetings page or in the plugin settings)",
      );
    }
    const base = redirectOrigin(origin);
    if (base === null) {
      throw new MeetingsError(
        "invalid_origin",
        "Google разрешает перенаправление только на https:// или на http://localhost / http://127.0.0.1. Откройте bb по такому адресу и подключите снова",
        "Google only redirects to https:// or http://localhost / http://127.0.0.1 origins",
      );
    }
    const redirectUri = `${base}${GOOGLE_CALLBACK_PATH}`;
    const { state, challenge } = this.consents.create(client.clientId, redirectUri);
    const loginHint = this.repo.googleAuth()?.email ?? null;
    return {
      authUrl: authorizationUrl(this.endpoints, { clientId: client.clientId, redirectUri, state, challenge, loginHint }),
      redirectUri,
    };
  }

  /** GET /google/callback: never throws; the outcome is rendered as a small page. */
  async handleCallback(params: GoogleCallbackParams): Promise<GoogleCallbackOutcome> {
    let known = false;
    const outcome = await this.runCallback(params, () => {
      known = true;
    });
    // Only consents this server started are reported to the page (anyone can open the callback URL).
    if (known) {
      this.lastConsent = { at: this.service.now(), ok: outcome.ok, message: outcome.message };
      this.changed();
    }
    return outcome;
  }

  private async runCallback(params: GoogleCallbackParams, markKnown: () => void): Promise<GoogleCallbackOutcome> {
    const fail = (message: string): GoogleCallbackOutcome => ({
      ok: false,
      title: "Google Календарь не подключён",
      message,
      backPath: MEETINGS_PAGE,
    });
    try {
      // Only a consent this server started gets Google's answer shown: anyone can link here with ?error=…
      const consent = this.consents.take(params.state);
      if (consent === null) {
        return fail("Ссылка подключения устарела или уже использована. Начните подключение заново на странице «Встречи».");
      }
      markKnown();
      if (params.error !== undefined && params.error !== "") {
        if (params.error === "access_denied") return fail("Доступ не предоставлен: на экране Google нажали «Отмена» или не разрешили доступ.");
        const detail = params.errorDescription ? `${params.error}: ${params.errorDescription}` : params.error;
        return fail(`Google вернул ошибку (${detail.slice(0, 300)}).`);
      }
      if (params.code === undefined || params.code === "") return fail("Google не передал код авторизации.");
      const client = await this.client();
      if (client === null || client.clientId !== consent.clientId) {
        return fail("Данные OAuth-клиента изменились во время подключения. Начните подключение заново.");
      }
      const tokens = await exchangeCode(
        this.endpoints,
        { ...client, code: params.code, verifier: consent.verifier, redirectUri: consent.redirectUri },
        this.service.lifetime,
      );
      if (tokens.scope !== null && !tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE)) {
        await revokeToken(this.endpoints, tokens.refreshToken ?? tokens.accessToken).catch(() => undefined);
        return fail("Нет доступа к календарю: на экране согласия Google отметьте разрешение на просмотр календарей и подключите заново.");
      }
      let email = idTokenEmail(tokens.idToken);
      if (email === null) {
        try {
          email = await fetchUserEmail(this.endpoints, tokens.accessToken, this.service.lifetime);
        } catch (error) {
          this.bb.log.warn(`Could not read the Google account's email: ${describeGoogleError(error)}`);
        }
      }
      const previous = this.repo.googleAuth();
      // Another account only when both emails are known: a reconnect whose email could not be read keeps the selection.
      const sameAccount = previous !== null && (email === null || previous.email === null || previous.email === email);
      if (sameAccount) email ??= previous.email;
      const refreshToken = tokens.refreshToken ?? (sameAccount ? previous.refreshToken : null);
      if (refreshToken === null) {
        return fail(
          "Google не выдал постоянный доступ (refresh token). Удалите доступ этого приложения на странице myaccount.google.com/permissions и подключите заново.",
        );
      }
      const now = this.service.now();
      this.repo.updateGoogleAuth(
        {
          refreshToken,
          accessToken: tokens.accessToken,
          accessExpiresAt: now + tokens.expiresIn * 1000,
          email,
          scope: tokens.scope ?? CALENDAR_SCOPE,
          connectedAt: now,
          selectedCalendars: sameAccount && previous.selectedCalendars.length > 0 ? previous.selectedCalendars : [PRIMARY],
          calendars: sameAccount ? previous.calendars : [],
          lastSyncAt: sameAccount ? previous.lastSyncAt : null,
          lastError: null,
        },
        now,
      );
      this.bb.log.info("Google Calendar connected");
      if (previous !== null && !sameAccount) {
        // The other account's grant goes with it (revoking a token of the same account would end the new grant too).
        const replaced = previous.refreshToken;
        if (replaced !== null && replaced !== refreshToken) {
          void revokeToken(this.endpoints, replaced, this.service.lifetime).catch((error: unknown) =>
            this.bb.log.warn(`Could not revoke the previous Google account's token: ${describeGoogleError(error)}`),
          );
        }
        // Another account's calendars are not watched any more: their bots go.
        this.service.calendar.reapply(await this.settings.get());
      }
      this.changed();
      this.service.calendar.requestSync();
      return {
        ok: true,
        title: "Google Календарь подключён — можно закрыть вкладку",
        message: email === null
          ? "Встречи из основного календаря появятся на странице «Встречи» после синхронизации."
          : `Аккаунт ${email}. Встречи из основного календаря появятся на странице «Встречи» после синхронизации.`,
        backPath: MEETINGS_PAGE,
      };
    } catch (error) {
      const message = error instanceof MeetingsError ? error.message : describeGoogleError(error);
      this.bb.log.warn(`Google sign-in failed: ${message}`);
      return fail(`Не удалось подключить Google Календарь: ${message}`);
    }
  }

  // ---------- tokens ----------

  /** A valid access token, refreshed on demand (60 s before expiry); concurrent callers share a refresh. */
  async accessToken(force = false): Promise<string> {
    const row = this.repo.googleAuth();
    if (row === null || row.refreshToken === null) {
      if (row?.lastError === GOOGLE_BROKEN_MESSAGE) throw new GoogleAuthBrokenError(GOOGLE_BROKEN_MESSAGE);
      throw new GoogleNotConnectedError();
    }
    if (!force && row.accessToken !== null && (row.accessExpiresAt ?? 0) - REFRESH_SKEW_MS > this.service.now()) {
      return row.accessToken;
    }
    if (this.refreshing !== null) return this.refreshing;
    const run = this.refresh(row.refreshToken);
    this.refreshing = run;
    try {
      return await run;
    } finally {
      if (this.refreshing === run) this.refreshing = null;
    }
  }

  private async refresh(refreshToken: string): Promise<string> {
    const client = await this.client();
    if (client === null) {
      throw new MeetingsError("google_not_configured", "Не заданы Client ID и Client Secret Google", "The Google OAuth client is not configured");
    }
    let tokens;
    try {
      tokens = await refreshAccessToken(this.endpoints, { ...client, refreshToken }, this.service.lifetime);
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === "invalid_grant") {
        if (this.repo.googleAuth()?.refreshToken === refreshToken) {
          this.repo.updateGoogleAuth({ refreshToken: null, accessToken: null, accessExpiresAt: null, lastError: GOOGLE_BROKEN_MESSAGE }, this.service.now());
          this.bb.log.warn("Google refused the refresh token (revoked or expired); the connection needs to be made again");
          this.changed();
        }
        throw new GoogleAuthBrokenError(GOOGLE_BROKEN_MESSAGE);
      }
      throw error;
    }
    const current = this.repo.googleAuth();
    if (current === null || current.refreshToken !== refreshToken) throw new GoogleNotConnectedError(); // disconnected meanwhile
    this.repo.updateGoogleAuth(
      {
        accessToken: tokens.accessToken,
        accessExpiresAt: this.service.now() + tokens.expiresIn * 1000,
        ...(tokens.refreshToken === null ? {} : { refreshToken: tokens.refreshToken }),
        ...(tokens.scope === null ? {} : { scope: tokens.scope }),
      },
      this.service.now(),
    );
    return tokens.accessToken;
  }

  /** Calendar API GET with the current token; a 401 is retried once with a refreshed one. */
  private readonly get: GoogleGet = async (path, query, signal) => {
    const token = await this.accessToken();
    try {
      return await calendarApiGet(this.endpoints.calendarApi, path, query, token, signal);
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 401) throw error;
      return calendarApiGet(this.endpoints.calendarApi, path, query, await this.accessToken(true), signal);
    }
  };

  // ---------- sync (called by CalendarService) ----------

  /** Refresh the calendar list and build one source per watched calendar. */
  async prepareSync(signal?: AbortSignal): Promise<GoogleSyncPlan> {
    const none: GoogleSyncPlan = { attempted: false, sources: [], error: null, generation: null, selectionChanged: false };
    const row = this.repo.googleAuth();
    if (row === null || row.refreshToken === null) return none;
    const generation = row.connectedAt;
    const failed = (failure: unknown): GoogleSyncPlan => {
      const auth = failure instanceof GoogleAuthBrokenError || failure instanceof GoogleNotConnectedError;
      return { attempted: true, sources: [], error: auth ? describeGoogleError(failure) : `Google: ${describeGoogleError(failure)}`, generation, selectionChanged: false };
    };
    // One token for the whole sync: when the token endpoint fails, no calendar is tried
    // (each would wait for a refresh of its own). Known events and bots are kept.
    try {
      await this.accessToken();
    } catch (failure) {
      if (signal?.aborted) throw failure;
      return failed(failure);
    }
    // A failure that is not about one calendar (token refresh, no connection) fails the rest of this sync at once.
    let unreachable: { error: unknown } | null = null;
    const get: GoogleGet = async (path, query, requestSignal) => {
      if (unreachable !== null) throw unreachable.error;
      try {
        return await this.get(path, query, requestSignal);
      } catch (error) {
        if (!(error instanceof GoogleApiError)) unreachable = { error };
        throw error;
      }
    };
    let calendars: GoogleCalendarInfo[] | null = null;
    let error: string | null = null;
    try {
      calendars = await listCalendars(get, signal);
    } catch (failure) {
      if (signal?.aborted) throw failure;
      if (failure instanceof GoogleAuthBrokenError || failure instanceof GoogleNotConnectedError) return failed(failure);
      // Google cannot be reached: every calendar would only wait for its own timeout.
      if (failure instanceof GoogleOAuthError && failure.code === "network") return failed(failure);
      error = `Google: ${describeGoogleError(failure)}`;
    }
    // Read the selection after calendarList: google.setCalendars may have changed it meanwhile.
    const current = this.repo.googleAuth();
    if (current === null || current.connectedAt !== generation || current.refreshToken === null) return none;
    let selected = current.selectedCalendars;
    if (calendars !== null) {
      selected = resolveSelection(current.selectedCalendars, calendars);
      this.repo.updateGoogleAuth({ calendars, selectedCalendars: selected }, this.service.now());
    }
    const known = calendars ?? current.calendars;
    const sources = selected.map((calendarId) =>
      googleCalendarSource({
        calendarId,
        label: known.find((calendar) => calendar.id === calendarId)?.summary ?? (calendarId === PRIMARY ? "основной" : calendarId),
        get,
      }),
    );
    return {
      attempted: true,
      sources,
      error,
      generation,
      selectionChanged: selected.join("\n") !== current.selectedCalendars.join("\n"),
    };
  }

  /** Record the outcome of the Google part of a sync. */
  finishSync(plan: GoogleSyncPlan, failures: readonly string[], now: number): void {
    if (!plan.attempted) return;
    const row = this.repo.googleAuth();
    if (row === null || row.connectedAt !== plan.generation) return;
    const errors = [plan.error, ...failures].filter((text): text is string => text !== null);
    // A connection that broke during this sync keeps saying so.
    const lastError = row.refreshToken === null ? row.lastError : errors.length > 0 ? errors.join("; ") : null;
    this.repo.updateGoogleAuth({ lastSyncAt: now, lastError }, now);
    if (errors.length > 0) this.bb.log.warn(`Google Calendar sync: ${errors.join("; ")}`);
    this.changed();
  }

  /**
   * settings.onChange: tokens belong to the OAuth client that issued them, so
   * a new Client ID ends the connection (the watched calendars are kept for
   * the next connect).
   */
  settingsChanged(next: Pick<MeetingsSettings, "googleClientId">, prev: Pick<MeetingsSettings, "googleClientId">): void {
    if (next.googleClientId.trim() === prev.googleClientId.trim()) return;
    const row = this.repo.googleAuth();
    if (row === null || row.refreshToken === null) return;
    const token = row.refreshToken;
    this.repo.updateGoogleAuth({ refreshToken: null, accessToken: null, accessExpiresAt: null, lastError: GOOGLE_CLIENT_CHANGED_MESSAGE }, this.service.now());
    this.refreshing = null;
    this.bb.log.info("The Google OAuth client changed; the Google Calendar connection has to be made again");
    void revokeToken(this.endpoints, token, this.service.lifetime).catch((error: unknown) =>
      this.bb.log.warn(`Could not revoke the old Google token: ${describeGoogleError(error)}`),
    );
    this.changed();
  }

  // ---------- user actions ----------

  async setCalendars(calendarIds: readonly string[]): Promise<GoogleStatus> {
    const row = this.repo.googleAuth();
    if (row === null || row.refreshToken === null) throw new GoogleNotConnectedError();
    const known = new Set(row.calendars.map((calendar) => calendar.id));
    const wanted = [...new Set(calendarIds.map((id) => id.trim()).filter((id) => id !== ""))]
      .filter((id) => known.size === 0 || known.has(id) || id === PRIMARY)
      .slice(0, MAX_SELECTED);
    this.repo.updateGoogleAuth({ selectedCalendars: wanted }, this.service.now());
    // Bots of calendars no longer watched go now; new ones are fetched by the sync.
    this.service.calendar.reapply(await this.settings.get());
    this.bb.realtime.publish(CHANNEL_CALENDAR_CHANGED, {});
    this.changed();
    this.service.calendar.requestSync();
    return this.status();
  }

  async sync(signal?: AbortSignal): Promise<GoogleStatus> {
    if (!this.connected()) {
      const row = this.repo.googleAuth();
      if (row?.lastError === GOOGLE_BROKEN_MESSAGE) {
        throw new MeetingsError("google_broken", GOOGLE_BROKEN_MESSAGE, "Google access was revoked or expired; connect again", "Connect again on the Meetings page");
      }
      throw new GoogleNotConnectedError();
    }
    await this.service.calendar.sync(signal);
    return this.status();
  }

  /** Revoke and forget the tokens; still-scheduled bots from Google calendars are cancelled. */
  async disconnect(): Promise<GoogleStatus> {
    await this.service.calendar.idle();
    const row = this.repo.googleAuth();
    const token = row?.refreshToken ?? row?.accessToken ?? null;
    if (token !== null) {
      try {
        await revokeToken(this.endpoints, token, this.service.lifetime);
      } catch (error) {
        this.bb.log.warn(`Could not revoke the Google token (it is deleted anyway): ${describeGoogleError(error)}`);
      }
    }
    this.repo.deleteGoogleAuth();
    this.refreshing = null;
    const cancelled = this.service.calendar.forgetFeeds(GOOGLE_FEED_PREFIX, "Google Календарь отключён");
    this.bb.log.info(`Google Calendar disconnected${cancelled > 0 ? `; cancelled ${cancelled} scheduled bot(s)` : ""}`);
    // A sync that started meanwhile may still store Google events: forget them once it is done.
    void this.service.calendar
      .idle()
      .then(() => {
        if (this.repo.googleAuth() === null) this.service.calendar.forgetFeeds(GOOGLE_FEED_PREFIX, "Google Календарь отключён");
      })
      .catch((error: unknown) => this.bb.log.warn(`Google cleanup failed: ${errorMessage(error)}`));
    this.changed();
    return this.status();
  }
}

/** Watched ids after a fresh calendarList: "primary" resolved, calendars that are gone dropped. */
export function resolveSelection(selected: readonly string[], calendars: readonly GoogleCalendarInfo[]): string[] {
  if (calendars.length === 0) return [...selected];
  const primary = calendars.find((calendar) => calendar.primary)?.id ?? null;
  const known = new Set(calendars.map((calendar) => calendar.id));
  const out: string[] = [];
  for (const id of selected) {
    const resolved = id === PRIMARY ? primary : id;
    if (resolved !== null && known.has(resolved) && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}
