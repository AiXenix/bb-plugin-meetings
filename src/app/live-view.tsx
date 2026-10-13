// Live view of a bot's browser (DESIGN §6.5): polls meetings.liveView every
// second while on screen, shows the latest screenshot and, in "Управление"
// mode, forwards clicks, text, keys and scrolling through meetings.control.
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import type { LiveView as LiveViewState } from "../shared/rpc-contract";
import type { ControlCommand } from "../shared/runtime-files";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { screenshotUrl } from "./constants";
import { useAsyncAction, useDocumentVisible, useInView } from "./hooks";
import { botDetailText, phaseText } from "./labels";
import { messageOf, useMeetingsRpc } from "./rpc";
import { ErrorText, Spinner } from "./ui";

type Command = Omit<ControlCommand, "seq" | "t">;

const POLL_MS = 1000;
const SCROLL_STEP = 400;
const KEYS: ReadonlyArray<{ key: string; label: string; aria: string }> = [
  { key: "Enter", label: "Enter", aria: "Нажать Enter" },
  { key: "Tab", label: "Tab", aria: "Нажать Tab" },
  { key: "Escape", label: "Esc", aria: "Нажать Escape" },
  { key: "Backspace", label: "⌫", aria: "Нажать Backspace" },
];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Polls the live view while `active`; `pollSoon()` asks for a fresh state right away. */
function useLiveViewPoll(id: string, active: boolean) {
  const rpc = useMeetingsRpc();
  const [view, setView] = useState<LiveViewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollSoon = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const tick = async () => {
      timer = null;
      try {
        const next = await rpc.call("meetings.liveView", { id });
        if (cancelled) return;
        failures = 0;
        setView(next);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        failures += 1;
        setError(messageOf(cause));
      }
      if (!cancelled) timer = setTimeout(tick, failures === 0 ? POLL_MS : Math.min(10_000, POLL_MS * 2 ** failures));
    };
    pollSoon.current = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = setTimeout(tick, 300);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      pollSoon.current = () => {};
    };
  }, [rpc, id, active]);
  return { view, error, pollSoon: () => pollSoon.current() };
}

export function LiveView({
  id,
  defaultControl = false,
  defaultOpen = true,
  title = "Живой просмотр",
  describePhase = phaseText,
  actions,
  className,
}: {
  id: string;
  defaultControl?: boolean;
  /**
   * Start collapsed (no polling, so the bot does not screenshot every second) when false. Turning false
   * later (say, the recording started) collapses an open view once; the user can open it again.
   */
  defaultOpen?: boolean;
  title?: string;
  /** Russian text for the bot's phase (the Zoom sign-in session has its own). */
  describePhase?: (phase: string | null) => string | null;
  /** Extra buttons in the header (e.g. "Готово" for the Zoom sign-in). */
  actions?: ReactNode;
  className?: string;
}) {
  const rpc = useMeetingsRpc();
  const containerRef = useRef<HTMLElement>(null);
  const visible = useDocumentVisible();
  const inView = useInView(containerRef);
  const [open, setOpen] = useState(defaultOpen);
  const [lastDefaultOpen, setLastDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== lastDefaultOpen) {
    setLastDefaultOpen(defaultOpen);
    if (!defaultOpen) setOpen(false);
  }
  const { view, error, pollSoon } = useLiveViewPoll(id, open && visible && inView);
  const [control, setControl] = useState(defaultControl);
  const [text, setText] = useState("");
  const [marker, setMarker] = useState<{ x: number; y: number; at: number } | null>(null);
  const [failedVersion, setFailedVersion] = useState<number | null>(null);
  const hintId = useId();
  const textId = useId();
  const bodyId = useId();

  const send = useAsyncAction(async (command: Command) => {
    const { queued } = await rpc.call("meetings.control", { id, ...command });
    pollSoon();
    // The bot exited since the last poll: nothing will act on the command.
    if (!queued) throw new Error("бот не запущен");
    return true;
  });

  useEffect(() => {
    if (marker === null) return;
    const timer = setTimeout(() => setMarker(null), 800);
    return () => clearTimeout(timer);
  }, [marker]);

  const version = view?.screenshotVersion ?? null;
  const controllable = view?.controllable === true;
  const controlling = open && control && controllable;

  const onImageClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!controlling) return;
    const image = event.currentTarget;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Map the displayed point to screenshot pixels (= the bot's viewport CSS pixels).
    const relX = clamp01((event.clientX - rect.left) / rect.width);
    const relY = clamp01((event.clientY - rect.top) / rect.height);
    const naturalWidth = image.naturalWidth || 1280;
    const naturalHeight = image.naturalHeight || 720;
    setMarker({ x: relX * 100, y: relY * 100, at: Date.now() });
    void send.run({
      action: "click",
      x: Math.min(4000, Math.round(relX * naturalWidth)),
      y: Math.min(4000, Math.round(relY * naturalHeight)),
    });
  };

  const typeText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (text === "" || !controlling) return;
    void send.run({ action: "type", text }).then((sent) => {
      if (sent === true) setText("");
    });
  };

  const phase = describePhase(view?.phase ?? null);
  const shownDetail = botDetailText(view?.detail ?? null);
  const detail = shownDetail === phase ? null : shownDetail;
  return (
    <section
      ref={containerRef}
      aria-label={title}
      className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}
    >
      <div className={cn("flex flex-wrap items-center gap-2 px-3 py-2", open && "border-b border-border")}>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {open ? (phase ?? "") : "Скрыт — снимки экрана не запрашиваются"}
          {!open || detail === null ? "" : `${phase === null ? "" : " — "}${detail}`}
        </span>
        {open ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="aria-pressed:bg-state-active aria-pressed:text-foreground"
            aria-pressed={controlling}
            disabled={!controllable}
            onClick={() => setControl((value) => !value)}
          >
            <Icon name="Target" className="size-3.5" aria-hidden />
            Управление
          </Button>
        ) : null}
        {actions}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "EyeOff" : "Eye"} className="size-3.5" aria-hidden />
          {open ? "Скрыть" : "Показать"}
        </Button>
      </div>
      {open ? (
        <div id={bodyId}>
          <div className="bg-muted">
            <div className={cn("relative mx-auto", controlling ? "max-w-none" : "max-w-2xl")}>
              {version === null || failedVersion === version ? (
                <div className="flex aspect-video w-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
                  {view === null ? (
                    error === null ? (
                      <span className="inline-flex items-center gap-2">
                        <Spinner /> Подключаемся к живому просмотру…
                      </span>
                    ) : (
                      "Живой просмотр недоступен"
                    )
                  ) : version === null ? (
                    "Снимок экрана появится, когда бот откроет браузер"
                  ) : (
                    "Не удалось загрузить снимок экрана"
                  )}
                </div>
              ) : (
                <img
                  src={screenshotUrl(id, version)}
                  alt={controlling ? "Экран бота: клик по изображению повторится в браузере бота" : "Экран бота"}
                  aria-describedby={controlling ? hintId : undefined}
                  draggable={false}
                  onClick={onImageClick}
                  onError={() => setFailedVersion(version)}
                  className={cn("block h-auto w-full select-none", controlling && "cursor-crosshair")}
                />
              )}
              {marker === null ? null : (
                <span
                  key={marker.at}
                  aria-hidden
                  className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-destructive"
                  style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
                />
              )}
            </div>
          </div>
          {view !== null && !controllable ? (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Бот сейчас не принимает команды — управление недоступно.
            </p>
          ) : null}
          {controlling ? (
            <div className="space-y-2 border-t border-border p-2">
              <p id={hintId} className="text-xs text-muted-foreground">
                Кликните по снимку — клик повторится в браузере бота. Снимок обновляется примерно раз в секунду.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <form onSubmit={typeText} className="flex min-w-0 flex-1 basis-56 gap-2">
                  <label htmlFor={textId} className="sr-only">
                    Текст для ввода в браузере бота
                  </label>
                  <Input
                    id={textId}
                    value={text}
                    maxLength={2000}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="Текст для ввода"
                    className="h-8 min-w-0"
                    spellCheck={false}
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={text === "" || send.pending}>
                    Ввести
                  </Button>
                </form>
                <div role="group" aria-label="Клавиши" className="flex gap-1">
                  {KEYS.map((item) => (
                    <Button
                      key={item.key}
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={item.aria}
                      onClick={() => void send.run({ action: "key", key: item.key })}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                <div role="group" aria-label="Прокрутка" className="flex gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    aria-label="Прокрутить вверх"
                    onClick={() => void send.run({ action: "scroll", dy: -SCROLL_STEP })}
                  >
                    <Icon name="ArrowUp" className="size-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    aria-label="Прокрутить вниз"
                    onClick={() => void send.run({ action: "scroll", dy: SCROLL_STEP })}
                  >
                    <Icon name="ArrowDown" className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {error === null && send.error === null ? null : (
        <div className="border-t border-border px-3 py-2">
          <ErrorText className="text-xs">
            {send.error === null ? error : `Команда не отправлена: ${send.error}`}
          </ErrorText>
        </div>
      )}
    </section>
  );
}
