// Compact audio player for a meeting recording: play/pause, seek bar, time,
// speed; exposes seek() to the transcript and reports the playing segment.
import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import type { SegmentView } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { audioUrl } from "./constants";
import { formatClock } from "./format";
import { useLatest } from "./hooks";
import { findSegmentAt } from "./transcript-model";

export interface PlayerHandle {
  /** Jump to `seconds` and play. */
  seek(seconds: number): void;
}

const RATES = [1, 1.25, 1.5, 2] as const;

/** play() rejects on aborted loads or autoplay refusals; the player then simply stays paused. */
function startPlayback(audio: HTMLAudioElement): void {
  try {
    const started: Promise<void> | undefined = audio.play();
    started?.catch(() => undefined);
  } catch {
    // Not supported in this environment.
  }
}
const rateLabel = (rate: number): string => `${String(rate).replace(".", ",")}×`;

/** The server may report this much more audio than the browser loaded before a reload is worth it. */
const MORE_AUDIO_SEC = 1;

export function AudioPlayer({
  meetingId,
  fallbackDurationSec,
  growing = false,
  segments,
  onActiveSegment,
  handleRef,
  className,
}: {
  meetingId: string;
  /** The server's duration: used while the browser does not know it, or knows less (a growing recording). */
  fallbackDurationSec: number;
  /** The recording is still being written: the file may be longer than what the browser loaded. */
  growing?: boolean;
  segments: readonly SegmentView[];
  onActiveSegment: (segmentId: number | null) => void;
  handleRef: Ref<PlayerHandle>;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [rateIndex, setRateIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  // The browser fixes the length of the file when it loads it, so a recording that was still growing is
  // reloaded under a new URL (version) when the user wants a later moment; playback resumes from `resume`.
  const [version, setVersion] = useState(0);
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  /** Loaded length when playback last continued past the end automatically (stops reload loops). */
  const continuedFrom = useRef<number | null>(null);
  const lastActive = useRef<number | null>(null);
  const onActive = useLatest(onActiveSegment);
  const seekId = useId();
  const rate = RATES[rateIndex] ?? 1;

  /** The file on disk may be longer than the loaded one (and `target` lies past the loaded end). */
  const beyondLoaded = (audio: HTMLAudioElement, target: number): boolean => {
    const loaded = audio.duration;
    return (
      Number.isFinite(loaded) &&
      target > loaded - 0.5 &&
      (growing || fallbackDurationSec > loaded + MORE_AUDIO_SEC)
    );
  };
  const reload = (target: number, play: boolean) => {
    resume.current = { time: target, play };
    setTime(target);
    setPlaying(play);
    setVersion((value) => value + 1);
  };
  /** Move the playhead (reloading a grown recording when needed) and optionally play. */
  const goTo = (audio: HTMLAudioElement, target: number, play: boolean) => {
    setStarted(true);
    if (resume.current !== null) {
      // A reload is under way: it resumes at the new target instead.
      resume.current = { time: target, play };
      setTime(target);
      setPlaying(play);
    } else if (beyondLoaded(audio, target)) {
      reload(target, play);
    } else {
      audio.currentTime = target;
      setTime(target);
      if (play) startPlayback(audio);
    }
  };

  const seekRef = useLatest((seconds: number) => {
    const audio = audioRef.current;
    if (audio !== null) goTo(audio, Math.max(0, seconds), true);
  });
  useImperativeHandle(handleRef, () => ({ seek: (seconds: number) => seekRef.current(seconds) }), [seekRef]);

  useEffect(() => {
    if (audioRef.current !== null) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Report the segment under the playhead once playback has been used.
  useEffect(() => {
    if (!started) return;
    const id = findSegmentAt(segments, time);
    if (id !== lastActive.current) {
      lastActive.current = id;
      onActive.current(id);
    }
  }, [started, segments, time, onActive]);

  const knownDuration =
    fallbackDurationSec > (duration ?? 0) + MORE_AUDIO_SEC
      ? fallbackDurationSec
      : (duration ?? (fallbackDurationSec > 0 ? fallbackDurationSec : null));
  const toggle = () => {
    const audio = audioRef.current;
    if (audio === null) return;
    const pending = resume.current;
    if (pending !== null) {
      // A reload is under way: change what happens once it has loaded.
      resume.current = { ...pending, play: !pending.play };
      setPlaying(!pending.play);
      return;
    }
    if (audio.paused) {
      setStarted(true);
      // play() after the end starts over; a grown recording continues instead.
      if (audio.ended && beyondLoaded(audio, audio.currentTime)) reload(audio.currentTime, true);
      else startPlayback(audio);
    } else {
      audio.pause();
    }
  };
  const updateDuration = () => {
    const value = audioRef.current?.duration;
    setDuration(value !== undefined && Number.isFinite(value) && value > 0 ? value : null);
  };

  return (
    <div
      className={cn("flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5", className)}
      role="group"
      aria-label="Запись встречи"
    >
      <audio
        ref={audioRef}
        src={audioUrl(meetingId, version)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          if (resume.current === null) setPlaying(false);
        }}
        onEnded={(event) => {
          const audio = event.currentTarget;
          const loaded = audio.duration;
          // The end of what was loaded, but the server has more: load the rest and go on (once per length).
          if (
            Number.isFinite(loaded) &&
            fallbackDurationSec > loaded + MORE_AUDIO_SEC &&
            (continuedFrom.current === null || loaded > continuedFrom.current + 0.5)
          ) {
            continuedFrom.current = loaded;
            reload(loaded, true);
            return;
          }
          setPlaying(false);
        }}
        onTimeUpdate={(event) => {
          // A reload rewinds the element to 0 before it resumes; keep showing the target meanwhile.
          if (resume.current === null) setTime(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          audio.playbackRate = rate;
          updateDuration();
          const pending = resume.current;
          if (pending === null) return;
          resume.current = null;
          const target = Number.isFinite(audio.duration) ? Math.min(pending.time, audio.duration) : pending.time;
          audio.currentTime = target;
          setTime(target);
          if (pending.play) startPlayback(audio);
          else setPlaying(false);
        }}
        onDurationChange={updateDuration}
        onError={() => {
          resume.current = null;
          setPlaying(false);
          setFailed(true);
        }}
        onCanPlay={() => setFailed(false)}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        aria-label={playing ? "Пауза" : "Воспроизвести"}
        onClick={toggle}
        disabled={failed}
      >
        <Icon name={playing ? "Pause" : "Play"} className="size-4" aria-hidden />
      </Button>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatClock(time)}</span>
      <label htmlFor={seekId} className="sr-only">
        Позиция воспроизведения
      </label>
      <input
        id={seekId}
        type="range"
        min={0}
        max={knownDuration ?? 0}
        step={1}
        value={Math.min(time, knownDuration ?? time)}
        disabled={failed || knownDuration === null}
        aria-valuetext={`${formatClock(time)} из ${knownDuration === null ? "?" : formatClock(knownDuration)}`}
        onChange={(event) => {
          const audio = audioRef.current;
          const value = Number(event.target.value);
          if (audio === null || !Number.isFinite(value)) return;
          goTo(audio, value, resume.current?.play ?? !audio.paused);
        }}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-foreground disabled:cursor-default"
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {knownDuration === null ? "--:--" : formatClock(knownDuration)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-14 shrink-0 px-1 font-mono text-xs tabular-nums"
        aria-label={`Скорость воспроизведения ${rateLabel(rate)}, нажмите, чтобы изменить`}
        onClick={() => setRateIndex((index) => (index + 1) % RATES.length)}
      >
        {rateLabel(rate)}
      </Button>
      {failed ? (
        <span role="alert" className="shrink-0 text-xs text-destructive-text">
          Аудио недоступно
        </span>
      ) : null}
    </div>
  );
}
