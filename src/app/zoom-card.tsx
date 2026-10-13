// Zoom account card on the list page (zoom.status / loginStart / logout) and
// the shared zoom-status hook.
import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { ZoomStatus } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { CHANNEL_ZOOM_CHANGED } from "./constants";
import { formatDateTime } from "./format";
import { useAsyncAction, useDebouncedCallback, useInterval, useMountedRef, useOnReconnect } from "./hooks";
import { botDetailText, loginPhaseText } from "./labels";
import { messageOf, useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { ConfirmDialog, ErrorText, Section, Spinner } from "./ui";

type ZoomSession = NonNullable<ZoomStatus["session"]>;

/**
 * The sign-in bot is still running. The server keeps a finished session (phase "ended" or "failed")
 * in zoom.status for a while to show its outcome; it has no browser to drive any more.
 */
export function sessionRunning(session: ZoomSession | null): boolean {
  return session !== null && session.phase !== "ended" && session.phase !== "failed";
}

/** What a finished sign-in session ended with, when it did not sign in (null: nothing to report). */
export function sessionProblem(session: ZoomSession | null, signedIn: boolean): string | null {
  if (session === null || signedIn || sessionRunning(session)) return null;
  return session.phase === "failed"
    ? (botDetailText(session.detail) ?? loginPhaseText(session.phase))
    : (botDetailText(session.detail) ?? "Сеанс закрыт, вход в Zoom не выполнен");
}

export function useZoomStatus(pollMs: number | null = null) {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [status, setStatus] = useState<ZoomStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("zoom.status").then(
      (result) => {
        if (!mounted.current) return;
        setStatus(result);
        setError(null);
      },
      (cause: unknown) => {
        if (mounted.current) setError(messageOf(cause));
      },
    );
  }, [rpc, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  useRealtime(CHANNEL_ZOOM_CHANGED, debounced);
  useOnReconnect(refetch);
  useInterval(refetch, pollMs);
  const update = useCallback(
    (next: ZoomStatus) => {
      if (mounted.current) setStatus(next);
    },
    [mounted],
  );
  return { status, error, refetch, update };
}

/** Starts a sign-in session (or reuses the running one) and opens its page. */
export function useZoomLoginStart(nav: MeetingsNav) {
  const rpc = useMeetingsRpc();
  return useAsyncAction(async () => {
    await rpc.call("zoom.loginStart");
    nav.toZoomLogin();
  });
}

export function ZoomAccountCard({ nav }: { nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const { status, error, update } = useZoomStatus();
  const login = useZoomLoginStart(nav);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const running = status !== null && sessionRunning(status.session);
  const problem = status === null ? null : sessionProblem(status.session, status.profile.signedIn);
  const logout = useAsyncAction(async () => {
    update(await rpc.call("zoom.logout"));
    setConfirmLogout(false);
  });
  return (
    <Section title="Аккаунт Zoom">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
        {status === null ? (
          error === null ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Проверяем вход в Zoom…
            </p>
          ) : (
            <ErrorText>Не удалось получить состояние Zoom: {error}</ErrorText>
          )
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Icon
                name={status.profile.signedIn ? "CircleCheck" : "UserRound"}
                className={
                  status.profile.signedIn
                    ? "mt-0.5 size-4 text-success-foreground"
                    : "mt-0.5 size-4 text-muted-foreground"
                }
                aria-hidden
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium text-foreground">
                  {status.profile.signedIn
                    ? "Вход в Zoom выполнен"
                    : status.profile.exists
                      ? "Профиль Zoom есть, но вход не выполнен"
                      : "Вход в Zoom не выполнен"}
                  {status.profile.signedIn && status.profile.updatedAt !== null ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · обновлён {formatDateTime(status.profile.updatedAt)}
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-foreground">
                  {status.useZoomAccount
                    ? "Боты подключаются к встречам под этим аккаунтом Zoom."
                    : "Боты подключаются как гости, без аккаунта."}
                </p>
                {status.useZoomAccount ? (
                  status.profile.signedIn ? null : (
                    <p className="text-warning-text">
                      Настройка useZoomAccount включена, но вход не выполнен — войдите, иначе боты пойдут гостями.
                    </p>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Zoom может не пускать гостевых ботов. Чтобы боты входили под аккаунтом, войдите и включите
                    настройку:{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      bb plugin config meetings set useZoomAccount true
                    </code>
                  </p>
                )}
              </div>
            </div>
            {running ? (
              <p role="status" className="flex items-center gap-2 text-muted-foreground">
                <Spinner /> Идёт сеанс входа · {loginPhaseText(status.session?.phase ?? null)}
              </p>
            ) : null}
            {problem === null ? null : <p className="text-warning-text">Вход не выполнен: {problem}</p>}
            <div className="flex flex-wrap gap-2">
              {!running ? (
                <Button type="button" size="sm" disabled={login.pending} onClick={() => void login.run()}>
                  {login.pending ? <Spinner /> : <Icon name="SquareUnlock02" className="size-4" aria-hidden />}
                  {status.profile.signedIn ? "Войти заново" : "Войти в Zoom"}
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={nav.toZoomLogin}>
                  Открыть сеанс входа
                </Button>
              )}
              {status.profile.exists ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmLogout(true)}>
                  Выйти из Zoom
                </Button>
              ) : null}
            </div>
            <ErrorText>{login.error}</ErrorText>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={(open) => {
          setConfirmLogout(open);
          if (!open) logout.setError(null);
        }}
        title="Выйти из Zoom?"
        description="Сохранённый профиль Zoom будет удалён. Боты будут подключаться как гости, пока вы снова не войдёте."
        confirmLabel="Выйти"
        destructive
        pending={logout.pending}
        error={logout.error}
        onConfirm={() => void logout.run()}
      />
    </Section>
  );
}
