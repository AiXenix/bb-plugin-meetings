// Google OAuth for the Calendar source (docs/dev/DESIGN.md §13): the
// authorization-code flow with PKCE (S256), token exchange, refresh and
// revocation. Pure HTTP helpers, no state: google-service.ts keeps the tokens.
// Tokens, codes and the client secret travel in request bodies and headers
// only, never in URLs, error messages or logs.
import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_CALLBACK_PATH } from "../shared/rpc-contract.js";

export interface GoogleEndpoints {
  /** Consent screen (authorization endpoint). */
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly userinfoUrl: string;
  readonly revokeUrl: string;
  /** Calendar API v3 base, e.g. https://www.googleapis.com/calendar/v3 */
  readonly calendarApi: string;
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  calendarApi: "https://www.googleapis.com/calendar/v3",
};

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_SCOPES: readonly string[] = ["openid", "email", CALENDAR_SCOPE];
/** A consent started on the page must come back within this time. */
export const STATE_TTL_MS = 15 * 60_000;
/** Refresh an access token this long before Google says it expires. */
export const REFRESH_SKEW_MS = 60_000;
export const GOOGLE_TIMEOUT_MS = 20_000;
/** Consents in flight at once; the oldest is dropped beyond this. */
const MAX_PENDING = 20;

/** The OAuth redirect route relative to the plugin's HTTP root ("/google/callback"). */
export const GOOGLE_CALLBACK_ROUTE = GOOGLE_CALLBACK_PATH.replace(/^\/api\/v1\/plugins\/[^/]+\/http(?=\/)/, "");

/** A failed OAuth request: `code` is Google's `error` ("invalid_grant", …), "http_<status>" or "network". */
export class GoogleOAuthError extends Error {
  override readonly name = "GoogleOAuthError";

  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  readonly accessToken: string;
  /** Seconds. */
  readonly expiresIn: number;
  /** Only in the code exchange (and rarely on refresh). */
  readonly refreshToken: string | null;
  readonly scope: string | null;
  /** OpenID id_token (code exchange with the openid scope). */
  readonly idToken: string | null;
}

export function createPkce(): { verifier: string; challenge: string } {
  // 64 characters of [A-Za-z0-9_-]: inside RFC 7636's 43–128.
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The bb origin the Meetings page runs on, when Google accepts a redirect to
 * it: https://…, or plain http only on localhost / 127.0.0.1. null otherwise.
 */
export function redirectOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url.origin;
  return null;
}

export function authorizationUrl(
  endpoints: GoogleEndpoints,
  args: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string | null },
): string {
  const url = new URL(endpoints.authUrl);
  const params = url.searchParams;
  params.set("client_id", args.clientId);
  params.set("redirect_uri", args.redirectUri);
  params.set("response_type", "code");
  params.set("scope", GOOGLE_SCOPES.join(" "));
  params.set("access_type", "offline");
  params.set("prompt", "consent");
  params.set("include_granted_scopes", "true");
  params.set("state", args.state);
  params.set("code_challenge", args.challenge);
  params.set("code_challenge_method", "S256");
  if (args.loginHint) params.set("login_hint", args.loginHint);
  return url.toString();
}

interface PendingConsent {
  readonly verifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly createdAt: number;
}

/** Consents in flight: random state → PKCE verifier and redirect URI, one use each, 15 min. */
export class ConsentStates {
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly now: () => number) {}

  create(clientId: string, redirectUri: string): { state: string; challenge: string } {
    this.prune();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = createPkce();
    this.pending.set(state, { verifier, redirectUri, clientId, createdAt: this.now() });
    return { state, challenge };
  }

  /** The consent for `state`, removed so it cannot be replayed; null when unknown or expired. */
  take(state: string | undefined): PendingConsent | null {
    this.prune();
    if (state === undefined || state === "") return null;
    const consent = this.pending.get(state) ?? null;
    this.pending.delete(state);
    return consent;
  }

  get size(): number {
    return this.pending.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, consent] of this.pending) {
      if (now - consent.createdAt > STATE_TTL_MS) this.pending.delete(state);
    }
  }
}

// ---------- HTTP ----------

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** Why fetch failed, without its message (which may quote the URL). */
export function networkFailure(error: unknown): GoogleOAuthError {
  if (error instanceof GoogleOAuthError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new GoogleOAuthError("network", `Google не ответил за ${GOOGLE_TIMEOUT_MS / 1000} с`, null);
  }
  if (error instanceof Error && error.name === "AbortError") return new GoogleOAuthError("aborted", "Запрос к Google прерван", null);
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(cause.code) ? cause.code : null;
  return new GoogleOAuthError("network", code === null ? "Нет связи с Google" : `Нет связи с Google (${code})`, null);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => "");
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Google's `{error, error_description}` as a short Russian message. */
function oauthError(status: number, body: Record<string, unknown> | null): GoogleOAuthError {
  const code = str(body?.error) ?? `http_${status}`;
  const description = str(body?.error_description);
  const known: Record<string, string> = {
    invalid_grant: "Google отклонил код или токен доступа (истёк, отозван или уже использован)",
    invalid_client: "Google не принял Client ID или Client Secret",
    unauthorized_client: "Этот OAuth-клиент Google не может выполнить запрос",
    redirect_uri_mismatch: "Адрес перенаправления не зарегистрирован в OAuth-клиенте Google",
    invalid_request: "Google отклонил запрос",
  };
  const base = known[code] ?? (status >= 500 ? "Google временно недоступен" : "Google отклонил запрос");
  const detail = description === null ? `HTTP ${status}` : `${description.slice(0, 200)}; HTTP ${status}`;
  return new GoogleOAuthError(code, `${base} (${detail})`, status);
}

async function postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  const body = await readJson(response);
  if (!response.ok) throw oauthError(response.status, body);
  if (body === null) throw new GoogleOAuthError("bad_response", `Google вернул ответ не в формате JSON (HTTP ${response.status})`, response.status);
  return body;
}

function tokenResponse(body: Record<string, unknown>): TokenResponse {
  const accessToken = str(body.access_token);
  if (accessToken === null) throw new GoogleOAuthError("bad_response", "Google не вернул токен доступа", null);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { accessToken, expiresIn, refreshToken: str(body.refresh_token), scope: str(body.scope), idToken: str(body.id_token) };
}

/**
 * The account's email from the id_token of a code exchange; null when absent
 * or unreadable. The token comes straight from Google's token endpoint over
 * TLS, so its signature need not be checked (OpenID Connect Core §3.1.3.7).
 */
export function idTokenEmail(idToken: string | null): string | null {
  const payload = idToken?.split(".")[1];
  if (payload === undefined || payload === "") return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims === "object" && claims !== null ? (claims as { email?: unknown }).email : undefined;
    return typeof email === "string" && email.includes("@") ? email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(
  endpoints: GoogleEndpoints,
  args: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const body = await postForm(
    endpoints.tokenUrl,
    {
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    },
    signal,
  );
  return tokenResponse(body);
}

export async function refreshAccessToken(
  endpoints: GoogleEndpoints,
  args: { clientId: string; clientSecret: string; refreshToken: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const body = await postForm(
    endpoints.tokenUrl,
    { grant_type: "refresh_token", refresh_token: args.refreshToken, client_id: args.clientId, client_secret: args.clientSecret },
    signal,
  );
  return tokenResponse(body);
}

/** The account's email from the OpenID userinfo endpoint; null when Google does not say. */
export async function fetchUserEmail(endpoints: GoogleEndpoints, accessToken: string, signal?: AbortSignal): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(endpoints.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  const body = await readJson(response);
  if (!response.ok) throw oauthError(response.status, body);
  const email = str(body?.email);
  return email === null ? null : email.slice(0, 320);
}

/** Revoke a refresh (or access) token; Google answers 200, or 400 when it is already invalid. */
export async function revokeToken(endpoints: GoogleEndpoints, token: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoints.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: requestSignal(signal),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  const body = await readJson(response);
  if (!response.ok) throw oauthError(response.status, body);
}
