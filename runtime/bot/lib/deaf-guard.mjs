// Deaf-bot guard (docs/dev/DESIGN.md §6.8). The bot records digital silence
// although the meeting is talking, in one of two ways:
//   deaf     the meeting shows people speaking, but the platform delivers no
//            audio: the recording and every WebRTC track are exactly zero (seen
//            live on Zoom, 2026-10-27: computer audio "connected", the speaking
//            indicators busy for 30 minutes);
//   capture  the participants' WebRTC tracks carry sound, but none of it
//            reaches the recording (the page plays to an output that is not
//            recorded, or not at all). It needs no speaking indicators, so it
//            also works where the platform's indicators are unreadable.
// The guard notices either within one window, asks the runner for an
// escalating recovery (rejoin the meeting audio twice, then reload the meeting
// page), then raises a warning for the user and keeps retrying the audio
// rejoin, and clears everything once sound comes back.
//
// Pure and clock-injected: no imports, no timers, no I/O. The caller passes
// the time with every observation and executes the returned actions itself,
// so this file can be copied verbatim into other products sharing the runtime.
//
//   const guard = new DeafGuard(overrides);
//   const action = guard.observe({ t, speakers, botName, pcmPeak, trackLevels, participants });
//   if (action?.type === "rejoin_audio" || action?.type === "reload") {
//     const result = await runIt(action);           // never interrupts the recording
//     guard.done(Date.now(), result);               // { ok, detail }
//     silence.activity(Date.now());                 // a step (a waiting room) is no silent meeting
//   }
//   state.audioIssue = guard.issue;                 // null | { since, attempts, lastAction, message, escalated, reason }
//   if (guard.speakingWhileDeaf(t)) silence.activity(t); // a deaf bot is not in a silent meeting
//
// A wall clock that steps back by more than a second drops the collected
// evidence (a fresh window is needed) and clamps the open episode's start to
// the new time; a step forward only opens a gap in the measurements, which
// never counts as silence.
//
// Inputs of observe():
//   t            epoch ms of the observation (monotonic in practice)
//   speakers     display names the meeting UI marks as speaking right now
//                (indicators, not audio: store/tile signals); the bot is removed.
//                null = the UI could not be read this tick (failed sample): the
//                previous indicators are kept, so a dropped sample is neither a
//                pause nor a new speaker
//   botName      the bot's own display name (never counts as a speaker)
//   pcmPeak      peak |sample| of the newest recorded audio as 0..1 (32767 ≙ 1),
//                null/undefined when nothing was measured in this tick
//   trackLevels  per-participant WebRTC track levels (numbers or {level}/{lvl}),
//                any level above trackSoundLevel is sound
//   participants participant count including the bot, or null when unknown
//
// Deaf means, over the sliding window: the recording stayed below silentPeak
// (-80 dBFS) with continuous measurements, no track carried sound, the bot is
// not alone, and someone other than the bot was marked speaking for at least
// minSpeakingMs with at least minChanges speaker changes (a speaker who was
// not lit in the last observation that showed anyone: an indicator that goes
// dark for a moment and lights the same person again is no change). A silent
// meeting, a sticky indicator (screen share, even one that flickers) and a
// lone bot therefore never count. The ladder steps before the warning need the
// same evidence, so a sticky indicator can never drive a reload.
//
// Once an episode is open the bot is known to be deaf, and one person talking
// with a steady indicator looks exactly like a sticky one: the silence hold
// (speakingWhileDeaf) and, after the warning, the persistent audio rejoins need
// only someone other than the bot lit for minSpeakingMs within the window
// (openMinChanges speaker changes, 0 by default).
//
// Capture means, over the same window: the recording stayed below silentPeak
// with continuous measurements, the bot is not alone, and the participants'
// tracks were at or above captureTrackLevel (-40 dBFS RMS, clearly above the
// tracks' noise) for at least captureSoundMs. Played to the recorded output,
// such a track could never leave the recording 40 dB quieter. Recovery from a
// capture episode is judged on the recording only: the tracks had sound all
// along.
//
// Actions returned by observe() (at most one per call):
//   { type: "rejoin_audio" | "reload", step, attempt, reason, evidence }  run it, then call done()
//   { type: "warn", attempts, evidence, relapse? }  the ladder is exhausted (or an escalated episode is
//                                             back): surface issue (escalated) and notify once
//   { type: "recovered", deafMs, attempts, tried, evidence }  sound is back: clear the warning
//   { type: "note", reason, evidence }        log-only decision (silent recording that is not deafness,
//                                             or capture with capture: "log"), once per reason and silent stretch
// Every action carries `msg` (English, for the event log); evidence.reason is "deaf" or "capture"
// for the acting ones.

export const DEAF_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  /** Sliding window over which the bot must be deaf before anything happens. */
  windowMs: 45_000,
  /** Peak (0..1) below which the recording is digital silence: 10^(-80/20) = -80 dBFS. */
  silentPeak: 1e-4,
  /** A WebRTC track level above this is sound (the track hook reports exact 0 for silence). */
  trackSoundLevel: 0,
  /** Someone other than the bot marked speaking at least this long within the window... */
  minSpeakingMs: 10_000,
  /** ...with at least this many speaker changes (onsets of a speaker not in the last non-empty indicator set). */
  minChanges: 2,
  /**
   * Speaker changes needed once an episode is open, by the silence hold (speakingWhileDeaf) and, after
   * the warning, by the persistent audio rejoins: one person talking with a steady indicator is still a
   * talking meeting. Detection and the ladder steps before the warning keep minChanges.
   */
  openMinChanges: 0,
  /**
   * Capture mode (sound on the tracks, silence in the recording): "act" runs the same ladder as
   * deafness, "log" only notes it in the event log, "off" ignores it.
   */
  capture: "act",
  /**
   * A track level (RMS 0..1 of the loudest participant track) at least this high is the participants'
   * sound for capture mode: -40 dBFS, several times the tracks' noise (Telemost's comfort noise
   * reads 0.002–0.003) and below speech (the speaker fusion's loudRms is 0.012)...
   */
  captureTrackLevel: 0.01,
  /** ...for at least this long within the window. */
  captureSoundMs: 10_000,
  /** One observation counts as speaking (or sounding) time for at most this long (gaps in sampling). */
  maxStepMs: 2_000,
  /** Recorded-audio measurements further apart than this restart the silent stretch (unknown in between). */
  maxPcmGapMs: 15_000,
  /** Tolerance for the silent stretch starting a little after the window start (measurement cadence). */
  pcmSlackMs: 3_000,
  /** After a ladder action finished: wait this long (and be deaf again) before the next one. */
  retryMs: 40_000,
  /** After the warning: retry the audio rejoin this often while still deaf. */
  persistentRetryMs: 180_000,
  /**
   * Recovery needs sustained sound within recoveryWindowMs: at least recoveryReads loud
   * measurements of the recording, or recoveryTrackObs observations with a sounding
   * WebRTC track (participants' audio, never local sounds; deaf episodes only), either
   * spanning recoverySpanMs. A click, Zoom's 1.3 s local "Recording in progress" or a
   * sub-second burst on a track does not count.
   */
  recoverySpanMs: 4_000,
  recoveryReads: 4,
  recoveryTrackObs: 3,
  recoveryWindowMs: 20_000,
  /**
   * Deaf again this soon after a recovery: the same episode, the ladder continues where it
   * stopped. An escalated episode goes straight back to the warning; its next audio rejoin
   * still waits persistentRetryMs, counted from the recovery.
   */
  relapseMs: 300_000,
  /** The escalating recovery, in order; then "warn", then persistentAction every persistentRetryMs. */
  ladder: Object.freeze(["rejoin_audio", "rejoin_audio", "reload"]),
  persistentAction: "rejoin_audio",
});

export const DEAF_ACTION_TYPES = Object.freeze(["rejoin_audio", "reload"]);
/** Values of the `capture` option. */
export const CAPTURE_MODES = Object.freeze(["act", "log", "off"]);
/** Values of audioIssue.reason (consumers must accept others and a missing one: "deaf"). */
export const AUDIO_ISSUE_REASONS = Object.freeze(["deaf", "capture"]);

const NUMERIC_OPTIONS = [
  "windowMs",
  "silentPeak",
  "trackSoundLevel",
  "minSpeakingMs",
  "minChanges",
  "openMinChanges",
  "captureTrackLevel",
  "captureSoundMs",
  "maxStepMs",
  "maxPcmGapMs",
  "pcmSlackMs",
  "retryMs",
  "persistentRetryMs",
  "recoverySpanMs",
  "recoveryReads",
  "recoveryTrackObs",
  "recoveryWindowMs",
  "relapseMs",
];

/** Defaults merged with a loose override object (unknown keys and bad values are ignored). */
export function resolveDeafGuardOptions(override) {
  const out = { ...DEAF_GUARD_DEFAULTS, ladder: [...DEAF_GUARD_DEFAULTS.ladder] };
  if (!override || typeof override !== "object") return out;
  if (typeof override.enabled === "boolean") out.enabled = override.enabled;
  for (const key of NUMERIC_OPTIONS) {
    const value = override[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (CAPTURE_MODES.includes(override.capture)) out.capture = override.capture;
  if (Array.isArray(override.ladder)) {
    const ladder = override.ladder.filter((step) => DEAF_ACTION_TYPES.includes(step));
    if (ladder.length > 0) out.ladder = ladder;
  }
  if (DEAF_ACTION_TYPES.includes(override.persistentAction)) out.persistentAction = override.persistentAction;
  return out;
}

/** dBFS of a 0..1 peak, rounded to 0.1 dB; null for digital zero. */
export function peakDbfs(peak) {
  if (typeof peak !== "number" || !Number.isFinite(peak) || peak <= 0) return null;
  return Math.round(200 * Math.log10(peak)) / 10;
}

const ROLE_SUFFIX = /\s*\((?:\s*(?:host|co-host|cohost|me|guest|you|организатор|соорганизатор|я|вы|гость)\s*,?)+\)\s*$/i;

/** Display name without "(Host)", "(me)"… suffixes, whitespace collapsed. */
function cleanName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(ROLE_SUFFIX, "").trim();
    if (next === name) break;
    name = next;
  }
  return name;
}

function levelOf(entry) {
  const value = typeof entry === "number" ? entry : entry && typeof entry === "object" ? (entry.level ?? entry.lvl) : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const ACTION_TEXT = Object.freeze({
  rejoin_audio: { done: "переподключить звук встречи", now: "переподключаю звук встречи", en: "rejoining the meeting audio" },
  reload: { done: "перезагрузить страницу встречи", now: "перезагружаю страницу встречи и вхожу заново", en: "reloading the meeting page and joining again" },
});

/** User-facing texts per audioIssue.reason. The first sentence is the warning's title. */
const TEXT = Object.freeze({
  deaf: {
    headline: "Бот не слышит участников встречи: участники говорят, а в записи тишина.",
    atEnd: "Бот не слышал участников встречи до конца записи: участники говорили, а в записи была тишина.",
    noSound: "звук не появился",
    en: "participants speak, but the recording is digital silence",
  },
  capture: {
    headline: "Бот слышит участников, но звук не попадает в запись.",
    atEnd: "Бот слышал участников, но до конца записи звук в неё так и не попал.",
    noSound: "звук в записи не появился",
    en: "the participants' audio tracks carry sound, but the recording is digital silence (capture)",
  },
});

const round1 = (ms) => Math.round(ms / 100) / 10;

export class DeafGuard {
  constructor(options = {}) {
    this.options = resolveDeafGuardOptions(options);
    /** "hearing" | "deaf" (ladder running) | "escalated" (warning raised, persistent retries). */
    this.phase = "hearing";
    /** "deaf" | "capture": what the latest evidence of the open episode showed (null while hearing). */
    this.reason = null;
    /** The open episode had capture evidence: sound on the tracks is no recovery for it. */
    this.captureSeen = false;
    /** Recent observations {t, names: string[], peak: number|null, trackMax, pcmLoud, trackLoud, loud}. */
    this.obs = [];
    /** Observations before this time do not count (start, last action, last recovery). */
    this.evidenceFrom = null;
    /** Start of the current run of recorded-audio measurements without a gap longer than maxPcmGapMs. */
    this.coverFrom = null;
    this.lastPcmAt = null;
    /** Last observation with sound (recording above silentPeak or a track above trackSoundLevel). */
    this.lastLoudAt = null;
    /** Last recorded-audio measurement above silentPeak. */
    this.lastPcmLoudAt = null;
    /** Latest known participant count (includes the bot). */
    this.participants = null;
    /** The action being executed ({type, t}) between observe() and done(). */
    this.busy = null;
    /** Ladder actions issued in this episode. */
    this.step = 0;
    this.attempts = 0;
    /** This episode's actions: {type, t, ok, detail}. */
    this.history = [];
    this.since = null;
    this.escalatedAt = null;
    /** The last recovered episode {recoveredAt, step, attempts, history, escalated, captureSeen}, for relapses. */
    this.lastEpisode = null;
    /** How long the sound lasted before the current relapse (for the log). */
    this.relapseAfterMs = null;
    /** "<silent stretch start>:<reason>" already logged as a note. */
    this.notedStretches = new Set();
    /** name key → display name, for the evidence. */
    this.labels = new Map();
    /** Time of the last observation, to notice the wall clock stepping back. */
    this.lastT = null;
  }

  get enabled() {
    return this.options.enabled;
  }

  /** Start of the current stretch without any sound (recording or tracks), continuously measured; null = none. */
  get quietFrom() {
    if (this.coverFrom === null) return null;
    if (this.lastLoudAt !== null && this.lastLoudAt >= this.lastPcmAt) return null;
    return Math.max(this.coverFrom, this.lastLoudAt ?? -Infinity);
  }

  /** Start of the recording's current silent, continuously measured stretch (tracks ignored); null = none. */
  get recordingQuietFrom() {
    if (this.coverFrom === null) return null;
    if (this.lastPcmLoudAt !== null && this.lastPcmLoudAt >= this.lastPcmAt) return null;
    return Math.max(this.coverFrom, this.lastPcmLoudAt ?? -Infinity);
  }

  /** Compact internal state for debug dumps. */
  debugState() {
    return {
      phase: this.phase,
      reason: this.reason,
      captureSeen: this.captureSeen,
      since: this.since,
      attempts: this.attempts,
      busy: this.busy?.type ?? null,
      quietFrom: this.quietFrom,
      recordingQuietFrom: this.recordingQuietFrom,
      lastPcmAt: this.lastPcmAt,
      evidenceFrom: this.evidenceFrom,
      participants: this.participants,
      capture: this.options.capture,
      history: this.history.map((entry) => ({ ...entry })),
    };
  }

  /** null while the bot hears the meeting, else the state.json `audioIssue` object. */
  get issue() {
    if (this.phase === "hearing") return null;
    const last = this.history.at(-1) ?? null;
    return {
      since: this.since,
      attempts: this.attempts,
      lastAction: last ? last.type : null,
      message: this.message(),
      escalated: this.phase === "escalated",
      reason: this.reason ?? "deaf",
    };
  }

  /** The issue for the final state.json of a meeting that ended while the bot was deaf (past tense); null while hearing. */
  issueAtEnd() {
    const issue = this.issue;
    if (issue === null) return null;
    const text = TEXT[issue.reason] ?? TEXT.deaf;
    const tried = this.triedText();
    return {
      ...issue,
      message: `${text.atEnd}${tried ? ` Автоматически пробовали: ${tried} — ${text.noSound}.` : ""}`,
    };
  }

  /** The Russian user-facing text of the current issue ("" while hearing). */
  message() {
    if (this.phase === "hearing") return "";
    const text = TEXT[this.reason] ?? TEXT.deaf;
    const tried = this.triedText();
    if (this.phase === "escalated") {
      const every = Math.max(1, Math.round(this.options.persistentRetryMs / 60_000));
      return `${text.headline} Автоматически пробовали: ${tried || "переподключить звук"} — ${text.noSound}. Бот продолжает переподключать звук каждые ${every} мин. Если звук так и не появится, остановите бота и подключите его заново.`;
    }
    if (this.busy !== null) {
      const now = ACTION_TEXT[this.busy.type]?.now ?? this.busy.type;
      return `${text.headline} Пробую восстановить звук: ${now} (попытка ${this.attempts}).`;
    }
    return `${text.headline} Пробовали: ${tried}; жду, появится ли звук.`;
  }

  /** "переподключить звук встречи (2 раза), перезагрузить страницу встречи (1 раз)" */
  triedText() {
    const counts = new Map();
    for (const entry of this.history) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    return [...counts]
      .map(([type, n]) => `${ACTION_TEXT[type]?.done ?? type} (${n} ${plural(n, "раз", "раза", "раз")})`)
      .join(", ");
  }

  /**
   * The wall clock stepped back (NTP step, VM resume): the stored times are unusable, collect fresh
   * evidence. The open episode's start and escalation move to the new time at the latest, so a
   * recovery never logs a negative duration and audioIssue.since never lies in the future.
   */
  #clockWentBack(t) {
    this.obs = [];
    this.coverFrom = null;
    this.lastPcmAt = null;
    this.lastLoudAt = null;
    this.lastPcmLoudAt = null;
    this.evidenceFrom = t;
    if (this.since !== null) this.since = Math.min(this.since, t);
    if (this.escalatedAt !== null) this.escalatedAt = Math.min(this.escalatedAt, t);
    if (this.lastEpisode !== null) this.lastEpisode.recoveredAt = t;
  }

  /**
   * One observation (every sampling tick; pcmPeak only when it was measured).
   * Returns an action or null.
   */
  observe({ t, speakers = [], botName = "", pcmPeak = null, trackLevels = [], participants = null } = {}) {
    if (!this.options.enabled || typeof t !== "number" || !Number.isFinite(t)) return null;
    const o = this.options;
    // Up to a second back is jitter; more would stall every window until the clock caught up.
    if (this.lastT !== null && t < this.lastT - 1_000) this.#clockWentBack(t);
    this.lastT = t;
    this.evidenceFrom ??= t;
    let names;
    if (speakers === null) {
      // Unknown this tick (the sample failed): keep the last indicators, so a dropped sample
      // neither pauses the speech nor lights anyone anew.
      names = this.obs.at(-1)?.names ?? [];
    } else {
      const bot = cleanName(botName).toLocaleLowerCase();
      const keys = new Set();
      for (const raw of Array.isArray(speakers) ? speakers : []) {
        const label = cleanName(raw);
        const key = label.toLocaleLowerCase();
        if (key === "" || key === bot) continue;
        keys.add(key);
        if (this.labels.size < 200 || this.labels.has(key)) this.labels.set(key, label);
      }
      names = [...keys].sort();
    }
    const trackMax = (Array.isArray(trackLevels) ? trackLevels : []).reduce((max, entry) => Math.max(max, levelOf(entry)), 0);
    const peak = typeof pcmPeak === "number" && Number.isFinite(pcmPeak) ? Math.max(0, pcmPeak) : null;
    if (typeof participants === "number" && Number.isFinite(participants)) this.participants = participants;

    const pcmLoud = peak !== null && peak >= o.silentPeak;
    const trackLoud = trackMax > o.trackSoundLevel;
    const loud = pcmLoud || trackLoud;
    if (peak !== null) {
      // A gap in the measurements means unknown audio in between: the silent stretch starts over.
      if (this.lastPcmAt === null || t - this.lastPcmAt > o.maxPcmGapMs) this.coverFrom = t;
      this.lastPcmAt = t;
    }
    if (loud) this.lastLoudAt = t;
    if (pcmLoud) this.lastPcmLoudAt = t;

    this.obs.push({ t, names, peak, trackMax, pcmLoud, trackLoud, loud });
    const keepFrom = t - Math.max(o.windowMs, o.recoveryWindowMs) - 10_000;
    while (this.obs.length > 0 && this.obs[0].t < keepFrom) this.obs.shift();

    if (this.busy !== null) return null;

    if (this.phase !== "hearing") {
      const recovered = this.#recovery(t);
      if (recovered !== null) return recovered;
    }

    const wait = this.phase === "hearing" ? o.windowMs : this.phase === "deaf" ? o.retryMs : o.persistentRetryMs;
    if (t - this.evidenceFrom < wait) return null;
    const from = Math.max(t - o.windowMs, this.evidenceFrom);
    const verdict = this.judge(t, from);
    const acting = verdict.deaf || (verdict.capture && o.capture === "act");

    if (!acting) {
      // One note per reason and silent stretch: a silent meeting that later shows a sticky indicator logs both.
      const stretch = `${verdict.capture ? this.recordingQuietFrom : this.quietFrom}:${verdict.reason}`;
      if (this.phase === "hearing" && verdict.recordingQuiet && verdict.reason !== "sound" && !this.notedStretches.has(stretch)) {
        if (this.notedStretches.size > 50) this.notedStretches.clear();
        this.notedStretches.add(stretch);
        const msg = verdict.capture
          ? `Deaf guard: the recording is silent, but the participants' audio tracks carry sound (capture; capture mode is log-only): no action`
          : `Deaf guard: the recording is silent, but ${verdict.reason}: not deaf`;
        return { type: "note", reason: verdict.reason, evidence: verdict, msg };
      }
      return null;
    }
    const reason = verdict.capture ? "capture" : "deaf";
    if (this.phase === "hearing") {
      this.since = from;
      this.escalatedAt = null;
      const relapse = this.lastEpisode !== null && t - this.lastEpisode.recoveredAt <= o.relapseMs ? this.lastEpisode : null;
      this.lastEpisode = null;
      this.reason = reason;
      if (relapse !== null) {
        // The sound came back only briefly (or was a false recovery): keep climbing instead of starting over.
        this.step = relapse.step;
        this.attempts = relapse.attempts;
        this.history = relapse.history;
        this.captureSeen = relapse.captureSeen || reason === "capture";
        this.relapseAfterMs = t - relapse.recoveredAt;
        if (relapse.escalated) {
          // Warn again at once, but keep the persistent retries' cadence: evidenceFrom stays at the
          // recovery, so the next audio rejoin comes persistentRetryMs after it (a recovery that keeps
          // flapping must not turn the 3-minute retries into one rejoin per window).
          this.phase = "escalated";
          this.escalatedAt = t;
          return {
            type: "warn",
            attempts: this.attempts,
            relapse: true,
            evidence: verdict,
            msg: `Deaf bot: ${this.#goneAgain()}; warning the user again (next audio rejoin at most every ${round1(o.persistentRetryMs)} s)`,
          };
        }
        this.phase = "deaf";
        if (this.step < o.ladder.length) return this.#act(t, o.ladder[this.step], "relapse", verdict);
        return this.#escalate(t, verdict);
      }
      this.phase = "deaf";
      this.step = 0;
      this.attempts = 0;
      this.history = [];
      this.captureSeen = reason === "capture";
      return this.#act(t, o.ladder[0], "detected", verdict);
    }
    this.reason = reason;
    if (reason === "capture") this.captureSeen = true;
    if (this.phase === "deaf") {
      if (this.step < o.ladder.length) return this.#act(t, o.ladder[this.step], "retry", verdict);
      return this.#escalate(t, verdict);
    }
    return this.#act(t, o.persistentAction, "persistent", verdict);
  }

  /** "participants speak, but the meeting audio is gone again 8 s after it came back" (relapse log text). */
  #goneAgain() {
    const after = round1(this.relapseAfterMs ?? 0);
    return this.reason === "capture"
      ? `the participants' audio is missing from the recording again ${after} s after it came back (capture)`
      : `participants speak, but the meeting audio is gone again ${after} s after it came back`;
  }

  #escalate(t, verdict) {
    this.phase = "escalated";
    this.escalatedAt = t;
    this.evidenceFrom = t;
    return {
      type: "warn",
      attempts: this.attempts,
      evidence: verdict,
      msg: `Deaf bot: still no meeting audio${this.reason === "capture" ? " in the recording (capture)" : ""} after ${this.attempts} recovery attempt(s); warning the user`,
    };
  }

  /** The action returned by observe() has finished (result: {ok, detail}). */
  done(t, result = {}) {
    if (this.busy === null) return;
    const entry = this.history.at(-1);
    if (entry) {
      entry.ok = !!result?.ok;
      if (result?.detail !== undefined) entry.detail = String(result.detail).slice(0, 300);
      entry.doneAt = t;
    }
    this.busy = null;
    this.evidenceFrom = t;
  }

  /**
   * True while an episode is open (issue !== null) and the meeting was talking over the
   * last window, the bot not alone: the indicators showed someone other than the bot
   * speaking (minSpeakingMs with openMinChanges changes: one person who keeps talking is
   * enough) or the tracks carried the participants' sound (captureSoundMs at
   * captureTrackLevel). The recording's silence is then the bot's problem, not an empty
   * meeting, so the runner's "no audio for N min" timeout must not end the recording.
   */
  speakingWhileDeaf(t) {
    const o = this.options;
    if (!o.enabled || this.phase === "hearing" || typeof t !== "number" || !Number.isFinite(t)) return false;
    if (this.participants !== null && this.participants <= 1) return false;
    const { speakingMs, changes, trackSoundMs } = this.#indicators(t, t - o.windowMs);
    return (speakingMs >= o.minSpeakingMs && changes >= o.openMinChanges) || trackSoundMs >= o.captureSoundMs;
  }

  /**
   * Speaker changes the deaf evidence needs: minChanges to detect an episode and for the
   * ladder steps before the warning (a sticky indicator never drives a reload), openMinChanges
   * for the persistent audio rejoins after it.
   */
  #changesNeeded() {
    // The open-episode rule only relaxes the harmless audio rejoin: a sticky indicator must
    // never drive a page reload, also when persistentAction is set to "reload".
    const o = this.options;
    return this.phase === "escalated" && o.persistentAction === "rejoin_audio" ? o.openMinChanges : o.minChanges;
  }

  /**
   * Is the bot deaf (or its recording cut off from the sound, "capture") over [from, t]?
   * Pure read of the observations; also the evidence logged with every decision. The
   * speaker changes it needs follow the phase (minChanges; openMinChanges once escalated, for the audio rejoin only).
   */
  judge(t, from) {
    const o = this.options;
    const alone = this.participants !== null && this.participants <= 1;
    // Measured without a gap since (about) the window start, and no sound in the recording inside the window...
    const recordingQuiet =
      this.coverFrom !== null &&
      this.coverFrom <= from + o.pcmSlackMs &&
      t - this.lastPcmAt <= o.maxPcmGapMs &&
      (this.lastPcmLoudAt === null || this.lastPcmLoudAt < from);
    // ...nor on any track (deafness).
    const quiet = recordingQuiet && (this.lastLoudAt === null || this.lastLoudAt < from);
    const { speakingMs, changes, seen, maxPeak, maxTrack, trackSoundMs } = this.#indicators(t, from);
    let reason;
    if (!recordingQuiet) reason = "sound";
    else if (!quiet) reason = o.capture !== "off" && !alone && trackSoundMs >= o.captureSoundMs ? "capture" : "sound";
    else if (alone) reason = "the bot is alone";
    else if (speakingMs < o.minSpeakingMs) reason = "nobody is speaking";
    else if (changes < this.#changesNeeded()) reason = "the speaker indicator does not change (sticky)";
    else reason = "deaf";
    const quietFrom = reason === "capture" ? this.recordingQuietFrom : this.quietFrom;
    return {
      deaf: reason === "deaf",
      capture: reason === "capture",
      quiet,
      recordingQuiet,
      reason,
      windowSec: round1(t - from),
      quietSec: quietFrom === null ? 0 : round1(t - quietFrom),
      speakingSec: round1(speakingMs),
      changes,
      speakers: [...seen].slice(0, 6).map((key) => this.labels.get(key) ?? key),
      peakDbfs: peakDbfs(maxPeak),
      trackMax: Math.round(maxTrack * 10_000) / 10_000,
      trackSoundSec: round1(trackSoundMs),
      participants: this.participants,
    };
  }

  /**
   * The observations over [from, t]: speaking time and speaker changes on the indicators,
   * the names seen, the loudest peak and track, and the time the tracks sounded at
   * captureTrackLevel.
   */
  #indicators(t, from) {
    const o = this.options;
    let speakingMs = 0;
    let trackSoundMs = 0;
    let changes = 0;
    let maxPeak = null;
    let maxTrack = 0;
    /** The last non-empty indicator set: a dark moment between two lit ones is not a change. */
    let prev = null;
    const seen = new Set();
    for (let i = 0; i < this.obs.length; i += 1) {
      const ob = this.obs[i];
      if (ob.t > t) break;
      const next = i + 1 < this.obs.length ? Math.min(this.obs[i + 1].t, t) : t;
      const start = Math.max(ob.t, from);
      const end = Math.min(next, ob.t + o.maxStepMs);
      if (end > start) {
        if (ob.names.length > 0) speakingMs += end - start;
        if (ob.trackMax >= o.captureTrackLevel && ob.trackMax > o.trackSoundLevel) trackSoundMs += end - start;
      }
      if (ob.t < from) {
        if (ob.names.length > 0) prev = ob.names;
        continue;
      }
      // A change lights someone who was not lit the last time anyone was: a sticky tile that
      // flickers off and on again (re-render, screen share) never counts, A → B → A counts twice.
      if (ob.names.length > 0) {
        if (prev !== null && ob.names.some((name) => !prev.includes(name))) changes += 1;
        prev = ob.names;
      }
      for (const name of ob.names) seen.add(name);
      if (ob.peak !== null) maxPeak = Math.max(maxPeak ?? 0, ob.peak);
      maxTrack = Math.max(maxTrack, ob.trackMax);
    }
    return { speakingMs, trackSoundMs, changes, seen, maxPeak, maxTrack };
  }

  #act(t, type, reason, evidence) {
    if (this.phase === "deaf") this.step += 1;
    this.attempts += 1;
    this.busy = { type, t };
    this.history.push({ type, t, ok: null });
    const what = ACTION_TEXT[type]?.en ?? type;
    const capture = this.reason === "capture";
    const tag = capture ? " (capture)" : "";
    const msg =
      reason === "detected"
        ? `Deaf bot: ${(TEXT[this.reason] ?? TEXT.deaf).en}; ${what} (attempt ${this.attempts})`
        : reason === "retry"
          ? `Deaf bot: still no meeting audio${capture ? " in the recording" : ""}${tag}; ${what} (attempt ${this.attempts})`
          : reason === "relapse"
            ? `Deaf bot: ${this.#goneAgain()}; ${what} (attempt ${this.attempts})`
            : `Deaf bot: still no meeting audio${capture ? " in the recording" : ""}${tag}; ${what} again (attempt ${this.attempts})`;
    return { type, step: this.step, attempt: this.attempts, reason, evidence, msg };
  }

  /**
   * Sound is back: sustained loud recording, or sounding participant tracks (see
   * DEAF_GUARD_DEFAULTS) unless this episode saw capture evidence: then the tracks had
   * sound all along and only the recording counts.
   */
  #recovery(t) {
    const o = this.options;
    const recent = this.obs.filter((ob) => ob.t >= t - o.recoveryWindowMs && ob.t <= t);
    const reads = recent.filter((ob) => ob.pcmLoud);
    const tracks = recent.filter((ob) => ob.trackLoud);
    const span = (list) => (list.length === 0 ? 0 : list.at(-1).t - list[0].t);
    const byRecording = reads.length >= o.recoveryReads && span(reads) >= o.recoverySpanMs;
    // Sustained on the tracks too: three sampler ticks can be 0.7 s apart, a burst is no recovery.
    const byTracks = !this.captureSeen && tracks.length >= o.recoveryTrackObs && span(tracks) >= o.recoverySpanMs;
    if (!byRecording && !byTracks) return null;
    const peaks = recent.filter((ob) => ob.peak !== null).map((ob) => ob.peak);
    const action = {
      type: "recovered",
      deafMs: this.since === null ? 0 : t - this.since,
      attempts: this.attempts,
      tried: this.history.map((entry) => ({ type: entry.type, ok: entry.ok })),
      evidence: {
        reason: this.reason ?? "deaf",
        by: byTracks ? (byRecording ? "recording+tracks" : "tracks") : "recording",
        loudReads: reads.length,
        soundSpanSec: round1(span(reads)),
        trackObs: tracks.length,
        trackSpanSec: round1(span(tracks)),
        trackMax: Math.round(Math.max(0, ...recent.map((ob) => ob.trackMax)) * 10_000) / 10_000,
        peakDbfs: peakDbfs(peaks.length === 0 ? 0 : Math.max(...peaks)),
      },
      msg: `Audio recovered after ${round1(this.since === null ? 0 : t - this.since)} s without meeting audio${this.captureSeen ? " in the recording" : ""} (${this.attempts} recovery attempt(s))`,
    };
    this.lastEpisode = { recoveredAt: t, step: this.step, attempts: this.attempts, history: this.history, escalated: this.phase === "escalated", captureSeen: this.captureSeen };
    this.phase = "hearing";
    this.reason = null;
    this.captureSeen = false;
    this.since = null;
    this.step = 0;
    this.attempts = 0;
    this.history = [];
    this.escalatedAt = null;
    this.evidenceFrom = t;
    return action;
  }
}
