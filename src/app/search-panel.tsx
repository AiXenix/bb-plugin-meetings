// Global transcript search (meetings.search) with highlighted FTS snippets.
import { useEffect, useId, useRef, useState } from "react";
import type { SearchHit } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatTimestamp } from "./format";
import { useDebouncedCallback, useMountedRef } from "./hooks";
import { messageOf, useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { parseSnippet } from "./transcript-model";
import { ErrorText, Spinner } from "./ui";

const SEARCH_LIMIT = 30;

/** Renders an FTS snippet: the matched parts become <mark>, everything else stays text. */
export function Snippet({ snippet }: { snippet: string }) {
  return (
    <>
      {parseSnippet(snippet).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-sm bg-attention/40 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

interface SearchState {
  query: string;
  hits: SearchHit[] | null;
  error: string | null;
  loading: boolean;
}

export function SearchPanel({ nav }: { nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const inputId = useId();
  const resultsId = useId();
  const [input, setInput] = useState("");
  const [state, setState] = useState<SearchState>({ query: "", hits: null, error: null, loading: false });
  const sequence = useRef(0);

  const search = useDebouncedCallback((raw: string) => {
    const query = raw.trim();
    const seq = ++sequence.current;
    if (query === "") {
      setState({ query: "", hits: null, error: null, loading: false });
      return;
    }
    setState((prev) => ({ ...prev, query, loading: true, error: null }));
    rpc.call("meetings.search", { query, limit: SEARCH_LIMIT }).then(
      (result) => {
        if (mounted.current && seq === sequence.current) {
          setState({ query, hits: result.hits, error: null, loading: false });
        }
      },
      (cause: unknown) => {
        if (mounted.current && seq === sequence.current) {
          setState({ query, hits: null, error: messageOf(cause), loading: false });
        }
      },
    );
  }, 300);

  useEffect(() => {
    search(input);
  }, [input, search]);

  const active = input.trim() !== "";
  return (
    <section aria-label="Поиск по расшифровкам" className="mt-6">
      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <label htmlFor={inputId} className="sr-only">
          Поиск по расшифровкам
        </label>
        <Input
          id={inputId}
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && input !== "") {
              event.preventDefault();
              setInput("");
            }
          }}
          placeholder="Поиск по всем расшифровкам"
          className="pl-8 pr-9 [&::-webkit-search-cancel-button]:hidden"
          aria-controls={active ? resultsId : undefined}
          maxLength={200}
        />
        {state.loading ? (
          <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        ) : active ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
            aria-label="Очистить поиск"
            onClick={() => setInput("")}
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {active ? (
        <div id={resultsId} className="mt-2" aria-live="polite">
          <ErrorText>{state.error === null ? null : `Поиск не удался: ${state.error}`}</ErrorText>
          {state.hits === null ? null : state.hits.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">Ничего не найдено по запросу «{state.query}».</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {state.hits.map((hit) => (
                <li key={`${hit.meetingId}:${hit.segmentId}`}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2.5 text-left hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                    onClick={() => nav.toMeeting(hit.meetingId, hit.segmentId)}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{hit.meetingTitle}</span>
                      <span>{formatDateTime(hit.meetingDate)}</span>
                    </span>
                    <span className="mt-1 block text-sm">
                      <span className="mr-1.5 font-medium">{hit.speaker}</span>
                      <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                        [{formatTimestamp(hit.start)}]
                      </span>
                      <Snippet snippet={hit.snippet} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.hits !== null && state.hits.length === SEARCH_LIMIT ? (
            <p className="mt-1 px-1 text-xs text-muted-foreground">
              Показаны первые {SEARCH_LIMIT} совпадений — уточните запрос.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
