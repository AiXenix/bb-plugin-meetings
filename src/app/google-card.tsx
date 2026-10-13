// "Google Календарь" card on the list page (DESIGN §13): OAuth client setup
// (google.saveClient), the consent in a new tab (google.authStart, then
// google.status polling and the meetings.google signal), and once connected
// the calendars to watch, sync and disconnect. Google events reach the
// "Запланированные" list through calendar.status.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRealtime, useSettings } from "@get-bb/plugin-sdk/app";
import type { CalendarStatus, GoogleCalendarView, GoogleStatus } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { CHANNEL_GOOGLE_CHANGED, GOOGLE_CALLBACK_PATH } from "./constants";
import { formatDateTime, pluralRu } from "./format";
import { useAsyncAction, useDebouncedCallback, useInterval, useLatest, useMountedRef, useOnReconnect } from "./hooks";
import { messageOf, useMeetingsRpc } from "./rpc";
import { ConfirmDialog, CopyButton, ErrorText, Notice, Section, Spinner } from "./ui";

/** google.setCalendars accepts at most this many ids. */
const MAX_CALENDARS = 50;
/** How often google.status is polled while the consent tab is open: often at first, then slower. */
const AUTH_POLL_MS = 2000;
const AUTH_SLOW_POLL_MS = 10_000;
const AUTH_FAST_POLL_FOR_MS = 60_000;
/** Stop waiting for the consent after this long (the server keeps the OAuth state 15 min). */
const AUTH_WAIT_MS = 15 * 60_000;

const CONSOLE_LINKS = {
  console: "https://console.cloud.google.com/",
  calendarApi: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  consent: "https://console.cloud.google.com/apis/credentials/consent",
  credentials: "https://console.cloud.google.com/apis/credentials",
} as const;

export function useGoogleStatus() {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Results of older requests must not overwrite a newer answer (polls racing actions): an answer
  // applies when its request started after the one last applied. Requiring the latest request
  // instead would drop every answer once a call takes longer than the consent poll interval.
  const sequence = useRef(0);
  const applied = useRef(0);
  const refetch = useCallback(() => {
    const seq = ++sequence.current;
    rpc.call("google.status").then(
      (result) => {
        if (!mounted.current || seq <= applied.current) return;
        applied.current = seq;
        setStatus(result);
        setError(null);
      },
      (cause: unknown) => {
        if (!mounted.current || seq <= applied.current) return;
        applied.current = seq;
        setError(messageOf(cause));
      },
    );
  }, [rpc, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  useRealtime(CHANNEL_GOOGLE_CHANGED, debounced);
  useOnReconnect(refetch);
  const update = useCallback(
    (next: GoogleStatus) => {
      applied.current = ++sequence.current;
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
    },
    [mounted],
  );
  return { status, error, refetch, update };
}

export type GoogleStatusState = ReturnType<typeof useGoogleStatus>;

/** The redirect URI to register in the OAuth client: this bb origin + the callback route. */
export function googleRedirectUri(origin: string, callbackPath: string): string {
  return `${origin}${callbackPath === "" ? GOOGLE_CALLBACK_PATH : callbackPath}`;
}

/** Google accepts web redirect URIs on https:// and on http://localhost only (the server checks the same). */
export function redirectOriginAllowed(origin: string): boolean {
  return /^https:\/\/[^/]+$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

/**
 * A connection is stored on the server: connected, or broken (token revoked or expired, Client ID
 * changed). A broken one keeps its known events and their bots until it is reconnected or
 * disconnected. google.status of a server without one has all of these empty.
 */
export function hasGoogleConnection(status: GoogleStatus): boolean {
  return (
    status.connected ||
    status.email !== null ||
    status.lastError !== null ||
    status.lastSyncAt !== null ||
    status.upcomingCount > 0
  );
}

function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** A link to a Google page in a new browser tab (Google sign-in does not work in embedded views). */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-foreground/80"
    >
      {children}
    </a>
  );
}

function RedirectUri({ status, label }: { status: GoogleStatus; label: ReactNode }) {
  const origin = currentOrigin();
  const uri = googleRedirectUri(origin, status.callbackPath);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 font-mono text-xs text-foreground">
          {uri}
        </code>
        <CopyButton text={uri} label="Скопировать адрес перенаправления" />
      </div>
      {redirectOriginAllowed(origin) ? null : (
        <p className="text-xs text-warning-text">
          Google принимает только адреса https:// или http://localhost. Откройте bb по https или через localhost и
          подключайте календарь оттуда.
        </p>
      )}
    </div>
  );
}

function SetupSteps({ status }: { status: GoogleStatus }) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground marker:text-muted-foreground">
        <li>
          В <ExternalLink href={CONSOLE_LINKS.console}>Google Cloud Console</ExternalLink> создайте проект или выберите
          существующий.
        </li>
        <li>
          Включите <ExternalLink href={CONSOLE_LINKS.calendarApi}>Google Calendar API</ExternalLink> (APIs &amp;
          Services → Library → Enable).
        </li>
        <li>
          Настройте <ExternalLink href={CONSOLE_LINKS.consent}>экран согласия OAuth</ExternalLink>: тип{" "}
          <span className="text-foreground">External</span>, в «Test users» добавьте свой аккаунт Google — или
          опубликуйте приложение.
        </li>
        <li>
          В <ExternalLink href={CONSOLE_LINKS.credentials}>Credentials</ExternalLink> нажмите Create credentials → OAuth
          client ID, тип <span className="text-foreground">Web application</span>.
        </li>
        <li className="space-y-1">
          <span>В «Authorized redirect URIs» добавьте ровно этот адрес:</span>
          <RedirectUri status={status} label={null} />
        </li>
        <li>Скопируйте Client ID и Client Secret в поля ниже.</li>
      </ol>
      <Notice tone="info">
        <p className="text-muted-foreground">
          Пока приложение в режиме Testing, Google отзывает доступ через 7 дней — календарь придётся подключать заново.
          Чтобы этого не было, опубликуйте приложение (Publish app). Google предупредит, что приложение не проверено, —
          для своего аккаунта это нормально: Advanced → Go to….
        </p>
      </Notice>
    </div>
  );
}

/**
 * The OAuth client fields are not a login: no autofill, no password generation ("new-password"
 * invites it), and password managers are asked not to save the secret (it stays on the server).
 */
const NOT_A_LOGIN = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

function ClientForm({
  status,
  onSaved,
  onCancel,
}: {
  status: GoogleStatus;
  onSaved: (next: GoogleStatus) => void;
  onCancel?: () => void;
}) {
  const rpc = useMeetingsRpc();
  const baseId = useId();
  const ids = { id: `${baseId}-id`, secret: `${baseId}-secret`, heading: `${baseId}-heading` };
  const [clientId, setClientId] = useState(status.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const save = useAsyncAction(async (input: { clientId: string; clientSecret?: string }) => {
    const next = await rpc.call("google.saveClient", input);
    setClientSecret("");
    onSaved(next);
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.pending) return;
    save.setError(null);
    const id = clientId.trim();
    const secret = clientSecret.trim();
    let problem: string | null = null;
    if (id.length < 10) problem = "Вставьте Client ID из Google Cloud (…apps.googleusercontent.com)";
    else if (/^GOCSPX-/i.test(id))
      problem = "Это похоже на Client Secret — Client ID оканчивается на .apps.googleusercontent.com";
    else if (secret === "" && !status.configured) problem = "Вставьте Client Secret";
    // The secret belongs to one client: the saved one would not work with another Client ID.
    else if (secret === "" && id !== status.clientId)
      problem = "Client Secret относится к конкретному OAuth-клиенту — при смене Client ID вставьте и его Client Secret";
    else if (secret !== "" && secret.length < 5) problem = "Client Secret слишком короткий";
    else if (id.length > 300 || secret.length > 300) problem = "Слишком длинное значение";
    setValidation(problem);
    if (problem !== null) return;
    void save.run(secret === "" ? { clientId: id } : { clientId: id, clientSecret: secret });
  };
  return (
    <form onSubmit={submit} aria-labelledby={ids.heading} className="space-y-2" noValidate>
      <h3 id={ids.heading} className="text-xs font-medium text-foreground">
        OAuth-клиент Google
      </h3>
      <div className="space-y-1">
        <label htmlFor={ids.id} className="text-xs text-muted-foreground">
          Client ID
        </label>
        <Input
          id={ids.id}
          value={clientId}
          placeholder="1234567890-abc.apps.googleusercontent.com"
          spellCheck={false}
          {...NOT_A_LOGIN}
          maxLength={300}
          className="h-8 font-mono text-xs"
          onChange={(event) => setClientId(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.secret} className="text-xs text-muted-foreground">
          Client Secret
        </label>
        <Input
          id={ids.secret}
          type="password"
          value={clientSecret}
          placeholder={
            status.configured && clientId.trim() === status.clientId ? "Оставьте пустым, чтобы не менять" : "GOCSPX-…"
          }
          spellCheck={false}
          {...NOT_A_LOGIN}
          maxLength={300}
          className="h-8 font-mono text-xs"
          onChange={(event) => setClientSecret(event.target.value)}
        />
      </div>
      <ErrorText className="text-xs">{validation ?? save.error}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.pending}>
          {save.pending ? <Spinner /> : null}
          Сохранить
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" size="sm" variant="ghost" disabled={save.pending} onClick={onCancel}>
            Отмена
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Секрет хранится в настройках плагина на сервере bb и на страницу не возвращается.
      </p>
    </form>
  );
}

/** Not configured: what Google Calendar gives, then (on demand) the setup steps and the client form. */
function GoogleSetup({
  status,
  onStatus,
  onCalendarChanged,
}: {
  status: GoogleStatus;
  onStatus: (next: GoogleStatus) => void;
  onCalendarChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  // The client keys were removed from the settings while a connection was stored.
  const stored = hasGoogleConnection(status);
  return (
    <>
      <div className="flex items-start gap-3">
        <Icon name="Calendar" className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">Google Календарь не подключён</p>
          <p className="text-muted-foreground">
            Бот сам заходит на Zoom-встречи из вашего календаря. Нужен свой OAuth-клиент Google — это бесплатно и
            занимает несколько минут.
          </p>
        </div>
      </div>
      {status.lastError === null ? null : <p className="text-warning-text">{status.lastError}</p>}
      <LeftoverEvents status={status} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={open ? "ghost" : "outline"}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4" aria-hidden />
          {open ? "Свернуть" : "Настроить подключение"}
        </Button>
        {stored ? (
          <DisconnectButton broken={!status.connected} onStatus={onStatus} onCalendarChanged={onCalendarChanged} />
        ) : null}
      </div>
      {open ? (
        <div id={regionId} className="space-y-4">
          <SetupSteps status={status} />
          <ClientForm status={status} onSaved={onStatus} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The OAuth consent: google.authStart, Google's page in a new tab, then waiting for the callback (the
 * meetings.google signal, plus polling google.status in case the signal is missed).
 */
function useGoogleAuth(status: GoogleStatus | null, refetch: () => void) {
  const rpc = useMeetingsRpc();
  const latestStatus = useLatest(status);
  const [pending, setPending] = useState<{ url: string; connectedAt: number | null; consentAt: number | null } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [slowPoll, setSlowPoll] = useState(false);
  const start = useAsyncAction(async () => {
    setTimedOut(false);
    setRefused(null);
    const before = latestStatus.current;
    const result = await rpc.call("google.authStart", { origin: currentOrigin() });
    // The server reports the consent itself: a new connectedAt (success) or a new lastConsent (refusal, error).
    setPending({
      url: result.authUrl,
      connectedAt: before?.connectedAt ?? null,
      consentAt: before?.lastConsent?.at ?? null,
    });
    // "noopener" makes window.open return null even when the tab opened, so a link stays as the fallback.
    window.open(result.authUrl, "_blank", "noopener,noreferrer");
  });
  const waiting = pending !== null;
  // A refused or failed consent changes nothing on the server, so polling backs off after a minute;
  // coming back to this tab checks at once.
  useInterval(refetch, waiting ? (slowPoll ? AUTH_SLOW_POLL_MS : AUTH_POLL_MS) : null);
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waiting, refetch]);
  // Done when the callback stored a new connection, or reported a refusal or error for this consent.
  useEffect(() => {
    if (pending === null || status === null) return;
    if (status.connected && status.connectedAt !== null && status.connectedAt !== pending.connectedAt) {
      setPending(null);
      return;
    }
    const consent = status.lastConsent;
    if (consent !== null && consent.at !== pending.consentAt) {
      setPending(null);
      if (!consent.ok) setRefused(consent.message);
    }
  }, [status, pending]);
  useEffect(() => {
    if (pending === null) return;
    setSlowPoll(false);
    const slow = setTimeout(() => setSlowPoll(true), AUTH_FAST_POLL_FOR_MS);
    const timer = setTimeout(() => {
      setPending(null);
      setTimedOut(true);
    }, AUTH_WAIT_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(timer);
    };
  }, [pending]);
  const cancel = useCallback(() => setPending(null), []);
  return { start, authUrl: pending?.url ?? null, timedOut, refused, cancel };
}

type GoogleAuth = ReturnType<typeof useGoogleAuth>;

/** "Ждём подтверждения…" with the fallback link, or the timeout notice. */
function AuthProgress({ auth }: { auth: GoogleAuth }) {
  if (auth.authUrl !== null) {
    return (
      <div role="status" className="space-y-1 rounded-md bg-surface-recessed p-2.5">
        <p className="flex items-center gap-2 text-foreground">
          <Spinner /> Ждём подтверждения в Google…
        </p>
        <p className="text-xs text-muted-foreground">
          Разрешите доступ к календарю в открывшейся вкладке. Вкладка не открылась?{" "}
          <ExternalLink href={auth.authUrl}>Открыть страницу Google</ExternalLink>
        </p>
        <p className="text-xs text-muted-foreground">
          Отказ или ошибку Google мы покажем здесь. Если вкладку Google закрыли, не завершив вход, нажмите «Не ждать».
        </p>
      </div>
    );
  }
  if (auth.refused !== null) {
    return <p role="alert" className="text-destructive-text">{auth.refused}</p>;
  }
  if (auth.timedOut) {
    return <p className="text-warning-text">Подтверждение от Google не пришло — попробуйте подключить ещё раз.</p>;
  }
  return null;
}

function AuthButtons({ auth, label }: { auth: GoogleAuth; label: string }) {
  const waiting = auth.authUrl !== null;
  return (
    <>
      <Button type="button" size="sm" disabled={auth.start.pending} onClick={() => void auth.start.run()}>
        {auth.start.pending ? <Spinner /> : <Icon name="ExternalLink" className="size-4" aria-hidden />}
        {waiting ? "Открыть вход заново" : label}
      </Button>
      {waiting ? (
        <Button type="button" size="sm" variant="ghost" onClick={auth.cancel}>
          Не ждать
        </Button>
      ) : null}
    </>
  );
}

/**
 * "Отключить" with its confirmation: google.disconnect revokes and deletes the stored connection,
 * a broken one included, and cancels the bots still scheduled from Google calendars.
 */
function DisconnectButton({
  broken,
  onStatus,
  onCalendarChanged,
}: {
  /** The stored connection no longer works (nothing left to revoke). */
  broken: boolean;
  onStatus: (next: GoogleStatus) => void;
  onCalendarChanged: () => void;
}) {
  const rpc = useMeetingsRpc();
  const [confirm, setConfirm] = useState(false);
  const disconnect = useAsyncAction(async () => {
    const next = await rpc.call("google.disconnect");
    setConfirm(false);
    onStatus(next);
    onCalendarChanged();
  });
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          disconnect.setError(null);
          setConfirm(true);
        }}
      >
        Отключить
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => {
          setConfirm(open);
          if (!open) disconnect.setError(null);
        }}
        title="Отключить Google Календарь?"
        description={
          broken
            ? "Сохранённое подключение будет удалено, а ещё не начавшиеся записи из Google Календаря — отменены. Ключи OAuth-клиента останутся, подключиться снова можно в любой момент."
            : "Доступ к календарю будет отозван, а ещё не начавшиеся записи из Google Календаря — отменены. Ключи OAuth-клиента останутся, подключиться снова можно в любой момент."
        }
        confirmLabel="Отключить"
        destructive
        pending={disconnect.pending}
        error={disconnect.error}
        onConfirm={() => void disconnect.run()}
      />
    </>
  );
}

/** A broken connection still holds Google events (and their bots): say so next to "Отключить". */
function LeftoverEvents({ status }: { status: GoogleStatus }) {
  const count = status.upcomingCount;
  if (status.connected || count === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count} {pluralRu(count, "встреча", "встречи", "встреч")} из Google в ближайшие сутки{" "}
      {pluralRu(count, "остаётся", "остаются", "остаются")} в «Запланированных», пока вы не подключите календарь
      заново или не отключите его.
    </p>
  );
}

/** Configured, not connected: start the consent; the client keys can be changed here. */
function GoogleConnect({
  status,
  auth,
  onStatus,
  onCalendarChanged,
}: {
  status: GoogleStatus;
  auth: GoogleAuth;
  onStatus: (next: GoogleStatus) => void;
  onCalendarChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const formId = useId();
  const stored = hasGoogleConnection(status);
  return (
    <>
      <div className="flex items-start gap-3">
        <Icon name="Calendar" className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">Google Календарь не подключён</p>
          <p className="text-muted-foreground">
            OAuth-клиент сохранён. Подключите аккаунт Google, чтобы бот видел встречи из календаря.
          </p>
          {status.clientId === "" ? null : (
            <p className="break-all text-xs text-muted-foreground">
              Client ID: <span className="font-mono">{status.clientId}</span>
            </p>
          )}
        </div>
      </div>
      {status.lastError === null ? null : <p className="text-warning-text">{status.lastError}</p>}
      <LeftoverEvents status={status} />
      <AuthProgress auth={auth} />
      <div className="flex flex-wrap gap-2">
        <AuthButtons auth={auth} label="Подключить Google Календарь" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={editing}
          aria-controls={formId}
          onClick={() => setEditing((value) => !value)}
        >
          Изменить ключи
        </Button>
        {stored ? <DisconnectButton broken onStatus={onStatus} onCalendarChanged={onCalendarChanged} /> : null}
      </div>
      <ErrorText>{auth.start.error}</ErrorText>
      {editing ? (
        <div id={formId}>
          <ClientForm
            status={status}
            onSaved={(next) => {
              setEditing(false);
              onStatus(next);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : null}
      <RedirectUri status={status} label="Адрес перенаправления (Authorized redirect URI в OAuth-клиенте):" />
    </>
  );
}

function CalendarPicker({
  calendars,
  onStatus,
  onCalendarChanged,
}: {
  calendars: GoogleCalendarView[];
  onStatus: (next: GoogleStatus) => void;
  onCalendarChanged: () => void;
}) {
  const rpc = useMeetingsRpc();
  const legendId = useId();
  const save = useAsyncAction(async (calendarIds: string[]) => {
    onStatus(await rpc.call("google.setCalendars", { calendarIds }));
    onCalendarChanged();
  });
  const selected = calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id);
  const full = selected.length >= MAX_CALENDARS;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((other) => other !== id);
    void save.run(calendars.map((calendar) => calendar.id).filter((other) => next.includes(other)));
  };
  return (
    <div role="group" aria-labelledby={legendId} className="space-y-1.5">
      <p id={legendId} className="flex items-center gap-2 text-xs font-medium text-foreground">
        Календари для автоподключения
        {save.pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      </p>
      {calendars.length === 0 ? (
        <p className="text-xs text-muted-foreground">Список календарей ещё не получен — нажмите «Синхронизировать».</p>
      ) : (
        <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {calendars.map((calendar) => (
            <li key={calendar.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <Checkbox
                id={`${legendId}-${calendar.id}`}
                checked={calendar.selected}
                disabled={save.pending || (full && !calendar.selected)}
                aria-label={calendar.summary}
                onCheckedChange={(checked) => toggle(calendar.id, checked === true)}
              />
              <span
                className="size-2.5 shrink-0 rounded-full border border-border"
                style={calendar.color === null ? undefined : { backgroundColor: calendar.color }}
                aria-hidden
              />
              <label
                htmlFor={`${legendId}-${calendar.id}`}
                className="min-w-0 flex-1 cursor-pointer truncate text-foreground"
              >
                {calendar.summary}
              </label>
              {calendar.primary ? <span className="shrink-0 text-xs text-muted-foreground">основной</span> : null}
            </li>
          ))}
        </ul>
      )}
      {calendars.length > 0 && selected.length === 0 ? (
        <p className="text-xs text-warning-text">
          Не выбран ни один календарь — бот не будет подключаться к встречам из Google.
        </p>
      ) : null}
      {full ? (
        <p className="text-xs text-muted-foreground">Можно выбрать не больше {MAX_CALENDARS} календарей.</p>
      ) : null}
      <ErrorText className="text-xs">{save.error}</ErrorText>
    </div>
  );
}

/** calendarAutoJoin is shared with the ICS feeds: a toggle plus the lead time. */
function AutoJoinInfo({ calendar, onChanged }: { calendar: CalendarStatus | null; onChanged: () => void }) {
  const rpc = useMeetingsRpc();
  const { values } = useSettings();
  const toggleId = useId();
  const toggle = useAsyncAction(async (autoJoin: boolean) => {
    await rpc.call("calendar.setAutoJoin", { autoJoin });
    onChanged();
  });
  const lead = values?.calendarLeadMinutes;
  const leadText =
    typeof lead !== "number"
      ? null
      : lead === 0
        ? "бот заходит к началу встречи"
        : `бот заходит за ${lead} мин до начала`;
  if (calendar === null) return null;
  return (
    <div className="space-y-1 rounded-md bg-surface-recessed p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Checkbox
          id={toggleId}
          checked={calendar.autoJoin}
          disabled={toggle.pending}
          onCheckedChange={(checked) => void toggle.run(checked === true)}
        />
        <label htmlFor={toggleId} className="cursor-pointer select-none text-foreground">
          Автоматически подключать бота к встречам из календаря
        </label>
        {toggle.pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      </div>
      <p className="text-muted-foreground">
        {calendar.autoJoin
          ? `Бот сам заходит во встречи со ссылкой Zoom${leadText !== null ? ` (${leadText})` : ""} и выходит, когда созвон закончился.`
          : "Встречи из календаря видны в «Запланированных», но бот к ним сам не подключается."}{" "}
        Настройка общая для Google и ICS-календарей.
      </p>
      <p className="text-muted-foreground">
        Время захода — настройка <code className="font-mono">calendarLeadMinutes</code>, фильтр по названию —{" "}
        <code className="font-mono">calendarFilter</code>.
      </p>
      <ErrorText className="text-xs">{toggle.error}</ErrorText>
    </div>
  );
}

function GoogleConnected({
  status,
  calendar,
  auth,
  onStatus,
  onCalendarChanged,
}: {
  status: GoogleStatus;
  calendar: CalendarStatus | null;
  auth: GoogleAuth;
  onStatus: (next: GoogleStatus) => void;
  onCalendarChanged: () => void;
}) {
  const rpc = useMeetingsRpc();
  const sync = useAsyncAction(async () => {
    onStatus(await rpc.call("google.sync"));
    onCalendarChanged();
  });
  const count = status.upcomingCount;
  return (
    <>
      <div className="flex items-start gap-3">
        <Icon name="CircleCheck" className="mt-0.5 size-4 text-success-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">
            Google Календарь подключён
            {status.email === null ? null : <span className="break-all font-normal"> · {status.email}</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.lastSyncAt === null
              ? "Ещё не синхронизирован"
              : `Синхронизирован ${formatDateTime(status.lastSyncAt)}`}
            {" · "}
            {count === 0
              ? "Zoom-встреч в ближайшие сутки нет"
              : `${count} ${pluralRu(count, "Zoom-встреча", "Zoom-встречи", "Zoom-встреч")} в ближайшие сутки`}
          </p>
        </div>
      </div>
      {status.lastError === null ? null : <p className="text-warning-text">{status.lastError}</p>}
      <AuthProgress auth={auth} />
      <CalendarPicker calendars={status.calendars} onStatus={onStatus} onCalendarChanged={onCalendarChanged} />
      <AutoJoinInfo calendar={calendar} onChanged={onCalendarChanged} />
      <div className="flex flex-wrap gap-2">
        {status.lastError === null && auth.authUrl === null ? null : (
          <AuthButtons auth={auth} label="Подключить заново" />
        )}
        <Button type="button" size="sm" variant="outline" disabled={sync.pending} onClick={() => void sync.run()}>
          {sync.pending ? <Spinner /> : <Icon name="RotateCcw" className="size-4" aria-hidden />}
          Синхронизировать
        </Button>
        <DisconnectButton broken={false} onStatus={onStatus} onCalendarChanged={onCalendarChanged} />
      </div>
      <ErrorText>{sync.error ?? auth.start.error}</ErrorText>
    </>
  );
}

export function GoogleCalendarCard({
  google,
  calendar,
  onCalendarChanged,
}: {
  google: GoogleStatusState;
  calendar: CalendarStatus | null;
  /** Google changes the calendar.status list: refetch it. */
  onCalendarChanged: () => void;
}) {
  const { status, error, update, refetch } = google;
  const auth = useGoogleAuth(status, refetch);
  return (
    <Section title="Google Календарь">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
        {status === null ? (
          error === null ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Проверяем Google Календарь…
            </p>
          ) : (
            <ErrorText>Не удалось получить состояние Google Календаря: {error}</ErrorText>
          )
        ) : !status.configured ? (
          <GoogleSetup status={status} onStatus={update} onCalendarChanged={onCalendarChanged} />
        ) : !status.connected ? (
          <GoogleConnect status={status} auth={auth} onStatus={update} onCalendarChanged={onCalendarChanged} />
        ) : (
          <GoogleConnected
            status={status}
            calendar={calendar}
            auth={auth}
            onStatus={update}
            onCalendarChanged={onCalendarChanged}
          />
        )}
      </div>
    </Section>
  );
}
