// Who is speaking, fused from three independent signals (docs/dev/DESIGN.md
// §6.4), plus the "alone" and "silence" leave rules. Pure logic: the caller
// passes the time, so everything here is unit-tested without a browser.
//
//   store - Zoom's Redux state (active-speaker ids → names), lag ~0.7 s
//   tile  - the highlighted video tile's name, sticky, lag ~1.2 s
//   track - per-participant WebRTC audio level, lag ~0.1 s, but anonymous:
//           a track id is mapped to a name by voting against store/tile.

export const DEFAULT_LAG_MS = Object.freeze({ track: 100, store: 700, tile: 1200 });

export const DEFAULT_FUSION = Object.freeze({
  /** A change must be seen in this many consecutive samples. */
  holdSamples: 2,
  /** Per-track RMS (0..1, max over the poll window) that counts as speech. */
  loudRms: 0.012,
  /** A track keeps "speaking" this long after its last loud sample (bridges syllable gaps). */
  hangoverMs: 450,
  /** Longer hangover used only to decide whether one person talks alone (voting). */
  voteHangoverMs: 1_200,
  /** Both the loud track and the UI speaker must be stable this long before a vote. */
  voteStableMs: 1_500,
  minVotes: 3,
  voteMargin: 2,
  maxVotes: 20,
  /** Tracks not reported for this long are forgotten (removed or ended). */
  trackStaleMs: 3_000,
  /**
   * A loud track whose learned name the store keeps contradicting (it lights
   * someone else, not that name) for this long is distrusted: Zoom may reuse
   * a receive stream for another participant.
   */
  contradictMs: 1_200,
  /**
   * The store counts as broken (like null) once the tile lit this many new
   * speakers while the store named nobody: Zoom changed its active-speaker
   * state, and an empty store set would otherwise hide the tile and stop the
   * track voting. The store's first speaker revives it.
   */
  storeDeadTileOnsets: 3,
});

const ROLE_SUFFIX = /\s*\((?:\s*(?:host|co-host|cohost|me|guest|you)\s*,?)+\)\s*$/i;
/** Zoom briefly puts an accessibility alert into the tile footer: "<name> connected to audio". */
const STATUS_SUFFIX = /\s+(?:(?:is\s+)?(?:connected to|disconnected from)\s+(?:computer\s+)?audio|(?:has\s+)?(?:joined|left)\s+the\s+meeting|is\s+(?:speaking|talking|muted|unmuted))\s*\.?$/i;

/** Display name as Zoom shows it, trimmed, without "(Host)", "(Host, me)", "(Guest)", "connected to audio"… */
export function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(STATUS_SUFFIX, "").replace(ROLE_SUFFIX, "").trim();
    if (next === name) break;
    name = next;
  }
  return name;
}

export function nameKey(raw) {
  return normalizeName(raw).toLocaleLowerCase();
}

/** Normalised, de-duplicated, sorted names without the bot itself. */
export function cleanNames(list, botName) {
  if (!Array.isArray(list)) return [];
  const bot = nameKey(botName ?? "");
  const seen = new Map();
  for (const raw of list) {
    const name = normalizeName(raw);
    const key = name.toLocaleLowerCase();
    if (name === "" || key === bot || seen.has(key)) continue;
    seen.set(key, name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

/** Learns trackId → name from "one loud track while one UI speaker is lit" votes. */
export class TrackResolver {
  constructor({ minVotes = DEFAULT_FUSION.minVotes, voteMargin = DEFAULT_FUSION.voteMargin, maxVotes = DEFAULT_FUSION.maxVotes } = {}) {
    this.minVotes = minVotes;
    this.voteMargin = voteMargin;
    this.maxVotes = maxVotes;
    /** @type {Map<string, Map<string, number>>} */
    this.votes = new Map();
  }

  vote(trackId, name) {
    let tally = this.votes.get(trackId);
    if (tally === undefined) {
      tally = new Map();
      this.votes.set(trackId, tally);
    }
    // Competing names fade so a reassigned track can be relearned.
    for (const [other, count] of tally) {
      if (other !== name) tally.set(other, Math.max(0, count - 0.5));
    }
    tally.set(name, Math.min(this.maxVotes, (tally.get(name) ?? 0) + 1));
  }

  resolve(trackId) {
    const tally = this.votes.get(trackId);
    if (tally === undefined) return null;
    let best = null;
    let bestCount = 0;
    let second = 0;
    for (const [name, count] of tally) {
      if (count > bestCount) {
        second = bestCount;
        best = name;
        bestCount = count;
      } else if (count > second) {
        second = count;
      }
    }
    if (bestCount < this.minVotes || bestCount - second < this.voteMargin) return null;
    // Two voices with real support on one track: a mixed or reused stream.
    // Trusting it would attribute one person's speech to another.
    if (second >= this.minVotes && second >= 0.34 * bestCount) return null;
    return best;
  }

  /** Halve a name's votes on a track (the track now seems to carry someone else). */
  penalize(trackId, name) {
    const tally = this.votes.get(trackId);
    if (tally?.has(name)) tally.set(name, tally.get(name) / 2);
  }

  /** trackId → resolved name (only resolved tracks). */
  mapping() {
    const out = {};
    for (const trackId of this.votes.keys()) {
      const name = this.resolve(trackId);
      if (name !== null) out[trackId] = name;
    }
    return out;
  }
}

/** Emits a set only after it was observed `holdSamples` times in a row; the event carries the first observation. */
export class Debouncer {
  constructor(holdSamples = DEFAULT_FUSION.holdSamples) {
    this.hold = Math.max(1, Math.floor(holdSamples));
    this.current = [];
    this.pending = null;
  }

  push(t, speakers, src) {
    if (sameSet(speakers, this.current)) {
      this.pending = null;
      return null;
    }
    if (this.pending !== null && sameSet(this.pending.speakers, speakers)) this.pending.count += 1;
    else this.pending = { t, speakers, src, count: 1 };
    if (this.pending.count < this.hold) return null;
    const { t: first, src: firstSrc } = this.pending;
    this.current = speakers;
    this.pending = null;
    return { t: first, speakers, src: firstSrc };
  }
}

/**
 * Combines store/tile/track samples into speaker events.
 * Priority: loud resolved tracks > store > tile.
 */
export class SpeakerFusion {
  constructor({ botName = "", lagMs = {}, ...options } = {}) {
    this.botName = botName;
    this.options = { ...DEFAULT_FUSION, ...options };
    this.lagMs = { ...DEFAULT_LAG_MS, ...lagMs };
    this.resolver = new TrackResolver(this.options);
    this.debouncer = new Debouncer(this.options.holdSamples);
    /** @type {Map<string, {lastLoudAt: number, seenAt: number, level: number}>} */
    this.tracks = new Map();
    this.active = { key: "", since: 0 };
    this.ui = { key: "", since: 0 };
    this.lastFused = { speakers: [], src: "none" };
    this.storeHealth = { tileKey: "", tileOnsets: 0, dead: false };
  }

  get current() {
    return this.debouncer.current;
  }

  /**
   * One sample. `store`/`tile` are name arrays or null when that signal is
   * unavailable; `tracks` is [{id, level}].
   * Returns { event: SpeakerEvent|null, fused, speakingTracks, voted }.
   */
  push(t, { store = null, tile = null, tracks = [] } = {}) {
    const { loudRms, hangoverMs, voteHangoverMs, voteStableMs, trackStaleMs } = this.options;
    const tileSet = tile === null ? null : cleanNames(tile, this.botName);
    const storeSet = this.#storeSignal(store === null ? null : cleanNames(store, this.botName), tileSet);

    for (const track of tracks ?? []) {
      if (typeof track?.id !== "string") continue;
      let state = this.tracks.get(track.id);
      if (state === undefined) {
        state = { lastLoudAt: -Infinity, seenAt: t, level: 0 };
        this.tracks.set(track.id, state);
      }
      state.seenAt = t;
      state.level = Number(track.level) || 0;
      if (state.level >= loudRms) state.lastLoudAt = t;
    }
    for (const [id, state] of this.tracks) {
      if (t - state.seenAt > trackStaleMs) this.tracks.delete(id);
    }
    const speakingIds = [];
    const activeIds = [];
    for (const [id, state] of this.tracks) {
      if (t - state.lastLoudAt <= hangoverMs) speakingIds.push(id);
      if (t - state.lastLoudAt <= voteHangoverMs) activeIds.push(id);
    }

    // Voting: one track has been talking alone while the UI shows one person.
    const ui = storeSet ?? tileSet;
    const activeKey = [...activeIds].sort().join("|");
    if (activeKey !== this.active.key) this.active = { key: activeKey, since: t };
    const uiKey = ui === null ? "" : ui.join("|");
    if (uiKey !== this.ui.key) this.ui = { key: uiKey, since: t };
    let voted = null;
    if (
      activeIds.length === 1 &&
      ui !== null &&
      ui.length === 1 &&
      t - this.active.since >= voteStableMs &&
      t - this.ui.since >= voteStableMs &&
      // The UI must have switched to this person after the track started
      // talking; a sticky indicator left over from the previous speaker must not vote.
      this.ui.since >= this.active.since - 500 &&
      !this.#ownedByOtherRecentTrack(ui[0], activeIds[0], t)
    ) {
      this.resolver.vote(activeIds[0], ui[0]);
      voted = { track: activeIds[0], name: ui[0] };
    }

    const loudNames = cleanNames(
      speakingIds.map((id) => this.#trustedName(id, storeSet, t)).filter((name) => name !== null),
      this.botName,
    );
    let fused;
    if (loudNames.length > 0) fused = { speakers: loudNames, src: "track" };
    else if (storeSet !== null) fused = { speakers: storeSet, src: "store" };
    else if (tileSet !== null) fused = { speakers: tileSet, src: "tile" };
    else fused = { speakers: [], src: "none" };
    this.lastFused = fused;

    const change = this.debouncer.push(t, fused.speakers, fused.src);
    const event =
      change === null
        ? null
        : { t: change.t, speakers: change.speakers, src: change.src, lagMs: this.lagMs[change.src] ?? 0 };
    return { event, fused, speakingTracks: speakingIds, voted };
  }

  /** The store set, or null while the store looks broken (see DEFAULT_FUSION.storeDeadTileOnsets). */
  #storeSignal(storeSet, tileSet) {
    const health = this.storeHealth;
    const tileKey = tileSet === null ? "" : tileSet.join("|");
    const tileOnset = tileSet !== null && tileSet.length > 0 && tileKey !== health.tileKey;
    health.tileKey = tileKey;
    if (storeSet === null) return null;
    if (storeSet.length > 0) {
      health.tileOnsets = 0;
      health.dead = false;
      return storeSet;
    }
    if (tileOnset) health.tileOnsets += 1;
    if (health.tileOnsets >= this.options.storeDeadTileOnsets) health.dead = true;
    return health.dead ? null : storeSet;
  }

  /** The resolved name of a speaking track, unless the store has been contradicting it for a while. */
  #trustedName(id, storeSet, t) {
    const name = this.resolver.resolve(id);
    const state = this.tracks.get(id);
    if (name === null || state === undefined) return null;
    const key = name.toLocaleLowerCase();
    const contradicted = storeSet !== null && storeSet.length > 0 && !storeSet.some((n) => n.toLocaleLowerCase() === key);
    if (!contradicted) {
      state.contradictedSince = null;
      state.penalized = false;
      return name;
    }
    state.contradictedSince ??= t;
    if (t - state.contradictedSince < this.options.contradictMs) return name;
    if (!state.penalized) {
      this.resolver.penalize(id, name);
      state.penalized = true;
    }
    return null;
  }

  /** `name` already belongs to another track that talked recently → the UI is probably lagging. */
  #ownedByOtherRecentTrack(name, trackId, t) {
    for (const [id, state] of this.tracks) {
      if (id === trackId) continue;
      if (this.resolver.resolve(id) === name && t - state.lastLoudAt <= 20_000) return true;
    }
    return false;
  }

  /** Close the timeline at the end of the meeting: a final [] line when someone was speaking. */
  finish(t) {
    if (this.debouncer.current.length === 0) return null;
    this.debouncer.current = [];
    this.debouncer.pending = null;
    return { t, speakers: [], src: "end", lagMs: 0 };
  }

  /** Compact view of the per-track state for signals.jsonl. */
  trackSnapshot() {
    return [...this.tracks].map(([id, state]) => ({
      id: id.slice(0, 12),
      lvl: Math.round(state.level * 1000) / 1000,
      name: this.resolver.resolve(id),
    }));
  }
}

/**
 * Leave when the participant count (which includes the bot) stays ≤ 1 for
 * `timeoutMs`, whether nobody ever came or everyone left. Unknown counts
 * (null) neither start nor reset the timer.
 */
export class AloneDetector {
  constructor(timeoutMs, startT) {
    this.timeoutMs = timeoutMs;
    this.aloneSince = startT;
    this.othersSeen = false;
  }

  update(t, count) {
    // Never leave on missing information: a DOM change that hides the count
    // must not make the bot quit every meeting after aloneTimeoutSec.
    if (count === null || count === undefined || !Number.isFinite(count)) return false;
    if (count >= 2) {
      this.aloneSince = null;
      this.othersSeen = true;
      return false;
    }
    this.aloneSince ??= t;
    return this.#due(t);
  }

  aloneForMs(t) {
    return this.aloneSince === null ? 0 : t - this.aloneSince;
  }

  #due(t) {
    return this.aloneSince !== null && t - this.aloneSince >= this.timeoutMs;
  }
}

/** Leave after `timeoutMs` without any audible sound in the recording (0 = never). */
export class SilenceDetector {
  constructor(timeoutMs, startT, threshold = 0.0003) {
    this.timeoutMs = timeoutMs;
    this.threshold = threshold;
    this.lastSoundAt = startT;
  }

  update(t, rms) {
    if (rms !== null && rms !== undefined && rms >= this.threshold) this.lastSoundAt = t;
    return this.timeoutMs > 0 && t - this.lastSoundAt >= this.timeoutMs;
  }

  silentForMs(t) {
    return t - this.lastSoundAt;
  }
}
