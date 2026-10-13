import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsentStates,
  GOOGLE_CALLBACK_ROUTE,
  STATE_TTL_MS,
  createPkce,
  pkceChallenge,
  redirectOrigin,
} from "../src/server/google-auth.js";
import { GOOGLE_CALLBACK_PATH, type GoogleStatus } from "../src/shared/rpc-contract.js";
import { FakeGoogle, load, until } from "./server-fixtures.js";

const NOW = Date.UTC(2026, 9, 13, 7, 0, 0);
const ORIGIN = "https://bb.example";
const BROKEN = "Доступ к Google отозван или истёк — подключите заново";

describe("OAuth helpers", () => {
  it("makes PKCE S256 pairs", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it("accepts https origins and plain http only on localhost / 127.0.0.1", () => {
    expect(redirectOrigin("https://bb.example")).toBe("https://bb.example");
    expect(redirectOrigin("https://bb.example:8443/some/page")).toBe("https://bb.example:8443");
    expect(redirectOrigin("http://localhost:38886")).toBe("http://localhost:38886");
    expect(redirectOrigin("http://127.0.0.1:38886")).toBe("http://127.0.0.1:38886");
    expect(redirectOrigin("http://bb.example")).toBeNull();
    expect(redirectOrigin("http://192.168.1.5:38886")).toBeNull();
    expect(redirectOrigin("https://user:pw@bb.example")).toBeNull();
    expect(redirectOrigin("javascript:alert(1)")).toBeNull();
    expect(redirectOrigin("not a url")).toBeNull();
  });

  it("keeps a consent for 15 minutes and lets it be used once", () => {
    let clock = NOW;
    const states = new ConsentStates(() => clock);
    const first = states.create("client", "https://bb.example/cb");
    expect(states.take(first.state)).toMatchObject({ clientId: "client", redirectUri: "https://bb.example/cb" });
    expect(states.take(first.state)).toBeNull();
    const second = states.create("client", "https://bb.example/cb");
    clock += STATE_TTL_MS + 1;
    expect(states.take(second.state)).toBeNull();
    expect(states.take(undefined)).toBeNull();
    for (let i = 0; i < 30; i += 1) states.create("client", "https://bb.example/cb");
    expect(states.size).toBe(20);
  });

  it("serves the callback at GOOGLE_CALLBACK_PATH", () => {
    expect(GOOGLE_CALLBACK_ROUTE).toBe("/google/callback");
    expect(`/api/v1/plugins/meetings/http${GOOGLE_CALLBACK_ROUTE}`).toBe(GOOGLE_CALLBACK_PATH);
  });
});

describe("Google OAuth through the plugin", () => {
  let google: FakeGoogle | null = null;
  afterEach(async () => {
    await google?.stop();
    google = null;
  });

  async function setup(settings: Record<string, string | number | boolean> = {}) {
    google = await new FakeGoogle().start();
    let clock = NOW;
    const fake = google;
    const loaded = await load({
      now: () => clock,
      googleEndpoints: fake.endpoints,
      settings: { googleClientId: fake.clientId, googleClientSecret: fake.clientSecret, ...settings },
    });
    const status = async () => (await loaded.harness.behavior.callRpc("google.status", null)) as GoogleStatus;
    const start = async (origin = ORIGIN) =>
      (await loaded.harness.behavior.callRpc("google.authStart", { origin })) as { authUrl: string; redirectUri: string };
    const callback = (query: string) => loaded.harness.behavior.fetchHttp("GET", `/google/callback?${query}`);
    const connect = async () => {
      const { code, state } = fake.approve((await start()).authUrl);
      const page = await callback(`code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
      await until(() => fake.calls("/calendar/v3/users/me/calendarList").length > 0);
      await loaded.service.calendar.idle();
      return page;
    };
    return { ...loaded, google: fake, status, start, callback, connect, advance: (ms: number) => (clock += ms) };
  }

  it("starts the consent with PKCE, offline access, the calendar scope and the page's origin", async () => {
    const { status, start, harness, google: fake } = await setup();
    expect(await status()).toMatchObject({
      configured: true,
      clientId: fake.clientId,
      callbackPath: GOOGLE_CALLBACK_PATH,
      connected: false,
      email: null,
      calendars: [],
      upcomingCount: 0,
    });
    const { authUrl, redirectUri } = await start();
    expect(redirectUri).toBe(`https://bb.example${GOOGLE_CALLBACK_PATH}`);
    const url = new URL(authUrl);
    expect(`${url.origin}${url.pathname}`).toBe(fake.endpoints.authUrl);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: fake.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
    });
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(authUrl).not.toContain(fake.clientSecret);

    expect((await start("http://localhost:38886")).redirectUri).toBe(`http://localhost:38886${GOOGLE_CALLBACK_PATH}`);
    await expect(harness.behavior.callRpc("google.authStart", { origin: "http://bb.example" })).rejects.toThrow(/https:\/\//);
  });

  it("needs a saved client first, and never returns the secret", async () => {
    const { harness, status } = await setup({ googleClientId: "", googleClientSecret: "" });
    expect((await status()).configured).toBe(false);
    await expect(harness.behavior.callRpc("google.authStart", { origin: ORIGIN })).rejects.toThrow(/Client ID и Client Secret/);
    await expect(harness.behavior.callRpc("google.saveClient", { clientId: "bad id with spaces" })).rejects.toThrow();
    const saved = (await harness.behavior.callRpc("google.saveClient", {
      clientId: "999-new.apps.googleusercontent.com",
      clientSecret: "GOCSPX-another",
    })) as GoogleStatus;
    expect(saved).toMatchObject({ configured: true, clientId: "999-new.apps.googleusercontent.com" });
    expect(JSON.stringify(saved)).not.toContain("GOCSPX-another");
    // The secret is kept when only the id changes.
    const idOnly = (await harness.behavior.callRpc("google.saveClient", { clientId: "1000-newer.apps.googleusercontent.com" })) as GoogleStatus;
    expect(idOnly.configured).toBe(true);
    expect(harness.inspection.realtimeSignals.filter((s) => s.channel === "meetings.google").length).toBeGreaterThanOrEqual(2);
  });

  it("connects on the callback: code + verifier exchange, email, primary calendar, a first sync", async () => {
    const { connect, status, google: fake, harness } = await setup();
    const page = await connect();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Google Календарь подключён — можно закрыть вкладку");
    expect(html).toContain("anna@example.com");
    expect(html).toContain('href="/plugins/meetings/meetings"');

    const [exchange] = fake.calls("/token");
    expect(exchange?.form).toMatchObject({
      grant_type: "authorization_code",
      client_id: fake.clientId,
      redirect_uri: `https://bb.example${GOOGLE_CALLBACK_PATH}`,
    });
    expect(exchange?.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const connected = await status();
    expect(connected).toMatchObject({ connected: true, email: "anna@example.com", lastError: null });
    expect(connected.lastSyncAt).toBe(NOW);
    expect(connected.calendars).toEqual([
      { id: "anna@example.com", summary: "anna@example.com", primary: true, selected: true, color: "#9fe1e7" },
      { id: "team@group.calendar.google.com", summary: "Команда (общий)", primary: false, selected: false, color: "#f83a22" },
    ]);
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "meetings.google")).toBe(true);

    // No token, code or secret in RPC output, logs or realtime payloads.
    const visible = JSON.stringify([connected, harness.inspection.logEntries, harness.inspection.realtimeSignals, await harness.behavior.runCli(["google", "--json"])]);
    for (const secret of fake.secrets) expect(visible).not.toContain(secret);
  });

  it("renders failures: denied consent, unknown, expired or replayed state, a failed exchange", async () => {
    const { start, callback, google: fake, advance, status } = await setup();
    const denied = await callback(`error=access_denied&state=${new URL((await start()).authUrl).searchParams.get("state")}`);
    const afterDenied = await status();
    expect(afterDenied.lastConsent).toMatchObject({ ok: false });
    expect(afterDenied.lastConsent?.message).toMatch(/Доступ не предоставлен/);
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("Доступ не предоставлен");

    const unknown = await callback("code=abc&state=forged");
    expect(await unknown.text()).toContain("Ссылка подключения устарела или уже использована");

    const expired = fake.approve((await start()).authUrl);
    advance(STATE_TTL_MS + 1_000);
    expect(await (await callback(`code=${expired.code}&state=${expired.state}`)).text()).toContain("устарела");

    const fresh = fake.approve((await start()).authUrl);
    fake.clientSecret = "GOCSPX-rotated";
    const failed = await callback(`code=${fresh.code}&state=${fresh.state}`);
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain("Не удалось подключить Google Календарь: Google не принял Client ID или Client Secret");
    // The state was used up by the failed attempt.
    expect(await (await callback(`code=${fresh.code}&state=${fresh.state}`)).text()).toContain("устарела");

    const state = new URL((await start()).authUrl).searchParams.get("state") ?? "";
    const injected = await callback(
      `error=${encodeURIComponent("<script>alert(1)</script>")}&error_description=${encodeURIComponent('"><img src=x>')}&state=${state}`,
    );
    const html = await injected.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
    expect(injected.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await status()).connected).toBe(false);

    // Without a consent this server started, nothing from the query reaches the page (anyone can link to the callback).
    for (const query of [
      `error=server_error&error_description=${encodeURIComponent("Сессия истекла. Позвоните в поддержку +7 999 000-00-00")}`,
      `error=server_error&error_description=${encodeURIComponent("Позвоните в поддержку")}&state=forged`,
    ]) {
      const spoofed = await (await callback(query)).text();
      expect(spoofed).toContain("Ссылка подключения устарела или уже использована");
      expect(spoofed).not.toContain("server_error");
      expect(spoofed).not.toContain("Позвоните");
    }
  });

  it("reconnects: the same account keeps its calendars (also when its email cannot be read), another one replaces them and its old grant is revoked", async () => {
    const { start, callback, google: fake, status, harness, service } = await setup({ calendarAutoJoin: true });
    const TEAM = "team@group.calendar.google.com";
    fake.events.set(TEAM, [
      {
        id: "retro",
        status: "confirmed",
        summary: "Ретро",
        start: { dateTime: new Date(NOW + 2 * 3600_000).toISOString() },
        end: { dateTime: new Date(NOW + 3 * 3600_000).toISOString() },
        location: "https://zoom.us/j/81234567010",
      },
    ]);
    const reconnect = async () => {
      const lists = fake.calls("/calendar/v3/users/me/calendarList").length;
      const { code, state } = fake.approve((await start()).authUrl);
      const page = await callback(`code=${code}&state=${state}`);
      await until(() => fake.calls("/calendar/v3/users/me/calendarList").length > lists);
      await service.calendar.idle();
      return page;
    };
    const watched = async () => (await status()).calendars.filter((c) => c.selected).map((c) => c.id);
    const retro = async () =>
      ((await harness.behavior.callRpc("meetings.list", { filter: "all" })) as { meetings: Array<{ title: string; status: string; statusDetail: string | null }> }).meetings.find(
        (m) => m.title === "Ретро",
      );
    const refreshTokens = () => fake.secrets.filter((secret) => secret.startsWith("1//refresh-"));

    // The email comes from the id_token of the code exchange: no userinfo call needed.
    await reconnect();
    expect(fake.calls("/v1/userinfo")).toHaveLength(0);
    await harness.behavior.callRpc("google.setCalendars", { calendarIds: ["anna@example.com", TEAM] });
    await service.calendar.idle();
    await until(() => fake.calls(`/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`).length > 0);
    await service.calendar.idle();
    expect(await retro()).toMatchObject({ status: "scheduled" });

    // Same account, but neither the id_token nor userinfo tells the email this time: nothing is reset.
    fake.issueIdToken = false;
    fake.failUserinfo = true;
    expect((await reconnect()).status).toBe(200);
    expect(fake.calls("/v1/userinfo")).toHaveLength(1);
    expect(await status()).toMatchObject({ connected: true, email: "anna@example.com" });
    expect(await watched()).toEqual(["anna@example.com", TEAM]);
    expect(await retro()).toMatchObject({ status: "scheduled" });
    expect(fake.revoked).toEqual([]);

    // Another account: its primary calendar only, the first account's bots go and its grant is revoked.
    fake.issueIdToken = true;
    fake.email = "boris@example.com";
    const previous = refreshTokens().at(-1);
    fake.calendars = [{ id: "boris@example.com", summary: "boris@example.com", primary: true, accessRole: "owner" }];
    await reconnect();
    expect(await status()).toMatchObject({ connected: true, email: "boris@example.com" });
    expect(await watched()).toEqual(["boris@example.com"]);
    expect(await retro()).toMatchObject({ status: "cancelled" });
    await until(() => fake.revoked.length === 1);
    expect(fake.revoked).toEqual([previous]);
    // The new grant works.
    expect(((await harness.behavior.callRpc("google.sync", null)) as GoogleStatus).lastError).toBeNull();
  });

  it("refuses a consent without the calendar permission and revokes it", async () => {
    const { start, callback, google: fake, status } = await setup();
    fake.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email";
    const { code, state } = fake.approve((await start()).authUrl);
    const page = await callback(`code=${code}&state=${state}`);
    expect(await page.text()).toContain("Нет доступа к календарю");
    expect(fake.revoked).toHaveLength(1);
    expect((await status()).connected).toBe(false);
  });

  it("refreshes the access token 60 s before it expires", async () => {
    const { connect, harness, google: fake, advance } = await setup();
    await connect();
    const refreshes = () => fake.calls("/token").filter((call) => call.form.grant_type === "refresh_token");
    advance(3600_000 - 61_000);
    await harness.behavior.callRpc("google.sync", null);
    expect(refreshes()).toHaveLength(0);
    advance(2_000);
    await harness.behavior.callRpc("google.sync", null);
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0]?.form).toMatchObject({ client_id: fake.clientId, client_secret: fake.clientSecret });
    const lastList = fake.calls("/calendar/v3/users/me/calendarList").at(-1);
    expect(lastList?.authorization).not.toBe(fake.calls("/calendar/v3/users/me/calendarList")[0]?.authorization);
  });

  it("marks the connection broken when Google revoked the grant, and keeps the scheduled bots", async () => {
    const { connect, harness, google: fake, advance, status } = await setup({ calendarAutoJoin: true });
    fake.events.set("anna@example.com", [
      {
        id: "standup1",
        status: "confirmed",
        summary: "Стендап",
        start: { dateTime: new Date(NOW + 2 * 3600_000).toISOString() },
        end: { dateTime: new Date(NOW + 2.5 * 3600_000).toISOString() },
        location: "https://us02web.zoom.us/j/81234567001?pwd=Stand1",
      },
    ]);
    await connect();
    const upcoming = async () =>
      ((await harness.behavior.callRpc("meetings.list", { filter: "upcoming" })) as { meetings: Array<{ id: string }> }).meetings;
    expect(await upcoming()).toHaveLength(1);

    fake.refreshRevoked = true;
    advance(3600_000);
    const after = (await harness.behavior.callRpc("calendar.sync", null)) as { upcoming: Array<{ key: string }> };
    expect(after.upcoming.map((e) => e.key)).toEqual(["gcal:anna@example.com:standup1"]);
    const broken = await status();
    expect(broken).toMatchObject({ connected: false, email: "anna@example.com", lastError: BROKEN, calendars: [] });
    expect(await upcoming()).toHaveLength(1);
    await expect(harness.behavior.callRpc("google.sync", null)).rejects.toThrow(BROKEN);
    expect(harness.inspection.logEntries.some((e) => e.level === "warn" && e.message.includes("refresh token"))).toBe(true);
  });

  it("ends the connection when the OAuth client ID changes", async () => {
    const { connect, harness, google: fake, status } = await setup();
    await connect();
    await harness.behavior.callRpc("google.saveClient", { clientId: fake.clientId, clientSecret: "GOCSPX-same-client-new-secret" });
    expect((await status()).connected).toBe(true);
    await harness.behavior.callRpc("google.saveClient", { clientId: "555-other.apps.googleusercontent.com" });
    expect(await status()).toMatchObject({ connected: false, lastError: "Client ID изменён — подключите Google Календарь заново" });
    await until(() => fake.revoked.length === 1);
    await expect(harness.behavior.callRpc("google.sync", null)).rejects.toThrow("Google Календарь не подключён");
  });

  it("disconnects: revokes the token, cancels Google bots, keeps ICS ones", async () => {
    google = await new FakeGoogle().start();
    const fake = google;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ics-1@example.com",
      "DTSTART:20261013T100000Z",
      "DTEND:20261013T110000Z",
      "SUMMARY:Из ICS",
      "LOCATION:https://zoom.us/j/81234567002",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const loaded = await load({
      now: () => NOW,
      googleEndpoints: fake.endpoints,
      fetchText: async () => ics,
      settings: {
        googleClientId: fake.clientId,
        googleClientSecret: fake.clientSecret,
        calendarAutoJoin: true,
        calendarIcsUrls: "https://calendar.example.com/private.ics",
      },
    });
    const { harness, service } = loaded;
    fake.events.set("anna@example.com", [
      {
        id: "g1",
        summary: "Из Google",
        start: { dateTime: new Date(NOW + 3600_000).toISOString() },
        end: { dateTime: new Date(NOW + 2 * 3600_000).toISOString() },
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://us02web.zoom.us/j/81234567003?pwd=G1" }] },
      },
    ]);
    const start = (await harness.behavior.callRpc("google.authStart", { origin: ORIGIN })) as { authUrl: string };
    const { code, state } = fake.approve(start.authUrl);
    await harness.behavior.fetchHttp("GET", `/google/callback?code=${code}&state=${state}`);
    await until(() => fake.calls("/calendar/v3/users/me/calendarList").length > 0);
    await service.calendar.idle();
    await harness.behavior.callRpc("calendar.sync", null);
    const list = async () =>
      ((await harness.behavior.callRpc("meetings.list", { filter: "all" })) as {
        meetings: Array<{ id: string; title: string; status: string; statusDetail: string | null }>;
      }).meetings;
    expect((await list()).map((m) => [m.title, m.status]).sort()).toEqual([
      ["Из Google", "scheduled"],
      ["Из ICS", "scheduled"],
    ]);
    const refreshToken = fake.secrets.find((secret) => secret.startsWith("1//refresh-"));
    expect(refreshToken).toBeDefined();

    const status = (await harness.behavior.callRpc("google.disconnect", null)) as GoogleStatus;
    expect(status).toMatchObject({ connected: false, email: null, calendars: [], lastSyncAt: null, lastError: null, upcomingCount: 0 });
    expect(fake.revoked).toEqual([refreshToken]);
    const after = await list();
    expect(after.find((m) => m.title === "Из Google")).toMatchObject({ status: "cancelled", statusDetail: "Google Календарь отключён" });
    expect(after.find((m) => m.title === "Из ICS")).toMatchObject({ status: "scheduled" });
    const calendar = (await harness.behavior.callRpc("calendar.status", null)) as { upcoming: Array<{ key: string }> };
    expect(calendar.upcoming.map((e) => e.key)).toEqual(["ics-1@example.com#2026-10-13T10:00:00.000Z"]);
    await expect(harness.behavior.callRpc("google.sync", null)).rejects.toThrow("Google Календарь не подключён");
    const cli = await harness.behavior.runCli(["google"]);
    expect(cli.stdout).toContain("Google Calendar: not connected");
    expect(cli.stdout).toContain(`https://bb.example${GOOGLE_CALLBACK_PATH}`);
  });
});
