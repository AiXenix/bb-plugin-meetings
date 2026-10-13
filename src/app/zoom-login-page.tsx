// Zoom sign-in session (DESIGN §6.6): the user drives the bot's browser on
// zoom.us/signin through the live view and finishes with "Готово".
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAsyncAction } from "./hooks";
import { botDetailText, loginPhaseText } from "./labels";
import { LiveView } from "./live-view";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { EmptyState, ErrorText, Notice, PageFrame, Spinner } from "./ui";
import { sessionProblem, sessionRunning, useZoomStatus } from "./zoom-card";

const ENABLE_COMMAND = "bb plugin config meetings set useZoomAccount true";

export function ZoomLoginPage({ nav }: { nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const { status, error, update } = useZoomStatus(2000);
  const start = useAsyncAction(async () => update(await rpc.call("zoom.loginStart")));
  const finish = useAsyncAction(async () => update(await rpc.call("zoom.loginFinish")));
  const session = status?.session ?? null;
  // A finished session stays in zoom.status for a while to show how it ended; only a running one has a live view.
  const running = session !== null && sessionRunning(session);
  const sessionPhase = session === null ? null : loginPhaseText(session.phase);
  const sessionDetail = session === null ? null : botDetailText(session.detail);
  const problem = status === null ? null : sessionProblem(session, status.profile.signedIn);

  return (
    <PageFrame wide>
      <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => nav.toList()}>
        <Icon name="ArrowLeft" className="size-4" aria-hidden />
        Все встречи
      </Button>
      <h1 className="mt-2 text-lg font-semibold text-foreground">Вход в Zoom</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Бот открывает страницу входа Zoom в своём браузере. Нажимайте на снимок экрана и вводите текст через
        «Управление» — пароль вводится прямо в браузер бота на этой машине. Когда войдёте, нажмите «Готово»: профиль
        сохранится, и боты смогут подключаться к встречам под этим аккаунтом.
      </p>

      {status === null ? (
        error === null ? (
          <EmptyState className="mt-4">
            <span className="inline-flex items-center gap-2">
              <Spinner /> Проверяем сеанс входа…
            </span>
          </EmptyState>
        ) : (
          <ErrorText className="mt-4">Не удалось получить состояние Zoom: {error}</ErrorText>
        )
      ) : running && session !== null ? (
        <>
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            {sessionPhase ?? "Сеанс входа идёт"}
            {sessionDetail === null ? "" : ` — ${sessionDetail}`}
          </p>
          {session.error === null ? null : (
            <Notice tone="danger" title="Ошибка сеанса входа" className="mt-2" role="alert">
              <p className="break-words text-xs text-muted-foreground">{session.error}</p>
            </Notice>
          )}
          <LiveView
            key={session.id}
            id={session.id}
            title="Браузер бота"
            describePhase={loginPhaseText}
            defaultControl
            className="mt-3"
            actions={
              <Button type="button" size="sm" disabled={finish.pending} onClick={() => void finish.run()}>
                {finish.pending ? <Spinner /> : <Icon name="Check" className="size-3.5" aria-hidden />}
                Готово
              </Button>
            }
          />
          <ErrorText className="mt-2">{finish.error}</ErrorText>
        </>
      ) : status.profile.signedIn ? (
        <Notice tone="success" title="Вход в Zoom выполнен" className="mt-4">
          {status.useZoomAccount ? (
            <p className="text-muted-foreground">Боты будут подключаться к встречам под этим аккаунтом.</p>
          ) : (
            <p className="text-muted-foreground">
              Чтобы боты подключались под этим аккаунтом, включите настройку:{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{ENABLE_COMMAND}</code>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => nav.toList()}>
              К встречам
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={start.pending} onClick={() => void start.run()}>
              {start.pending ? <Spinner /> : null}
              Войти заново
            </Button>
          </div>
          <ErrorText>{start.error}</ErrorText>
        </Notice>
      ) : (
        <Notice
          tone={problem === null ? "info" : "warning"}
          title={problem === null ? "Сеанс входа не запущен" : "Вход в Zoom не выполнен"}
          className="mt-4"
        >
          {problem === null ? null : <p className="break-words text-foreground">{problem}</p>}
          {problem === null || session === null || session.error === null ? null : (
            <p className="break-words text-xs text-muted-foreground">{session.error}</p>
          )}
          <p className="text-muted-foreground">Бот откроет страницу входа Zoom; сеанс длится до 15 минут.</p>
          <div>
            <Button type="button" size="sm" disabled={start.pending} onClick={() => void start.run()}>
              {start.pending ? <Spinner /> : <Icon name="SquareUnlock02" className="size-4" aria-hidden />}
              {problem === null ? "Начать вход" : "Начать вход заново"}
            </Button>
          </div>
          <ErrorText>{start.error}</ErrorText>
        </Notice>
      )}
    </PageFrame>
  );
}
