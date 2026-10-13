// The transcript: speaker turns with timestamps (click → seek), the playing
// segment highlighted, in-transcript search, deep-link focus and auto-scroll
// while live. Turns are memoized blocks with `content-visibility: auto`, and
// highlights (playing segment, current match, deep link) reach only the
// affected turns through a tiny store, so a three-hour meeting stays cheap to
// render, scroll and play along.
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { SegmentView } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "./format";
import { useLatest } from "./hooks";
import { colorFor } from "./speaker-colors";
import type { Turn } from "./transcript-model";
import { extendTurns, findMatches, searchPattern, splitHighlight } from "./transcript-model";
import { EmptyState, ErrorText, Notice, Section, Spinner } from "./ui";

const TURN_STYLE: CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 88px" };

/** Scroll `element` to the middle of the scroll box without moving the page. */
function scrollWithin(box: HTMLElement, element: HTMLElement): void {
  const boxRect = box.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const offset = rect.top - boxRect.top - (box.clientHeight - Math.min(rect.height, box.clientHeight)) / 2;
  box.scrollTop += offset;
}

function inTurn(turn: Turn, id: number | null): number | null {
  return id !== null && id >= turn.firstId && id <= turn.lastId ? id : null;
}

interface Highlights {
  /** Segment under the playhead. */
  active: number | null;
  /** Deep-linked segment. */
  focus: number | null;
  /** Current in-transcript search match. */
  match: number | null;
}

/** Highlight state outside React props: a change re-renders only the turns it touches. */
class HighlightStore {
  private state: Highlights = { active: null, focus: null, match: null };
  private readonly listeners = new Set<() => void>();

  set(next: Highlights): void {
    const prev = this.state;
    if (prev.active === next.active && prev.focus === next.focus && prev.match === next.match) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** A primitive snapshot per turn, so untouched turns compare equal and skip rendering. */
  snapshotFor(turn: Turn): string {
    const { active, focus, match } = this.state;
    return `${inTurn(turn, active)}|${inTurn(turn, focus)}|${inTurn(turn, match)}`;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function useTurnHighlights(store: HighlightStore, turn: Turn): Highlights {
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshotFor(turn));
  const [active, focus, match] = snapshot.split("|").map((part) => (part === "null" ? null : Number(part)));
  return { active: active ?? null, focus: focus ?? null, match: match ?? null };
}

const TurnBlock = memo(function TurnBlock({
  turn,
  label,
  color,
  highlights,
  pattern,
  onSeek,
}: {
  turn: Turn;
  label: string;
  color: string;
  highlights: HighlightStore;
  pattern: RegExp | null;
  onSeek: ((seconds: number) => void) | null;
}) {
  const { active: activeId, focus: focusId, match: matchId } = useTurnHighlights(highlights, turn);
  const stamp = formatTimestamp(turn.start);
  return (
    <div data-turn={turn.key} className="py-1.5" style={TURN_STYLE}>
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">{label}</span>
        {onSeek === null ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">[{stamp}]</span>
        ) : (
          <button
            type="button"
            onClick={() => onSeek(turn.start)}
            aria-label={`Воспроизвести с ${stamp}`}
            className="shrink-0 rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            [{stamp}]
          </button>
        )}
      </div>
      <p className="mt-0.5 border-l-2 pl-3 text-sm leading-relaxed text-foreground" style={{ borderColor: color }}>
        {turn.segments.map((segment) => (
          <SegmentText
            key={segment.id}
            segment={segment}
            active={segment.id === activeId}
            focused={segment.id === focusId}
            current={segment.id === matchId}
            pattern={pattern}
            onSeek={onSeek}
          />
        ))}
      </p>
    </div>
  );
});

function SegmentText({
  segment,
  active,
  focused,
  current,
  pattern,
  onSeek,
}: {
  segment: SegmentView;
  active: boolean;
  focused: boolean;
  current: boolean;
  pattern: RegExp | null;
  onSeek: ((seconds: number) => void) | null;
}) {
  const parts = useMemo(() => splitHighlight(segment.text, pattern), [segment.text, pattern]);
  return (
    <>
      <span
        data-seg={segment.id}
        title={
          onSeek === null
            ? formatTimestamp(segment.start)
            : `${formatTimestamp(segment.start)} — нажмите, чтобы воспроизвести`
        }
        onClick={
          onSeek === null
            ? undefined
            : () => {
                // Selecting text must not jump the player.
                const selection = window.getSelection();
                if (selection !== null && !selection.isCollapsed) return;
                onSeek(segment.start);
              }
        }
        className={cn(
          "rounded-sm transition-colors",
          onSeek !== null && "cursor-pointer hover:bg-state-hover",
          active && "bg-surface-selected",
          focused && "bg-surface-attention ring-1 ring-attention",
          current && "ring-2 ring-ring",
        )}
      >
        {parts.map((part, index) =>
          part.hit ? (
            <mark key={index} className="rounded-sm bg-attention/40 text-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>{" "}
    </>
  );
}

export interface TranscriptViewProps {
  segments: SegmentView[];
  final: boolean;
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  /** The meeting is being recorded: keep scrolled to the bottom unless the user scrolled up. */
  live: boolean;
  /** Text shown when there are no segments yet. */
  emptyText: string;
  /** Progress line, e.g. "Расшифровка 45 %". */
  statusLine: string | null;
  labels: ReadonlyMap<string, string>;
  colors: ReadonlyMap<string, string>;
  activeSegmentId: number | null;
  onSeek: ((seconds: number) => void) | null;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Deep-linked segment to scroll to and highlight. */
  focusSegmentId: number | null;
}

export function TranscriptView(props: TranscriptViewProps) {
  const { segments, final, loaded, error, live, labels, colors, activeSegmentId, onSeek, follow, focusSegmentId } =
    props;
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const pattern = useMemo(() => searchPattern(deferredQuery), [deferredQuery]);
  const matches = useMemo(() => findMatches(segments, pattern), [segments, pattern]);
  const [matchIndex, setMatchIndex] = useState(0);
  const turnsCache = useRef<{ segments: SegmentView[]; turns: Turn[] } | null>(null);
  const turns = useMemo(() => {
    const next = extendTurns(turnsCache.current, segments);
    turnsCache.current = { segments, turns: next };
    return next;
  }, [segments]);

  const scrollToSegment = useCallback((id: number) => {
    const box = boxRef.current;
    const element = box?.querySelector<HTMLElement>(`[data-seg="${id}"]`);
    if (box == null || element == null) return;
    stickToBottom.current = false;
    // The turn may still be a placeholder (content-visibility); land on it first, then refine.
    const turn = element.closest<HTMLElement>("[data-turn]");
    scrollWithin(box, turn ?? element);
    requestAnimationFrame(() => scrollWithin(box, element));
  }, []);

  // Keep following the bottom while live, unless the user scrolled up or playback is followed.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null || !live || !stickToBottom.current) return;
    if (follow && activeSegmentId !== null) return;
    box.scrollTop = box.scrollHeight;
  }, [segments, live, follow, activeSegmentId]);

  useEffect(() => {
    if (follow && activeSegmentId !== null) scrollToSegment(activeSegmentId);
  }, [follow, activeSegmentId, scrollToSegment]);

  // Deep link: scroll to the segment once it has loaded.
  const focusedOnce = useRef<number | null>(null);
  useEffect(() => {
    if (focusSegmentId === null || focusedOnce.current === focusSegmentId) return;
    if (!segments.some((segment) => segment.id === focusSegmentId)) return;
    focusedOnce.current = focusSegmentId;
    boxRef.current?.scrollIntoView?.({ block: "nearest" });
    scrollToSegment(focusSegmentId);
  }, [focusSegmentId, segments, scrollToSegment]);

  // A new query jumps to its first match (later segment updates keep the position).
  const latestMatches = useLatest(matches);
  useEffect(() => {
    setMatchIndex(0);
    const first = latestMatches.current[0];
    if (first !== undefined) scrollToSegment(first);
  }, [pattern, latestMatches, scrollToSegment]);

  const currentMatch = matches.length === 0 ? null : (matches[Math.min(matchIndex, matches.length - 1)] ?? null);
  const step = (delta: number) => {
    if (matches.length === 0) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    const id = matches[next];
    if (id !== undefined) scrollToSegment(id);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setQuery("");
    }
  };

  const [highlights] = useState(() => new HighlightStore());
  useLayoutEffect(() => {
    highlights.set({ active: activeSegmentId, focus: focusSegmentId, match: currentMatch });
  });
  // The block list only changes with the turns, labels, colors, matches or seek handler.
  // Turns without a match get no pattern, so a new query re-renders only the turns it hits.
  const turnBlocks = useMemo(() => {
    const matched = new Set(matches);
    return turns.map((turn) => (
      <TurnBlock
        key={turn.key}
        turn={turn}
        label={labels.get(turn.speakerKey) ?? turn.segments[0]?.speaker ?? ""}
        color={colorFor(colors, turn.speakerKey)}
        highlights={highlights}
        pattern={matched.size > 0 && turn.segments.some((segment) => matched.has(segment.id)) ? pattern : null}
        onSeek={onSeek}
      />
    ));
  }, [turns, labels, colors, highlights, pattern, matches, onSeek]);
  return (
    <Section title="Расшифровка" count={segments.length === 0 ? undefined : segments.length}>
      {props.statusLine === null ? null : (
        <p role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          {final ? null : <Spinner className="size-3.5" />}
          {props.statusLine}
        </p>
      )}
      {!final && segments.length > 0 ? (
        <Notice tone="info" className="mb-2">
          Предварительная расшифровка — спикеры уточнятся после окончания встречи
        </Notice>
      ) : null}
      {segments.length === 0 ? (
        !loaded ? (
          <EmptyState>
            <span className="inline-flex items-center gap-2">
              <Spinner /> Загружаем расшифровку…
            </span>
          </EmptyState>
        ) : error === null ? (
          <EmptyState>{props.emptyText}</EmptyState>
        ) : null
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-56">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <label htmlFor={searchId} className="sr-only">
                Поиск в расшифровке
              </label>
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKey}
                placeholder="Найти в расшифровке"
                className="h-8 pl-8"
              />
            </div>
            {pattern === null ? null : (
              <div className="flex items-center gap-1">
                <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {matches.length === 0
                    ? "Нет совпадений"
                    : `${Math.min(matchIndex, matches.length - 1) + 1} из ${matches.length}`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Предыдущее совпадение"
                  disabled={matches.length === 0}
                  onClick={() => step(-1)}
                >
                  <Icon name="ChevronUp" className="size-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Следующее совпадение"
                  disabled={matches.length === 0}
                  onClick={() => step(1)}
                >
                  <Icon name="ChevronDown" className="size-4" aria-hidden />
                </Button>
              </div>
            )}
            {onSeek === null ? null : (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={follow} onCheckedChange={(checked) => props.onFollowChange(checked === true)} />
                следовать за воспроизведением
              </label>
            )}
          </div>
          <div
            ref={boxRef}
            onScroll={(event) => {
              const box = event.currentTarget;
              stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
            }}
            className="max-h-[min(70vh,48rem)] overflow-y-auto rounded-lg border border-border bg-card px-3 py-2"
            role="region"
            aria-label="Текст расшифровки"
            tabIndex={0}
          >
            {turnBlocks}
          </div>
        </>
      )}
      {error === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ErrorText>Не удалось загрузить расшифровку: {error}</ErrorText>
          <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
            Повторить
          </Button>
        </div>
      )}
    </Section>
  );
}
