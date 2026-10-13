// Environment banner on the list page: missing runtime pieces (env.status),
// "Установить компоненты" (env.setup) with progress and log, and GigaAM state.
import { useCallback, useEffect, useId, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { EnvItem, EnvReport } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { CHANNEL_ENV_CHANGED } from "./constants";
import { formatDuration } from "./format";
import { useAsyncAction, useDebouncedCallback, useInterval, useMountedRef, useNow, useOnReconnect } from "./hooks";
import { messageOf, useMeetingsRpc } from "./rpc";
import { CopyButton, DisclosureButton, ErrorText, Notice, Spinner } from "./ui";

interface EnvState {
  report: EnvReport | null;
  error: string | null;
  loaded: boolean;
}

export function useEnvStatus() {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [state, setState] = useState<EnvState>({ report: null, error: null, loaded: false });
  const refetch = useCallback(() => {
    rpc.call("env.status").then(
      (result) => {
        if (mounted.current) setState({ report: result.env, error: result.error, loaded: true });
      },
      (cause: unknown) => {
        if (mounted.current) setState((prev) => ({ ...prev, error: messageOf(cause), loaded: true }));
      },
    );
  }, [rpc, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  useRealtime(CHANNEL_ENV_CHANGED, debounced);
  useOnReconnect(refetch);
  const running = state.report?.setup.phase === "running";
  useInterval(refetch, running ? 2000 : null);
  const setup = useAsyncAction(async () => {
    const result = await rpc.call("env.setup", { force: false });
    if (mounted.current) setState({ report: result.env, error: null, loaded: true });
  });
  return { ...state, refetch, setup };
}

function MissingItem({ item }: { item: EnvItem }) {
  return (
    <li className="space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{item.label}</span>
        {item.required ? null : <span className="text-xs text-muted-foreground">необязательно</span>}
      </div>
      {item.detail === "" ? null : <p className="text-xs text-muted-foreground">{item.detail}</p>}
      {item.fix === null || item.fix === "" ? null : (
        <div className="flex items-center gap-1">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-muted px-1.5 py-1 font-mono text-xs">
            {item.fix}
          </code>
          <CopyButton text={item.fix} label="Скопировать команду" />
        </div>
      )}
    </li>
  );
}

function SetupLog({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  if (text.trim() === "") return null;
  return (
    <div>
      <DisclosureButton open={open} onToggle={() => setOpen((value) => !value)} controls={regionId}>
        Журнал установки
      </DisclosureButton>
      {open ? (
        <pre
          id={regionId}
          className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs text-foreground"
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}

export function EnvBanner({ env }: { env: ReturnType<typeof useEnvStatus> }) {
  const { report, error, loaded, setup } = env;
  const now = useNow(report?.setup.phase === "running" ? 1000 : null);
  if (!loaded) return null;
  if (report === null) {
    return (
      <Notice tone="warning" title="Не удалось проверить окружение" className="mb-4">
        <p className="text-muted-foreground">{error ?? "Хост-машина не ответила."}</p>
        <Button type="button" variant="outline" size="sm" onClick={env.refetch}>
          Проверить снова
        </Button>
      </Notice>
    );
  }
  const missing = report.items.filter((item) => !item.ok && item.id !== "gigaam");
  const missingRequired = missing.filter((item) => item.required);
  const phase = report.setup.phase;
  const running = phase === "running";
  const showEnv = !report.ready && missing.length > 0;
  const showSetupResult = phase === "failed" || (running && !showEnv);
  const gigaamDown = !report.gigaam.ready;
  if (!showEnv && !showSetupResult && !gigaamDown) return null;
  return (
    <div className="mb-4 space-y-3">
      {showEnv || showSetupResult ? (
        <Notice
          tone={phase === "failed" ? "danger" : "warning"}
          title={
            running
              ? "Устанавливаем компоненты…"
              : missingRequired.length > 0
                ? "Не хватает компонентов для записи встреч"
                : phase === "failed"
                  ? "Установка компонентов не удалась"
                  : "Не хватает необязательных компонентов"
          }
        >
          {showEnv ? (
            <ul className="space-y-2" aria-label="Недостающие компоненты">
              {missing.map((item) => (
                <MissingItem key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
          {running ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner />
              <span>
                {report.setup.message || "Установка…"}
                {report.setup.startedAt === null ? null : ` · ${formatDuration((now - report.setup.startedAt) / 1000)}`}
              </span>
            </p>
          ) : phase === "failed" ? (
            <p className="text-destructive-text">{report.setup.message || "Установка завершилась с ошибкой."}</p>
          ) : null}
          {!report.sudo && showEnv ? (
            <p className="text-xs text-muted-foreground">
              Sudo без пароля недоступен: системные пакеты (Chrome, Xvfb, PulseAudio, ffmpeg) установите командами выше.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {showEnv || phase === "failed" ? (
              <Button type="button" size="sm" disabled={running || setup.pending} onClick={() => void setup.run()}>
                {running || setup.pending ? <Spinner /> : null}
                {phase === "failed" ? "Повторить установку" : "Установить компоненты"}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={env.refetch} disabled={running}>
              Проверить снова
            </Button>
          </div>
          <ErrorText>{setup.error}</ErrorText>
          <SetupLog text={report.setup.logTail} defaultOpen={phase === "failed"} />
        </Notice>
      ) : null}
      {gigaamDown ? (
        <Notice tone="warning" title="Сервер распознавания GigaAM недоступен">
          <p className="text-muted-foreground">
            Встречи записываются, но расшифровка начнётся, когда сервер запустится.
            {report.gigaam.detail === "" ? null : <> {report.gigaam.detail}</>}
          </p>
          <p className="text-xs text-muted-foreground">
            Проверьте состояние: <code className="rounded bg-muted px-1 py-0.5 font-mono">bb gigaam status</code>
          </p>
        </Notice>
      ) : null}
    </div>
  );
}
