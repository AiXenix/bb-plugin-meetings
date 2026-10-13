// Loads a meeting's transcript segments: everything once (paged by afterId),
// then only new ones on "meetings.segments" signals and a slow poll while the
// meeting is active. A flip of `final` (or of the transcript status) means the
// transcriber relabelled or rebuilt everything, so the whole list is reloaded.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { SegmentView, TranscriptStatus } from "../shared/rpc-contract";
import { CHANNEL_MEETING_SEGMENTS } from "./constants";
import { useDebouncedCallback, useInterval, useMountedRef, useOnReconnect } from "./hooks";
import { messageOf, useMeetingsRpc } from "./rpc";
import { appendSegments } from "./transcript-model";

const PAGE = 2000;
const MAX_PAGES = 200;

export interface SegmentsState {
  segments: SegmentView[];
  final: boolean;
  total: number;
  loaded: boolean;
  error: string | null;
}

const INITIAL: SegmentsState = { segments: [], final: false, total: 0, loaded: false, error: null };

type LoadKind = "tail" | "full";

export function useSegments(id: string, transcriptStatus: TranscriptStatus | null, active: boolean) {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [state, setState] = useState<SegmentsState>(INITIAL);
  // The loader reads the latest data synchronously, independent of renders.
  const data = useRef<{ segments: SegmentView[]; final: boolean }>({ segments: [], final: false });
  const running = useRef(false);
  const queued = useRef<LoadKind | null>(null);

  const commit = useCallback(
    (segments: SegmentView[], final: boolean, total: number) => {
      data.current = { segments, final };
      if (mounted.current) setState({ segments, final, total, loaded: true, error: null });
    },
    [mounted],
  );

  const fetchFrom = useCallback(
    async (afterId: number) => {
      const segments: SegmentView[] = [];
      let cursor = afterId;
      let final = false;
      let total = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await rpc.call("meetings.segments", { id, afterId: cursor, limit: PAGE });
        segments.push(...result.segments);
        final = result.final;
        total = result.total;
        if (result.segments.length < PAGE || result.lastId <= cursor) break;
        cursor = result.lastId;
      }
      return { segments, final, total };
    },
    [rpc, id],
  );

  const load = useCallback(
    async (kind: LoadKind) => {
      if (running.current) {
        if (queued.current !== "full") queued.current = kind;
        return;
      }
      running.current = true;
      try {
        let next: LoadKind | null = kind;
        while (next !== null && mounted.current) {
          if (next === "full") {
            const result = await fetchFrom(-1);
            commit(result.segments, result.final, result.total);
          } else {
            const { segments, final } = data.current;
            const lastId = segments.length > 0 ? segments[segments.length - 1]!.id : -1;
            const result = await fetchFrom(lastId);
            if (result.final !== final) {
              queued.current = "full";
            } else {
              commit(appendSegments(segments, result.segments), result.final, result.total);
            }
          }
          next = queued.current;
          queued.current = null;
        }
      } catch (cause) {
        if (mounted.current) setState((prev) => ({ ...prev, loaded: true, error: messageOf(cause) }));
      } finally {
        running.current = false;
      }
    },
    [fetchFrom, commit, mounted],
  );

  const reload = useCallback(() => void load("full"), [load]);
  const loadNew = useCallback(() => void load("tail"), [load]);

  useEffect(() => {
    data.current = { segments: [], final: false };
    setState(INITIAL);
    void load("full");
  }, [load]);

  // The transcriber moved on (live → finalizing → done, or a re-transcription): reload everything.
  const lastStatus = useRef(transcriptStatus);
  useEffect(() => {
    if (lastStatus.current === transcriptStatus) return;
    const previous = lastStatus.current;
    lastStatus.current = transcriptStatus;
    if (previous !== null && transcriptStatus !== null) reload();
  }, [transcriptStatus, reload]);

  const debouncedNew = useDebouncedCallback(loadNew, 300);
  useRealtime(CHANNEL_MEETING_SEGMENTS, (payload: unknown) => {
    const target = typeof payload === "object" && payload !== null ? (payload as { id?: unknown }).id : undefined;
    if (target === undefined || target === id) debouncedNew();
  });
  useOnReconnect(loadNew);
  useInterval(loadNew, active ? 10_000 : null);

  return { ...state, reload };
}
