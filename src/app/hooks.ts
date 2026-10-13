// Small React hooks shared by the Meetings page: debouncing, timers,
// visibility, reconnect handling and async actions with pending/error state.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { messageOf } from "./rpc";

/** A ref that always holds the latest value (for callbacks fired from timers). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function useMountedRef(): { readonly current: boolean } {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

/** A stable function that runs `fn` once calls stop for `ms`. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  const latest = useLatest(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (...args: A) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current(...args);
      }, ms);
    },
    [latest, ms],
  );
}

/** setInterval with the latest callback; `ms = null` pauses it. */
export function useInterval(fn: () => void, ms: number | null): void {
  const latest = useLatest(fn);
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [latest, ms]);
}

/** Current time, re-rendering every `intervalMs` (null = frozen). */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), intervalMs);
  return now;
}

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Whether the element is (at least partly) on screen; true when IntersectionObserver is unavailable. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/** Calls `fn` when the realtime connection comes back after a drop (signals may have been missed). */
export function useOnReconnect(fn: () => void): void {
  const state = useRealtimeConnectionState();
  const latest = useLatest(fn);
  const previous = useRef(state);
  useEffect(() => {
    if (state === "connected" && previous.current !== "connected") latest.current();
    previous.current = state;
  }, [state, latest]);
}

export interface AsyncAction<A extends unknown[], R> {
  /** Resolves with the result, or undefined when it failed (the message is in `error`). */
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

/** Wraps an async operation with pending and error state for buttons and forms. */
export function useAsyncAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): AsyncAction<A, R> {
  const latest = useLatest(fn);
  const mounted = useMountedRef();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await latest.current(...args);
      } catch (cause) {
        if (mounted.current) setError(messageOf(cause));
        return undefined;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [latest, mounted],
  );
  return { run, pending, error, setError };
}
