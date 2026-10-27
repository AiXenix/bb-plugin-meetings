# bb-plugin-meetings — design and contracts

Status: implementation spec. Every component must follow the contracts here
and in `src/shared/*.ts`. If a contract has to change, change it here and in
the shared module in the same edit, and say so in your final report.

## 1. What it does

A Fireflies-style meeting notetaker for bb:

1. The user gives an agent (or the CLI, or the Meetings page) a Zoom link.
2. A bot joins the meeting through the **Zoom web client** in a real Google
   Chrome (headed, inside Xvfb), with a silent virtual microphone, and records
   what Chrome plays (PulseAudio null sink → ffmpeg).
3. While it records, it samples the Zoom DOM several times per second to log
   **who is speaking** (the tile/participant whose speaking indicator lights up)
   and the participant roster.
4. A transcriber transcribes the audio **live** with the local **GigaAM v3**
   server (the `gigaam` bb plugin), splits speech with Silero VAD, assigns each
   segment to a speaker from the DOM timeline, and on finish refines speakers
   with acoustic speaker embeddings (sherpa-onnx) + clustering.
5. Everything is visible on a **Meetings** page in bb (nav panel), searchable,
   downloadable, and agents can read transcripts and save summaries.
6. Optional: Fireflies-like calendar auto-join from ICS feeds.

Plugin id `meetings`, package `bb-plugin-meetings`, author `AiXenix`.
UI language: **Russian**. Code, identifiers and comments: English.

## 2. Process model

```
bb server process ──── server.ts (src/server/*)
   │  SQLite registry, RPC for the page, CLI `bb meetings`, agent tools,
   │  scheduler + reconcile loop, calendar sync, HTTP routes (audio/screenshot/downloads)
   │
   │ host RPC (src/shared/contract.ts: hostContract)
   ▼
bb host worker (on the primary machine) ── host.ts (src/host/*)
   │  installs runtime (doctor/setup), spawns/stops/inspects DETACHED processes,
   │  reads files inside meeting dirs, discovers the GigaAM endpoint
   │
   ├── node bot-runner.mjs --meeting-dir <dir>      (detached, own process group;
   │      │                                          bb's own Node, process.execPath)
   │      ├── Xvfb :<n> -screen 0 1280x864x24
   │      ├── google-chrome (playwright-core, headed on Xvfb,
   │      │     PULSE_SINK=mtg_<short>, PULSE_SOURCE=mtg_<short>_mic)
   │      └── ffmpeg -f pulse mtg_<short>.monitor → audio.ogg (+ audio.pcm for live ASR)
   │
   └── <venv>/python transcriber.py --meeting-dir <dir> --mode live|offline   (detached)
          ├── reads audio.pcm (tail) + speakers.jsonl + state.json
          ├── VAD (sherpa-onnx silero) → ASR (HTTP to GigaAM) → segments.jsonl
          └── on finish: speaker embeddings + clustering → transcript.json/.md/.txt
```

Why detached: a recording must survive plugin reloads, plugin updates and bb
daemon restarts. The host worker is stateless: all runtime state lives in files
in the meeting directory. Every host call re-reads files. Processes are found by
pid recorded in `pids.json` (written by the host when it spawns them) and in
their state files, and verified through `/proc/<pid>/cmdline` containing the
meeting dir (PID reuse safe). A detached bot also outlives a plugin **removal**:
nothing stops it until the meeting ends or a leave rule fires, so the user docs
tell users to stop active meetings before `bb plugin remove meetings`.

The bots run on the **primary host** (`bb.sdk.system.config().primaryHostId`).
`host_id` is stored per meeting for later multi-host support.

## 3. Host data layout

`<hostData>` = `context.experimental_paths.dataDir` of the host entry
(on this machine `/home/bb/.bb/plugins/meetings/host-data`).

```
<hostData>/
  bin/uv                         uv 0.13.0 (downloaded, sha256-checked)
  python/ cache/                 uv-managed Python 3.12 + cache (cache/downloads)
  venv/                          transcriber venv: sherpa-onnx + numpy
                                 (runtime/transcriber/requirements.txt;
                                 .meetings-install.json = installed spec)
  models/                        silero_vad_v5.onnx, nemo_en_titanet_small.onnx,
                                 .verified.json (sha256 verified per mtime+size)
  packages/playwright-core-1.64.0/   registry tarball, integrity-checked (sha512),
                                 .complete marker
  runtime/<runtimeHash>/         embedded runtime files written by the host
      bot/bot-runner.mjs, bot/platform-{zoom,mock}.mjs, bot/lib/*.mjs,
      bot/page/{zoom-page,scheme-guard,track-hook}.js,
      transcriber/transcriber.py (+ requirements.txt), mock-meeting/*
      node_modules/playwright-core   symlink → <hostData>/packages/playwright-core-1.64.0
      .ready                     marker written after a complete install
  profiles/zoom/                 persistent signed-in Chrome profile (§6.6)
  gigaam.json                    {url, updatedAt}: current GigaAM endpoint, re-read
                                 by running transcribers
  pulse-client.conf              PulseAudio client.conf (autospawn off) for the
                                 host's own pactl calls
  logs/setup.log
  setup.json                     last setup result
  meetings/<meetingId>/          one directory per meeting, see §4
```

Pins live in `src/host/platform.ts` (`UV_VERSION`, `PYTHON_VERSION`,
`PLAYWRIGHT_CORE`, `MODELS`); paths in `src/host/paths.ts` (`hostPaths`).

The runtime files are embedded into the host bundle by
`scripts/embed-runtime.mjs` → `src/generated/runtime-files.ts`
(`RUNTIME_FILES: Record<relativePath, string>` and `RUNTIME_HASH`), the same
pattern the gigaam plugin uses for its Python server. `npm run embed` after
editing anything in `runtime/`; a test checks the generated file is current.

## 4. Meeting directory files (the runtime contract)

All JSON files are written atomically (write `<name>.tmp` then rename).
JSONL files are append-only; readers must tolerate a partial last line.
Times are epoch milliseconds unless the field name ends with `Sec`.
Zod schemas for all of these live in `src/shared/runtime-files.ts`; the bot
runner (plain JS) and the transcriber (Python) must produce exactly these shapes.

| File | Writer | Content |
|---|---|---|
| `config.json` | host | `BotConfig` — everything the bot and transcriber need |
| `state.json` | bot | `BotState` — phase, timings, participants, errors |
| `events.jsonl` | bot | `{t, level, msg, data?}` log of bot steps |
| `speakers.jsonl` | bot | `SpeakerEvent` — one line per change of the active-speaker set |
| `roster.json` | bot | `{t, count, names[]}` latest participant snapshot |
| `audio.ogg` | bot (ffmpeg) | Opus 48 kHz mono ~32 kbit/s, the archive copy |
| `audio.pcm` | bot (ffmpeg) | s16le 16 kHz mono raw, for live ASR; deleted after final transcript unless `keepRawAudio` |
| `screen.jpg` | bot | latest screenshot of the bot's browser (every `screenshotIntervalSec`) |
| `debug/*.html, *.json, *.jpg` | bot | DOM dumps and screenshots at join, at failure, and on request |
| `signals.jsonl` | bot | compact raw speaker signals (`{t, store, tile, tracks, …}`, ≤ 1 line/s) for offline tuning |
| `chrome-profile/` | bot | the meeting's own Chrome profile (copy of `profiles/zoom` when signed in); deleted on exit |
| `stop.request` | host | presence = stop requested (bot also handles SIGTERM) |
| `debug.request` | host | presence = dump DOM + screenshot to `debug/` now (`bb meetings debug-dump`) |
| `viewer.json` | host | `{until}` epoch ms: a live viewer is watching, screenshot every 1 s until then |
| `control/<seq>.json` | host | `ControlCommand` for remote control (§6.5) |
| `control/ack.json` | bot | `{seq, t, ok, error?}` — the last executed command |
| `pids.json` | host | `{bot: {pid, startedAt}, transcriber: {pid, startedAt, mode, restarts}}` |
| `transcriber.json` | transcriber | `TranscriberState` — phase, progress, checkpoint |
| `transcriber.lock` | transcriber | `flock` so only one transcriber runs per meeting |
| `segments.jsonl` | transcriber | `Segment` lines, live and provisional |
| `embeddings.jsonl` | transcriber | `{id, emb}` per segment, `emb` = base64 float32 TitaNet embedding |
| `transcript.json` | transcriber | `Transcript` — final, refined speakers |
| `transcript.md`, `transcript.txt` | transcriber | human-readable renderings of the final transcript |
| `bot.log`, `transcriber.log` | process stdout/stderr | raw logs |

File names are `MEETING_FILES` in `src/host/paths.ts`.

### 4.1 BotConfig (`config.json`)

```ts
{
  version: 1,
  meetingId: "mtg_…",
  mode: "meeting" | "login",        // login = Zoom sign-in session (§6.6), no audio/transcriber
  platform: "zoom" | "mock",
  url: string,              // original link as given
  joinUrl: string,          // web-client URL computed by meeting-url.ts
  meetingNumber: string | null,
  passcode: string | null,
  botName: string,
  maxDurationSec: number,
  aloneTimeoutSec: number,          // leave after being alone this long
  waitingTimeoutSec: number,        // give up waiting for host / in waiting room / on a captcha
  silenceTimeoutSec: number,        // leave after this long with no audio at all; 0 = never
  screenshotIntervalSec: number,
  chatAnnouncement: string,         // "" = none
  speakerSelectors: object | null,  // advanced override, see §6.4
  chromePath: string,               // resolved absolute path
  zoomProfileDir: string | null,    // <hostData>/profiles/zoom when useZoomAccount (or login mode); null = fresh guest profile
  liveTranscription: boolean,
  transcriber: {
    gigaamUrl: string | null,       // e.g. http://127.0.0.1:38271 ; null = wait/retry discovery file
    diarization: "ui+acoustic" | "ui" | "acoustic",
    speakerLagMs: number,           // lag for SpeakerEvents without lagMs; shifts stamped lags by (speakerLagMs - 700) (§4.3)
    keepRawAudio: boolean,
    threads: number
  },
  createdAt: number
}
```

### 4.2 BotState (`state.json`)

```ts
{
  version: 1,
  meetingId: string,
  pid: number,                       // bot-runner pid
  phase: "starting" | "joining" | "waiting_for_host" | "waiting_room"
       | "in_meeting" | "leaving" | "ended" | "failed",
  detail: string,                    // short human-readable (English) description of what's happening
  startedAt: number,
  joinedAt: number | null,
  recordingStartedAt: number | null, // epoch ms of audio sample 0
  endedAt: number | null,
  endReason: null | "stopped" | "meeting_ended" | "removed" | "alone"
           | "silence" | "max_duration" | "waiting_timeout" | "error",
  error: null | { code: BotErrorCode, message: string },
  participants: { count: number | null, names: string[] },
  activeSpeakers: string[],
  audio: { seconds: number, bytes: number },   // pcm-based duration
  audioIssue?: null | {              // deaf-bot guard (§6.8); optional, older bots omit it
    since: number | null,            // the bot has heard nothing since (window start at detection)
    attempts: number,                // recovery actions in this episode
    lastAction: string | null,       // "rejoin_audio" | "reload"
    message: string,                 // Russian, user-facing, says what was tried
    escalated?: boolean,             // the automatic ladder failed: warn the user (absent = true)
    reason?: "deaf" | "capture"      // no audio delivered / the tracks sound but the recording is silent
  },                                 // (absent = "deaf"; an unknown value reads as absent)
  updatedAt: number
}
```

`audioIssue` is `audioIssueSchema` in `src/shared/runtime-files.ts`; a malformed
value reads as `null` (it must never hide the rest of the state). A meeting that
ends while the bot is deaf keeps the issue in its final state with the message
in the past tense.

`BotErrorCode` = `"invalid_meeting" | "wrong_passcode" | "auth_required" |
"registration_required" | "bot_blocked" | "browser_join_disabled" |
"captcha" | "meeting_ended" | "meeting_locked" | "meeting_full" | "denied" |
"waiting_timeout" | "browser_crashed" | "dependency_missing" | "join_failed" |
"recording_failed" | "unknown"` (`BOT_ERROR_CODES` in `src/shared/runtime-files.ts`).

`recordingStartedAt` is `null` when there is no live recording timeline. An
imported file (`bb meetings import`) has none and must write `null`, never `0`:
the server and the renderers treat any number as the meeting date.

Terminal phases: `ended`, `failed`. A `failed` bot may still have audio (e.g.
browser crashed mid-meeting): the transcriber still transcribes what exists.

### 4.3 SpeakerEvent (`speakers.jsonl`)

```ts
{ t: number, speakers: string[], src: string, lagMs?: number }
```

One line whenever the set of currently-speaking participant names changes
(including to `[]`). `src` names the signal that decided it (§6.4): `"track"`,
`"store"`, `"tile"`, `"none"` (no signal), or `"end"` (the closing `[]` line
written when the bot leaves). `lagMs` is how late this observation is behind
the audio; the transcriber places the event at `t - lagMs`. The bot always
writes it (track 100, store 700, tile 1200, none/end 0 by default; override with
`speakerSelectors.lagMs`). The `speakerLagMs` setting is the lag for lines
without `lagMs` and shifts stamped lags by `speakerLagMs - 700`, so it tunes all
signals at once. Names are display names exactly
as Zoom shows them, trimmed, with suffixes like "(Host)", "(Me)", "(Guest)"
removed. The bot never reports itself as a speaker.

### 4.4 TranscriberState (`transcriber.json`)

```ts
{
  version: 1,
  pid: number,
  mode: "live" | "offline",
  phase: "waiting_audio" | "live" | "waiting_asr" | "finalizing" | "done" | "failed",
  detail: string,
  processedSec: number,     // audio consumed by VAD so far
  audioSec: number,         // audio available
  segments: number,         // segments emitted
  checkpoint: { samples: number, nextId: number },  // resume point
  error: string | null,
  startedAt: number,
  updatedAt: number,
  finishedAt: number | null
}
```

### 4.5 Segment (`segments.jsonl`, `transcript.json`)

```ts
{
  id: number,              // 0,1,2… stable within a transcript version
  start: number,           // seconds from recording start
  end: number,
  speakerKey: string,      // "ui:<name>" | "spk:<n>" | "unknown"
  speaker: string,         // display label: the name, or "Спикер 2", or "Неизвестный"
  source: "ui" | "acoustic" | "mixed" | "none",
  text: string
}
```

Live segments carry the DOM-based speaker (or `unknown`). The final transcript
may relabel every segment. Speaker keys are stable across re-transcription for
`ui:` keys only (and only while the `diarization` mode stays the same).
`spk:<n>` keys are numbered by the first appearance of an acoustic cluster and
can be renumbered by a re-transcription. User renames are stored server-side as
`speakerKey → name` and kept by `retranscribe`, so a `spk:` rename may then
label another voice; the user guide tells users to re-check them.

### 4.6 Transcript (`transcript.json`)

```ts
{
  version: 1,
  meetingId: string,
  audioSec: number,
  createdAt: number,
  asr: { engine: "gigaam", model: string | null },
  diarization: "ui+acoustic" | "ui" | "acoustic",
  speakers: Array<{ key: string, label: string, source: "ui"|"acoustic"|"mixed"|"none", talkSec: number, segments: number }>,
  segments: Segment[]
}
```

## 5. Transcriber algorithm (`runtime/transcriber/transcriber.py`)

Runs with `<hostData>/venv/bin/python`. Only `numpy` + `sherpa_onnx`
(+ stdlib). Must degrade gracefully: no sherpa-onnx → energy VAD in numpy and
UI-only speakers.

* **Live mode**: tail `audio.pcm` every ~0.5 s; feed Silero VAD (sherpa-onnx
  `VoiceActivityDetector`, threshold 0.4, min silence 0.4 s, max speech ~15 s
  soft / 20 s hard). For each speech segment:
  1. Attribute speakers from `speakers.jsonl`: each event is moved earlier by
     its own `lagMs` shifted by `speakerLagMs - 700` (Zoom's indicator lags the
     voice, §4.3). A speaker who joins the lit set takes the turn from that
     moment (the previous speaker's indicator stays lit a few hundred ms after a
     hand-over); the cut is searched in [-0.6 s, +0.3 s] around the change. Convert events to audio time with
     `state.json.recordingStartedAt`.
  2. If the dominant UI speaker changes inside the segment and both parts are
     ≥ 1.2 s, split there (at the lowest-energy 10 ms frame within ±0.3 s).
     In `acoustic` mode, and in `ui+acoustic` when the UI is not confident
     (< 60 %), also split at voice changes (TitaNet on 1.5 s windows, 0.5 s
     hop, cut where similarity drops below 0.3).
  3. ASR each piece: POST a 16 kHz mono s16 WAV to
     `<gigaamUrl>/v1/audio/transcriptions` (multipart `file`,
     `response_format=json`) → `{"text": …}`. Retry with backoff when the
     server is unreachable (phase `waiting_asr`); never drop audio. Empty text
     → skip segment.
  4. Compute a speaker embedding (pieces ≥ 1.0 s) and persist it to
     `embeddings.jsonl` (`{id, emb: base64 float32}`).
  5. Append the segment to `segments.jsonl`; update `transcriber.json`
     (`checkpoint.samples` = end sample of the last fully processed segment).
* It exits live mode when the bot is in a terminal phase (or its pid is dead)
  and `audio.pcm` stopped growing for 3 s; then flushes the VAD and finalizes.
* **Finalize**: cluster embeddings (cosine agglomerative, threshold from the
  probe), map clusters to UI names by duration-weighted vote, then choose each
  segment's final speaker: confident single UI speaker (≥ 60 % coverage) →
  that name (`ui`); else the cluster's name (`mixed`); else "Спикер N"
  (`acoustic`); nothing at all → "Неизвестный" (`none`). Merge adjacent
  same-speaker segments only in renderings, not in `segments`. Write
  `transcript.json`, `transcript.md`, `transcript.txt`; delete `audio.pcm`
  unless `keepRawAudio`.
* **Offline mode** (re-transcribe / import): decode `audio.ogg` with ffmpeg to
  16 kHz PCM (regenerate `audio.pcm`), discard old segments/embeddings, run the
  same pipeline without tailing, finalize.
* **Resume**: on start in live mode with an existing `transcriber.json`
  checkpoint, drop `segments.jsonl`/`embeddings.jsonl` lines with
  `id >= checkpoint.nextId` and continue from `checkpoint.samples`.
* CLI: `transcriber.py --meeting-dir D --mode live|offline [--models-dir M]
  [--gigaam-url U] [--host-data H] [--threads N]`. The gigaam URL is re-read
  from `<hostData>/gigaam.json` (`{url, updatedAt}`) written by the host when
  discovery changes, so a GigaAM restart on a new port does not stall
  transcription. `transcriber.lock` (`flock`) keeps a second transcriber for
  the same meeting from running.

## 6. Bot runner (`runtime/bot/*.mjs`)

Plain modern JavaScript ESM (no TypeScript, Node ≥ 22). Imports
`playwright-core` from the runtime dir's `node_modules`.

### 6.1 Lifecycle

1. Read `config.json`; write `state.json` (`starting`).
2. AV setup: ensure a user PulseAudio server (`pactl info`, else
   `pulseaudio --start --exit-idle-time=-1`); load null sink `mtg_<short>`
   (what Chrome plays → recorded) and a silent microphone: null sink
   `mtg_<short>_micsink` + `module-remap-source master=mtg_<short>_micsink.monitor
   source_name=mtg_<short>_mic` — **Chrome ignores monitor sources**, without a
   real source getUserMedia fails and Zoom never joins computer audio
   (research-zoom-probe.md). Start `Xvfb :<free display ≥ 100> -screen 0
   1280x864x24 -nolisten tcp -terminate` (`SCREEN` in `bot/lib/chrome.mjs`).
3. Launch Chrome headed on that display via playwright-core with
   `PULSE_SINK=mtg_<short>` and `PULSE_SOURCE=mtg_<short>_mic` — the **remap
   source**, not a `.monitor` (Chrome ignores monitor sources; ffmpeg is the
   one that records `mtg_<short>.monitor`). Flags (`bot/lib/chrome.mjs`):
   `--lang=en-US`, `--accept-lang=en-US,en`,
   `--disable-blink-features=AutomationControlled`,
   `--use-fake-ui-for-media-stream`, `--autoplay-policy=no-user-gesture-required`,
   `--no-first-run`, `--no-default-browser-check`, `--window-size=1280,863`,
   `--window-position=0,0`, `--disable-gpu`, `--password-store=basic`, the
   background-throttling switches and `--hide-crash-restore-bubble`. The
   1280x864 screen and 1280x863 window leave exactly a **1280x720 viewport**
   under the tab strip, toolbar and infobar, which is what `screen.jpg` and
   remote-control coordinates assume. No `--in-process-gpu`: the probe's flag
   set (research-zoom.md) crashes Chrome 155 at start (SIGTRAP). Chrome runs
   with its sandbox (`chromiumSandbox: true`; without it Chrome shows an
   "unsupported command-line flag" infobar, a bot tell that also shrinks the
   viewport) and is retried without it only when the sandbox fails to start.
   `ignoreDefaultArgs: ['--enable-automation']`, locale `en-US`,
   `viewport: null`, a fresh profile dir `chrome-profile/` under the meeting
   dir (deleted on exit) — or a copy of `zoomProfileDir` (signed-in Zoom
   account) when set. Block the Zoom desktop
   hand-off: profile prefs `protocol_handler.excluded_schemes` for
   zoommtg/zoomus/zoomusm, `context.route` abort for those schemes and an init
   script guard; if the native "Open xdg-open?" dialog still appears it eats
   all trusted input — dismiss with `xdotool key Escape` on the bot's DISPLAY.
4. `joining`: the platform adapter joins (§6.2). Waiting states update the
   phase. Timeouts → `failed` with the right `BotErrorCode`. The name and the
   passcode go in with `locator.fill()` (one trusted insertText); humanized
   per-key typing is only the fallback when `fill()` leaves the field wrong.
   Per-key CDP typing at a steady cadence made Zoom answer "Automated bots
   aren't allowed to join this meeting" in 3 of 3 runs while `fill()` got in
   3 of 3 (2026-10-13, same machine and IP); this supersedes research-zoom.md
   §8 "Name — must be real keystrokes". On that bot wall the adapter retries
   twice with a fresh page (clearing cookies for guest profiles), then fails
   with `bot_blocked`. A captcha keeps the phase `joining` (detail "Zoom shows
   a captcha…") until a human solves it through remote control, or fails with
   `captcha` after `waitingTimeoutSec`.
5. `in_meeting`: start ffmpeg (one input, two outputs: `audio.ogg` Opus and
   `audio.pcm` s16le 16 kHz mono); set `recordingStartedAt`; post the chat
   announcement if configured; start the sampler loop (~4 Hz) for speakers +
   roster + end detection; screenshot loop.
6. Leave on: stop request (SIGTERM/SIGINT or `stop.request`), meeting ended,
   removed, alone ≥ `aloneTimeoutSec` (participant count ≤ 1 after at least
   one other participant was seen, or 0 others from the start for that long),
   no audio at all (RMS below 0.0003) for `silenceTimeoutSec` when it is > 0
   (`endReason: "silence"`), `maxDurationSec`. Click Leave → confirm ("Leave
   Meeting", never "End Meeting for All"); stop ffmpeg gracefully (`q` on
   stdin, then SIGINT, then SIGKILL) so the Ogg trailer is written.
7. Cleanup always (finally): close browser, kill Xvfb, unload pulse modules,
   delete the profile dir, write terminal `state.json`, exit 0 (ended) / 1 (failed).
   A watchdog kills the whole process group if cleanup hangs > 20 s.

### 6.2 Platform adapters

```js
// runtime/bot/platform-zoom.mjs, runtime/bot/platform-mock.mjs
export default {
  name: "zoom",
  /** Join; resolve when inside the meeting with audio connected. Throw BotError(code, message) on failure. */
  async join(ctx) {},
  /** One sampling tick: raw signals for the fusion (§6.4), roster and end markers. */
  async sample(ctx) {
    return {
      signals: { store: null /* or names[] */, tile: null /* or names[] */, tracks: [] /* [{id, level}] */ },
      roster: null,   // or names[]
      count: null,    // or number (includes the bot)
      ended: null,    // or {reason, message}
      raw: {},        // adapter-specific extras for signals.jsonl
    };
  },
  /** Dismiss harmless popups; called every few seconds in the meeting. Returns the clicked labels. */
  async sweep(ctx) { return []; },
  /** Optional: keep the meeting audio joined (every few seconds). */
  async ensureAudio(ctx) { return { joined: true, needsJoin: false }; },
  /** Deaf-bot recovery step "rejoin_audio" (§6.8): {ok, detail}. Never Leave/End. */
  async recoverAudio(ctx, step) { return { ok: true, detail: "" }; },
  async sendChat(ctx, text) {},
  async leave(ctx) {},
}
```

`ctx = { page, context, config, selectors, display, signal, log(level,msg,data), setPhase(phase, detail), dumpDebug(tag), wantScreenshot(), adapterState, joinedAt }`.
The bot runner turns `sample().signals` into `SpeakerEvent`s with
`SpeakerFusion` (`bot/lib/fusion.mjs`), and the participant count into the alone
rule with `AloneDetector`.

### 6.3 Mock platform

`platform: "mock"` is selected for `http://127.0.0.1:*` / `http://localhost:*`
URLs whose path contains `/mock-meeting`. `runtime/mock-meeting/` contains a
static page that imitates the Zoom web-client DOM *classes the zoom adapter
uses for speaker detection*, plays a scripted list of audio clips with the
matching tile highlighted, and shows a "meeting ended" message at the end. It
is used by the end-to-end test and by `bb meetings selftest`.

Mock query parameters for the deaf-bot guard (§6.8): `deaf=rejoin|reload|forever`
(the speaking indicators work but every participant's gain is 0, so the WebRTC
tracks and the playback are silent, until the bot leaves and joins computer
audio through the mock's "More audio controls" menu / until the second page load
in the tab / never), `speaker=other` (the store reports a non-default output),
`silent=1` (no audio, nobody lit), `sticky=<name>` + `stickyAfterSec=N` (one
indicator stays lit, like a screen share) and `loops=N` (repeat the script).

### 6.4 Speaker detection (signal fusion in the bot)

Three independent signals, sampled ~4–5 Hz in the Zoom frame
(research-zoom.md §activeSpeaker):

1. **store** — Zoom's Redux store found by walking React fibers from `#root`
   / `#meeting-app`: `state.audio.asnIds` (active-speaker node ids) mapped to
   names via `state.attendeesList.attendeesList[].userId → displayName`;
   roster and count from the same list. No CSS dependency. Lag ~0.5–1 s.
2. **tile** — DOM: speaker-view main tile / active frame classes
   (`.speaker-bar-container__video-frame--active`,
   `.speaker-active-container__video-frame`, `.single-main-container__video-frame`,
   `.single-suspension-container__video-frame`,
   `.gallery-video-container__video-frame--active`) → name in
   `.video-avatar__avatar-footer span`. Sticky; lags ~1–2 s.
3. **track** — an init script hooks `RTCPeerConnection` remote audio tracks
   (Zoom in Chrome sends one track per participant) and measures per-track
   RMS with an AnalyserNode. The Node side learns `trackId → name` by voting
   against the store/tile speaker (a vote when exactly one track is loud and
   exactly one UI speaker is lit; adopt after ≥ 3 votes with margin). Loud
   resolved tracks give precise, overlapping speech intervals. Lag ~0.1 s.

Fusion: if any resolved track is loud → `src:"track"` with the loud tracks'
names, else the store set → `src:"store"`, else the tile name → `src:"tile"`.
Each `speakers.jsonl` line carries `lagMs` (track 100, store 700, tile 1200 by
default, overridable via `speakerSelectors.lagMs`). Debounce: a change must
hold for 2 samples. The bot's own name is always excluded. Raw signals go to
`signals.jsonl` (compact, ≤ 1 line/s) for offline tuning. Selectors are data
(`DEFAULT_SELECTORS` in the adapter) and `speakerSelectors` (JSON setting) can
override them without a rebuild. At join, and when no speaker has been detected
for 2 minutes while audio is non-silent, the bot dumps the DOM forensics
(every `.video-avatar__avatar-footer` with ancestor class chain, classes
matching /speak|talk|active|audio|volume|voice/) to `debug/`.

**Telemost** (`platform-telemost.mjs`, the probe runs in the private-join
iframe; checked against the web client's bundle `main.ru.0f7ed507…` and all 13
recorded debug dumps, 2026-10-27). Names come from the tiles' titled name
badges (`[class*='TextName_'][title]`, one name per badge). The self view
(`selfView_`) is the bot whatever name it shows; the default guest name
«Гость» is a participant (several guests share it); a name that is only part
of the bot's («Анна» next to «Notetaker Анна») is a person. The speaking
indicator is the tile's outline: the client adds the CSS-module class
`rootStroke_<hash>` (a 4 px `::after` border) to the tile's inner root while
the server's voice-activity flag for that slot is on and the participant is not
muted, so several tiles can be lit at once; `store` and `tile` both carry the
outlined names. A badge's tile is its `newGridItem_` grid item, else its
largest ancestor holding no other badge (the grid never counts as one tile).
The audio arrives as SFU-mixed slots (`goloom_mid_audio`: in every recorded
meeting only the first of three tracks was ever loud, whoever spoke), so
`sample()` passes the track levels without ids. The fusion never learns a name
for the mixed track (it would name it after the dominant speaker and put that
name over the outline at every turn: 3.5–4.4 % of the speaking samples in the
replay); the deaf-bot guard still gets the levels (capture mode, recovery), and
`signals.jsonl` keeps them as `levels`. If Telemost renames the class, `active`
is empty again (no false speaker); the no-speaker debug dumps show it. Not yet
seen live: the outline's lag and hold-over (the replays assume 0.8 s late),
screen-share and paginated layouts.

### 6.5 Remote control (human in the loop)

Captchas ("Type the characters you see"), sign-in walls and unexpected dialogs
can be solved by a human from the Meetings page: the page polls
`meetings.liveView` (host `meeting.viewer` → `viewer.json {until}` → the bot
screenshots every 1 s while a viewer is present) and sends clicks/keys/text
through `meetings.control` (host `meeting.control` → `control/<seq>.json`).
The bot polls `control/` every 250 ms, executes commands in order with
trusted Playwright mouse/keyboard input on the page at viewport coordinates,
records the last seq in `control/ack.json`, and takes a screenshot right after.
`done` ends a login session.

### 6.6 Zoom account sign-in (optional)

Zoom's web app may wall guest bots ("We detected you may be a bot … Sign in
to join") or require authenticated users. With the `useZoomAccount` setting
the bot copies the persistent profile `<hostData>/profiles/zoom` into its own
profile dir before launch and overwrites the prefilled name with `botName`.
The profile is created by a **login session**: `mode:"login"` bot run (no
audio, no transcriber) that opens `https://zoom.us/signin` in the persistent
profile directly; the user signs in through the remote-control live view; the
session ends on `done`, on detected sign-in (URL leaves /signin and a
`zm_aid`/`_zm_ssid`/`zm_haid` cookie exists after leaving /signin) plus 5 s,
or after 15 minutes. Launch Chrome with `--password-store=basic` so a copied
profile's cookies stay readable.

### 6.7 Deviations from the research

Measured on the real setup; they override research-zoom.md and
research-zoom-probe.md. Keep this list, the code and `src/shared/*` in sync.

* `PULSE_SOURCE` is the remap source `mtg_<short>_mic`, never a `.monitor`.
* Screen 1280x864, window 1280x863 → 1280x720 viewport (§6.1 step 3).
* `--disable-gpu` only; `--in-process-gpu` crashes Chrome 155 (SIGTRAP).
* Chrome keeps its sandbox; `--no-sandbox` only as a retry.
* Name and passcode via `locator.fill()`; per-key typing triggers Zoom's bot
  wall (research-zoom.md §8 "must be real keystrokes" is superseded).
* Bot wall → two fresh-page retries, then `bot_blocked`.
* Speaker lag is per signal, written into each `speakers.jsonl` line (§4.3).
* VAD min silence 0.4 s and embeddings from 1.0 s pieces (§5).

### 6.8 Deaf-bot guard

Incident 2026-10-27 (`mtg_mvqaselwbxfc`, Zoom): computer audio "connected"
(`currentUser.audio=computer`, `audioConnectionStatus=2`), speaker output
"default", video of everyone received, the active-speaker indicators busy for
30 minutes, yet `audio.pcm` was exact zeros apart from Zoom's own 1.3 s
"Recording in progress", and every WebRTC track level was 0 in all 1637
`signals.jsonl` samples. Zoom simply did not deliver the participants' audio.

`runtime/bot/lib/deaf-guard.mjs` (`DeafGuard`, pure, clock-injected, no
imports) watches every sampler tick: `observe({t, speakers, botName, pcmPeak,
trackLevels, participants})` → action | null. It catches the two ways the
recording ends up empty while the meeting talks (`audioIssue.reason`):

* **deaf**: the platform delivers no audio (the incident): recording and
  tracks silent, the indicators busy;
* **capture**: the participants' tracks carry sound, but none of it reaches
  the recording (the page plays to an output that is not recorded, muted or
  paused playback). It needs no speaking indicators, so it also works where
  they cannot be read (a platform that changed its markup; Telemost's could
  not be read before 0.3.1).

This file, `lib/audio-recovery.mjs` and their tests are the canonical copies:
the other products sharing this runtime take them byte-identical.

* **Inputs** (bot-runner): `speakers` = the UI indicator set (`store ?? tile`,
  bot removed), never the track-based fusion; `null` when the sample failed
  (unknown: the guard keeps the last indicators, so a dropped sample is neither
  a pause nor a new speaker); `trackLevels` = the track hook's per-track levels
  (max RMS 0..1 since the last poll); `pcmPeak` = peak |sample| of the newest
  `audio.pcm` bytes, read once per second by `PcmTail.read()` (the
  silence-timeout reader, at least 20 s per read — more than the guard's 15 s
  gap tolerance, so a slow tick is measured in full; whole samples only);
  `participants` = the sample's count.
* **Deaf** over the sliding window (`windowMs` 45 s): continuous measurements
  of the recording, all below `silentPeak` 1e-4 (-80 dBFS), no track level
  above 0, the bot not alone (count > 1), someone other than the bot marked
  speaking ≥ `minSpeakingMs` 10 s with ≥ `minChanges` 2 speaker changes (an
  observation lighting a name that the last non-empty indicator set did not:
  A → B → A is two changes, A → dark → A none). So a silent meeting, a sticky
  indicator (screen share, also one that flickers off and on) or a lone bot
  never count.
  A measurement gap > 15 s restarts the silent stretch.
* **Open episode** (detected, until it recovers): the bot is known to be deaf,
  and one person talking with a steady indicator looks exactly like a sticky
  one. The silence hold and the persistent audio rejoins after the warning
  therefore need only someone other than the bot lit for ≥ `minSpeakingMs`
  10 s of the window, with `openMinChanges` (default 0) speaker changes. The
  ladder steps before the warning keep the detection's 2 changes, and so does
  a persistent action other than `rejoin_audio` (`persistentAction: "reload"`),
  so a sticky indicator can never drive a reload. (Replayed on the real runner: with the
  recording and the tracks zeroed, `mtg_mvgr928zgps9` left "for silence" at
  5588 s of 7877 s with a 30 min timeout, at 3144 s with 15 min, at 1903 s with
  10 min, and its persistent rejoins paused for 14 and 20 min while one
  participant talked.)
* **Capture** over the same window: continuous measurements of the recording,
  all below -80 dBFS, the bot not alone, and the loudest track at or above
  `captureTrackLevel` 0.01 (-40 dBFS RMS) for ≥ `captureSoundMs` 10 s
  (observations summed like the speaking time, so they also span ≥ 10 s). The
  threshold is several times the tracks' noise (Telemost's comfort noise reads
  0.002–0.003) and below speech (fusion `loudRms` 0.012); played to the
  recorded output such a track cannot leave the recording 40 dB quieter. Track
  sound below that, or shorter, keeps the old verdict "sound" (no action, no
  note). `capture`: `"act"` (default) runs the ladder, `"log"` only writes a
  note, `"off"` ignores it.
* **Ladder** (both reasons): detected → `rejoin_audio`; deaf (or capture) again
  over the window since the step finished, at least `retryMs` 40 s later →
  `rejoin_audio`; again → `reload`; again → `warn` (escalate); then
  `rejoin_audio` every `persistentRetryMs` 3 min while still deaf. Every step
  needs fresh evidence (speaker activity or track sound over a silent
  recording) after the previous one: up to the warning the detection's
  evidence, after it someone lit for 10 s of the window (open episode, above).
  The issue's `reason` follows the latest evidence. One person talking alone
  right after the detection stalls the ladder (no reload, no warning yet) but
  holds the silence timeout; the issue (`escalated:false`) stays visible.
* **Recovered** on sustained sound within 20 s: ≥ `recoveryReads` 4 loud
  (≥ -80 dBFS) reads of the recording, or ≥ `recoveryTrackObs` 3 observations
  with a sounding WebRTC track (remote participants, never local sounds),
  either spanning ≥ `recoverySpanMs` 4 s. An episode that had capture evidence
  recovers by the recording only: its tracks had sound all along. A click,
  Zoom's 1.3 s local "Recording in progress" or a sub-second track burst does
  not count. The issue clears. Deaf again within `relapseMs` 5 min of a
  recovery is the same episode: the ladder continues where it stopped, so a
  brief or false recovery cannot restart the ladder forever (a deaf episode
  whose tracks come back while the recording stays silent "recovers" by the
  deaf rule and continues one window later as a capture relapse). An escalated
  one goes straight back to the warning (`warn` with `relapse: true`) and its
  next audio rejoin still waits `persistentRetryMs`, counted from the
  recovery: a flapping recovery keeps the 3-minute cadence.
* **Silence timeout** (`silenceTimeoutSec`, default 30 min): while an episode
  is open and the meeting talks over the last window — someone other than the
  bot lit for 10 s (`openMinChanges` changes, 0: one person talking alone is
  enough) or the capture evidence on the tracks, the bot not alone —
  `guard.speakingWhileDeaf(t)` holds it (`SilenceDetector.activity`), logged
  once if it would have fired ("…but the meeting is talking (deaf bot): staying
  in the meeting"). Once nobody is lit (or the bot is alone) the timeout runs
  again from that point. The price: in an open episode a sticky indicator holds
  it too; the alone timeout, the meeting's end and `maxDurationSec` still end
  the recording. After every recovery step the timeout restarts too, so time a
  reload spent in the waiting room never counts as a silent meeting. Time the
  detector did not observe is no silence either: a gap > 30 s between two of
  its reads (sampling paused by a step, a VM resume, the clock stepping
  forward) moves the silent stretch's start forward by the gap. (Replayed:
  without the hold the incident bot would have left "for silence" at 12 min
  with a 10 min timeout, 59f6a47 at 3 min with a 1 min timeout while one
  participant talked alone.)
* **Clock**: a wall clock that steps back more than 1 s (NTP, VM resume) drops
  the guard's evidence (a fresh window is needed; a relapse counts from the
  step) and clamps the open episode's `since` and escalation time to the new
  time (no negative "Audio recovered after" duration, no `audioIssue.since` in
  the future); the silence timeout restarts from the step; the runner
  measures the recording, checks the audio, sweeps popups, writes
  `signals.jsonl` and runs the no-speaker dump timer anyway (`|| now < last`)
  instead of waiting for the clock to catch up, and never sleeps longer than
  one sampling period (a step during a tick made the sleep as long as the
  step). A step forward only opens a measurement gap, which never counts as
  silence (guard and silence timeout). Not covered: the alone timeout and the
  60 s "page stopped responding" rule still count wall-clock time across a
  step forward.
* **Steps** (the sampler pauses while one runs; ffmpeg keeps recording; nothing
  ever presses Leave/End; a stop requested before a step starts skips it, so
  the bot leaves from the meeting page instead of reloading it): `rejoin_audio`
  = `adapter.recoverAudio(ctx, "rejoin_audio")` — Zoom/mock: pick the default
  speaker in "More audio controls" when the store's `activeSpeaker` is not
  default, then "Leave Computer Audio" in the same menu, join audio again with
  the regular `audio` join op, re-mute (`zoom-page.js` op `audioMenu`; the step
  gets its own signal and is called off after 60 s, so it never clicks on in
  the background; called off after rejoining it still mutes once; ensureAudio
  rejoins and re-mutes if it stopped halfway); Telemost/Meet/Jitsi
  (`lib/audio-recovery.mjs`): restart paused media elements that play a live
  meeting stream (`srcObject` with a live audio track) and move their
  non-default `setSinkId` outputs back to the default. File-backed media are
  never touched (the step logs how many it left alone): Jitsi keeps its UI
  sounds (ringing in a loop, chimes, reactions) as paused `<audio src>`
  elements. `reload` = bot-runner: close the speaker timeline (`src:"none"`),
  reset `ctx.adapterState`, run `adapter.join(ctx)` (it navigates to
  `joinUrl`; waiting room included) with `ctx.setPhase` wrapped so the phase
  stays `in_meeting` (the join phases become the detail; a waiting room adds
  "впустите «botName»" to the issue message). A reload that cannot get back in
  (BotError) ends the recording with that outcome (`meeting_ended` → ended,
  else failed).
* **Surfaces**: `state.json audioIssue` (§4.2) from detection on
  (`escalated:false` while the ladder runs, `true` after `warn`; `reason`
  `"deaf"` | `"capture"`) → host snapshot → server `warning` column →
  `MeetingSummary.warning` (live card and detail page `MeetingWarning`, CLI
  `show` "Warning:", api `show`/`list` `warning`, `meetings_status`). The
  message's first sentence is the title: «Бот не слышит участников встречи:
  участники говорят, а в записи тишина.» (deaf) or «Бот слышит участников, но
  звук не попадает в запись.» (capture), then what was tried. The requesting
  thread gets one message (`warning_notified_at`, once per meeting) when an
  escalated issue is seen while the meeting is `recording`; the end-of-meeting
  message repeats the warning. events.jsonl has every decision: detection and
  each step (warn, with the evidence: reason, window, speaking time, changes,
  speakers, peak dBFS, track max, track sound time, participants), each step's
  result, the escalation, "Audio recovered after …" (with `by` recording /
  tracks), and log-only notes ("the recording is silent, but nobody is speaking
  / the speaker indicator does not change (sticky) / the bot is alone: not
  deaf", "…the participants' audio tracks carry sound (capture; capture mode is
  log-only)", once per reason and silent stretch). A debug dump
  (`debug/*-deaf.*`, with the guard's state) is taken at detection.
* **Tuning**: `speakerSelectors.deafGuard` (any `DEAF_GUARD_DEFAULTS` key, e.g.
  `{"capture": "log"}`, `{"openMinChanges": 2}` to also require speaker
  changes for the open-episode hold and rejoins; `{"enabled": false}` turns it off). The mock e2e uses a
  10 s window (`deaf-rejoin|reload|forever|silent|capture`; the mock's
  `capture=rejoin|forever` mutes its playback while the tracks keep their
  sound).
* **Validated on real data** (2026-10-27, `signals.jsonl` + decoded `audio.ogg`
  of all 14 recordings: 8 Zoom up to 2 h 11 min, 4 Telemost, the mock, the
  incident), also through the real `BotRunner` sampling loop on a virtual
  clock (PCM reads, silence timer, guard, recovery steps): no action on any
  normal meeting (only the log-only notes); the incident detected at 45 s
  (deaf), rejoin at 293 s, reload at 366 s, warning at 451 s, then audio
  rejoins every 180–189 s from 631 s to 1760 s (59f6a47 skipped the one due at
  1008 s: one participant talked alone from 900 to 1068 s). With the recording
  and the tracks zeroed, `mtg_mvgr928zgps9` (7877 s) and `mtg_mvhxk0ark6pn`
  (4348 s) are detected at 45 s, warn at 565 s and 226 s, rejoin every
  180–189 s to the end (38 and 21 persistent rejoins) and never leave "for
  silence" with a 10, 15 or 30 min timeout; the normal meetings that really go
  silent still leave "for silence" exactly when 59f6a47 did (1 and 2 min
  timeouts), and after a clock step once the timeout's worth of silence was
  observed (59f6a47: at once after an 11 min step forward, only at the
  meeting's end after a 1 h step back). In every 45 s window whose recording was
  digitally silent the tracks were exactly 0, so capture mode never fired, even
  with a track threshold of 0.0001, 0.5 s of sound and a 20 s window.
  Telemost once its outline is read (0.3.1; the outline rebuilt from the
  transcript, 0.8 s late, since the recorded probe never saw it): on the three
  long Telemost recordings the guard saw speaking on 900–1600 samples and took
  no action; with the recording and the tracks zeroed it detected at 51–282 s
  and ran the ladder.
* **Measured on the real web client** (zoom.us/test, 2026-10-27, steps forced
  by a dev probe): the menu item reads "Leave computer audio"; leave + join +
  re-mute took 2–3 s; the reload took 8.5 s and went straight back in without
  the pre-join form (Zoom kept the session; a new participant id); the
  recording ran through all steps. Not measured: a real deaf or capture meeting
  recovering, a waiting room after the reload, a non-default speaker in the
  menu.
* **Known limitation**: a failed Telemost/Meet/Jitsi page probe returns an
  empty sample (nobody speaking, no tracks) instead of an unknown one (Zoom's
  failure throws and reaches the guard as `speakers: null`). It only errs
  toward fewer detections: a dark moment is never a speaker change, and no
  track sound is never capture evidence.

## 7. Server registry (SQLite via `bb.storage.database()`)

See `src/server/db.ts`. Tables `meetings`, `segments`, `segments_fts`
(FTS5, `unicode61 remove_diacritics 2`), `calendar_events`.
Migrations are append-only.

### 7.1 Meeting status (server-level)

`scheduled → starting → joining → waiting_for_host | waiting_room → recording →
processing → done`; side exits `failed`, `cancelled`.

Mapping from runtime: bot `starting|joining` → `joining`; `waiting_*` → same;
`in_meeting|leaving` → `recording`; bot terminal + transcript not final →
`processing`; final transcript written → `done`; bot `failed` with no audio →
`failed`; bot `failed` with audio → `processing`→`done` and the error is kept
as `error_*` for display.

### 7.2 Reconcile loop

Background service `scheduler`: every 2 s while any meeting is in an active
status, else every 15 s:

1. Start due `scheduled` meetings (respect `maxConcurrentBots`).
2. Poll `meeting.status` for active meetings; map to server status; persist;
   publish realtime `meetings.changed` `{id}` on change.
3. Pull new live segments (`meeting.segments` with `afterId`) into the DB
   (`final=0`); when the transcript is final, replace them with the final
   segments (`final=1`) and index FTS; publish `meetings.segments` `{id}`.
4. Respawn a dead transcriber when the bot is terminal and the transcript is
   not final (host `meeting.ensureTranscriber`).
5. On terminal transition: notify the requesting thread (§9).
6. Calendar sync every `calendarSyncMinutes` when configured (§10).

On load: reconcile every non-terminal meeting once; a meeting whose directory
the host no longer has becomes `failed` ("lost").

## 8. Surfaces

### 8.1 CLI `bb meetings …` (defineCli)

`join <url> [--title] [--name] [--at <ISO|HH:MM>] [--max-duration <dur>] [--no-notify] [--wait <dur, default 0>] [--json]`,
`list [--status all|active|upcoming|past|<status>] [--limit 1-200] [--json]`,
`show <id>`, `stop <id>`, `cancel <id>`,
`transcript <id> [--format md|txt|srt|vtt|json] [--from <seg>] [--limit 1-5000]`,
`search <query...> [--limit 1-100]`, `rename-speaker <id> <speakerKey|label> <new name...>`,
`summary <id> [--set <markdown> | --clear]`, `retranscribe <id>`, `delete <id> --yes`,
`doctor`, `setup [--force]`, `logs <id> [--lines 1-1000]`, `screenshot <id>` (prints
the host path of the latest screenshot), `debug-dump <id>` (writes
`debug.request`), `import <path> [--title]`, `calendar` (upcoming events),
`calendar sync`, `calendar skip <key>`, `calendar unskip <key>`, `zoom-login`
(starts a sign-in session; prints the Meetings page link to drive it),
`zoom-logout`, `zoom-status`, `selftest [--timeout <dur>] [--keep]` (mock
meeting: Chrome + PulseAudio + ffmpeg + speaker detection + transcriber, no
Zoom). Every command takes `--json`. `src/server/cli.ts` is the source of truth.


`api --request-stdin --json` is the single JSON entry point for agents outside
bb (src/server/agent-api.ts): one line of JSON `{action, …}` in, `{ok, action,
…}` out; actions list, show, join, stop, cancel, delete (confirm + userRequest),
transcript (paged by segment id), search, summary, save_summary,
rename_speaker, retranscribe, logs, doctor, calendar. Used by agents that drive
the bb CLI from another machine (e.g. an OpenClaw bot).
### 8.2 Agent tools

`meetings_status` shows the deaf-bot warning (§6.8) when there is one.
`meetings_join`, `meetings_status`, `meetings_stop`, `meetings_transcript`,
`meetings_search`, `meetings_save_summary`, `meetings_rename_speaker`.
`meetings_join` records the calling `threadId` (unless `notify: false`) and by
default waits up to 60 s (`waitSeconds` 0–300) for the join outcome so the
agent can tell the user "I'm in" / "admit 'Notetaker' from the waiting room" /
"scheduled" / "still joining" / the failure reason. `meetings_transcript` pages
by `fromSegment` (≈ 60k characters per page) and ends each page with
`[More: … fromSegment N]` or `[End of transcript]`. Nothing prevents a second
bot for the same meeting number; the skill tells agents to check
`meetings_status` first.

### 8.3 Frontend RPC

See `src/shared/rpc-contract.ts` (`rpcContract`). Realtime channels:
`meetings.changed` `{id}`, `meetings.segments` `{id, lastId}`, `meetings.env`
`{}`, `meetings.calendar` `{}` and `meetings.zoom` `{}`.

### 8.4 HTTP routes (auth `local`)

`GET /audio?id=` (audio/ogg, Range/206 support, proxied in ≤ 4 MiB host
reads), `GET /screenshot?id=&v=` (image/jpeg, no-store),
`GET /download?id=&format=md|txt|srt|vtt|json|audio` (attachment; `audio` =
the Opus `audio.ogg`), and the mock meeting page `GET /mock-meeting/*` for the
selftest. Full path: `/api/v1/plugins/meetings/http/<path>`.

### 8.5 Meetings page (navPanel `meetings`, Russian UI)

Root: join form (link, optional title, "сейчас"/scheduled time), live cards
(red pulsing dot, screenshot, elapsed, participants, who is speaking, Stop),
upcoming (scheduled + calendar, skip toggle), history list with status chips
and progress, global transcript search. Environment banner with "Установить
компоненты" when the doctor reports missing pieces; GigaAM status.
Zoom account card (sign in / out, live view of the sign-in session with
remote control). Detail (`subPath = <meetingId>`): editable title, status,
timings, link, error, actions (Stop, Re-transcribe, Download ▾, Delete), live
view (screenshot ~1 fps while open, "Управление" toggle → clicks on the image
and a text/key input are forwarded to the bot), audio player
(seek on timestamp click, current segment highlight, speed), speakers panel
(color, talk share, rename), summary (markdown), transcript grouped by speaker
turns with in-transcript search, auto-scroll while live. `MeetingSummary.warning`
(the deaf-bot guard, §6.8) shows as a warning box on the live card and below the
detail page header.

## 9. Thread notifications

When a meeting reaches `done` or `failed` and `requested_by_thread_id` is set
and `notifyThread` is on, send one message to that thread with
`bb.sdk.threads.send`: title, id, duration, speakers, how to read the
transcript, plus `autoSummaryPrompt` (default asks the agent to save a summary
with `meetings_save_summary`). `notified_at` makes it exactly-once. While a
meeting records, an escalated deaf-bot issue (§6.8) sends one more message
("Встреча … идёт, но с записью проблема" + the warning), exactly once per meeting
(`warning_notified_at`); the end message then repeats the warning. This is
the one path that sends meeting content off the machine without a user
request: the agent reads the transcript, so it goes to the thread's model
provider. Meetings started from the page, a terminal or the calendar have no
thread and are not affected; the user docs explain `notifyThread` /
`autoSummaryPrompt` for agent-started ones.

## 10. Calendar auto-join (optional)

Settings `calendarIcsUrls` (secret; whitespace-separated ICS URLs — Google
"secret address in iCal format", Outlook/Yandex published ICS),
`calendarAutoJoin` (default off), `calendarLeadMinutes` (default 1),
`calendarFilter` (case-insensitive substring of the title, or a regex written
as `/…/flags`; a bare `^a|b` is a substring; empty = all).
Sync fetches feeds, expands recurrences for the next 24 h (ical.js), extracts
Zoom links from URL/LOCATION/DESCRIPTION/conference fields, upserts
`calendar_events`, and creates `scheduled` meetings (source `calendar`) for
events in the window, deduped by `uid + occurrence start`. Cancelled
(STATUS:CANCELLED) or user-skipped occurrences are not joined.

## 11. Settings (`src/server/settings.ts`)

| key | type | default | meaning |
|---|---|---|---|
| botName | string | `Notetaker` | name shown in the meeting |
| maxDurationMinutes | number 5–1440 | 240 | hard stop |
| aloneTimeoutMinutes | number 0.5–60 | 2 | leave when nobody else is left |
| waitingTimeoutMinutes | number 1–240 | 20 | waiting room / host not started |
| maxConcurrentBots | number 1–8 | 2 | parallel recordings |
| chatAnnouncement | string | `` | chat message after joining |
| notifyThread | boolean | true | message the requesting thread when done |
| autoSummaryPrompt | multiline string | Russian prompt | appended to the notification; empty = no request |
| liveTranscription | boolean | true | transcribe during the meeting |
| diarization | select | `ui+acoustic` | `ui+acoustic`, `ui`, `acoustic` |
| speakerLagMs | number 0–5000 | 700 | lag for SpeakerEvents without `lagMs`; shifts the bot's per-signal lags by `speakerLagMs - 700` (per-signal: `speakerSelectors.lagMs`) (§4.3) |
| gigaamUrl | string | `` | empty = auto-discover the gigaam plugin's server |
| keepRawAudio | boolean | false | keep audio.pcm |
| screenshotIntervalSec | number 0–300 | 10 | 0 = only on events |
| silenceTimeoutMinutes | number 0–240 | 30 | leave after this long with no audio at all; 0 = never |
| useZoomAccount | boolean | false | join with the signed-in Zoom profile (`bb meetings zoom-login`) |
| speakerSelectors | multiline JSON | `` | advanced override of `DEFAULT_SELECTORS` (selectors, `store`, `lagMs`, `fusion`) |
| chromePath | string | `` | empty = auto-detect |
| calendarIcsUrls | secret string | — | ICS feeds |
| calendarAutoJoin | boolean | false | |
| calendarLeadMinutes | number 0–30 | 1 | |
| calendarFilter | string | `` | substring or `/regex/` |
| calendarSyncMinutes | number 1–120 | 5 | |

## 12. Testing

* vitest: `meeting-url`, transcript formatting, status mapping, speaker
  attribution helpers, calendar parsing (fixtures incl. RRULE + TZID), server
  RPC/CLI/tools with `createFakePluginHost`.
* Python: `runtime/transcriber/test_transcriber.py` on a synthetic 2-speaker
  Russian dialogue + fake `speakers.jsonl` against the real GigaAM server.
* Bot unit tests: `runtime/bot/lib/*.test.mjs` (`npm run test:bot`), incl. the
  deaf-bot guard (`deaf-guard.test.mjs`: the incident timeline, false-positive
  cases, recovery) and the guard inside the sampler (`deaf-runner.test.mjs`).
  `npm run test:platforms`: page ops in headless Chrome (incl. `audioMenu`
  against a footer with Leave/End next to the audio menu).
* E2E (`scripts/e2e-bot-mock.mjs`, `npm run e2e:bot`): bot-runner +
  transcriber against the mock meeting page served locally; asserts phases,
  audio, speaker names, text; `deaf-rejoin`, `deaf-reload`, `deaf-forever` and
  `deaf-silent` cover the deaf-bot guard (every other scenario asserts it never
  fires). `npm run e2e:server` (`MEETINGS_E2E=1`) runs the
  server end to end.
* Live Zoom probe: join flow against the real Zoom web client up to the
  invalid-meeting error; a real meeting needs a human-provided link.

## 13. Google Calendar over OAuth (auto-join)

A second calendar source next to the ICS feeds (§10); both feed the same
`calendar_events` table and the same `applyAutoJoin` scheduling rules
(lead minutes, filter, skip toggles, reschedule/cancel on change).

* **Credentials.** The user creates an OAuth client (type *Web application*)
  in Google Cloud: Calendar API enabled, consent screen with their own
  account as a test user (or published). Settings `googleClientId` (string)
  and `googleClientSecret` (secret) — editable from the Meetings page
  (`google.saveClient`), the secret never reaches the frontend.
* **Redirect URI** = the bb origin the page runs on + `GOOGLE_CALLBACK_PATH`
  (`/api/v1/plugins/meetings/http/google/callback`). The page passes
  `window.location.origin` to `google.authStart`; the server accepts only
  `https://…` or `http://localhost|127.0.0.1[:port]` origins. The UI shows the
  exact URI to register.
* **Flow.** `google.authStart` → authorization-code flow with PKCE (S256),
  `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`,
  scopes `openid email https://www.googleapis.com/auth/calendar.readonly`,
  a random `state` kept in memory for 15 min with its verifier and
  redirect URI. `GET /google/callback?code&state` (default `local` auth: a
  top-level navigation has no Origin header) validates state, exchanges the
  code at `https://oauth2.googleapis.com/token`, reads the email from
  `https://openidconnect.googleapis.com/v1/userinfo`, stores tokens, selects
  the primary calendar, starts a sync, publishes `meetings.google`, and
  answers a small Russian HTML page ("Google Календарь подключён — можно
  закрыть вкладку" + link back to `/plugins/meetings/meetings`). Errors
  (`error=access_denied`, bad state, token failure) render the same page with
  the reason. Endpoints are injectable for tests (fake Google server).
* **Storage.** Plugin SQLite table `google_auth` (single row: refresh token,
  access token, expiry, email, scope, connected_at) and the selected
  calendar ids. Access tokens are refreshed on demand (60 s skew); an
  `invalid_grant` marks the connection broken (`lastError`: "Доступ к Google
  отозван или истёк — подключите заново"; note Google expires refresh tokens
  after 7 days while the consent screen is in *Testing*). `google.disconnect`
  revokes (`https://oauth2.googleapis.com/revoke`) and deletes tokens, and
  cancels still-scheduled bots that came from Google.
* **Sync** (with the ICS sync, every `calendarSyncMinutes`, and on
  `google.sync`): `users/me/calendarList` (≤ 250) for the picker, then for
  each selected calendar `calendars/{id}/events?singleEvents=true&orderBy=startTime&timeMin&timeMax&maxResults=250`
  over the sync window. Skip `status=cancelled`, `eventType` other than
  `default`, events the user declined (`attendees[].self && responseStatus=="declined"`),
  all-day events. Zoom link from `conferenceData.entryPoints[].uri`, then
  `location`, then `description` (HTML stripped) via `extractMeetingUrls`.
  Occurrence key `gcal:<calendarId>:<eventId>` (singleEvents gives each
  recurrence instance its own id), feed id `gcal:<sha12(calendarId)>`.
  Google rate/5xx errors keep the last known events (no mass cancel).
* **Leaving.** Calendar meetings already leave when the host ends the call,
  when the bot is alone (`aloneTimeoutMinutes`) or silent. In addition,
  their `maxDurationMinutes` is capped at the event length +
  `calendarOvertimeMinutes` (new setting, default 60, 0 = no cap).
* `calendar.status.upcoming` lists events of both sources;
  `google.status.upcomingCount` counts Google ones with a Zoom link.

## 14. Bot name and avatar

* **Name**: the existing `botName` setting, editable on the Meetings page
  (`bot.updateProfile`). Per-join overrides (`meetings_join botName`) still win.
* **Avatar**: an image uploaded on the page (`bot.setAvatar`, PNG/JPEG/WebP
  ≤ 3 MiB) is stored on the recording host by `bot.avatar` as a square PNG
  (`<hostData>/bot/avatar.png`, center-cropped, 512 px). Setting
  `showAvatar` (boolean, default true) turns it on.
* **Rendering**: at `meeting.start`, when `config.avatar` is true and an
  avatar exists, the host renders `<hostData>/bot/render/<sha12(name+avatar)>.mjpeg`
  with ffmpeg: 1280x720, dark background, the avatar as a circle (≈ 320 px)
  centered above the bot name (white, DejaVu/Liberation Sans), ~2 s at 5 fps
  (Chrome loops the file), plus a 1 s silent 48 kHz WAV for the fake mic.
  It sets `config.avatarVideo` to the MJPEG path before writing config.json.
  `bot.avatarPreview` renders the same frame as a JPEG for the page.
* **Bot**: with `avatarVideo` set, Chrome gets
  `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<mjpeg>
  --use-file-for-fake-audio-capture=<silence.wav>` (the fake mic replaces the
  PulseAudio remap source; recording still captures PulseAudio output), the
  preview keeps video ON, and after admission the bot makes sure the camera
  is on (`Start Video`) and the mic stays muted. Without an avatar the camera
  stays off as before. The mock meeting page shows the bot's camera in its tile.

### 13.1 / 14.1 Implementation notes (as built)

* Settings: `showAvatar` (after `botName`), `calendarOvertimeMinutes`
  (after `calendarLeadMinutes`, 0–600, default 60), `googleClientId`,
  `googleClientSecret` (secret). Changing the Client ID while connected
  revokes the token and asks to reconnect.
* Table `google_auth` (migration 9): tokens, expiry, email, scope,
  connected_at, selected and cached calendars, last sync and error.
* RPC `calendar.setAutoJoin {autoJoin}` writes `calendarAutoJoin` (the page
  toggle). CLI: `google [status]`, `google sync`, `google disconnect`, `bot
  [--name] [--show-avatar on|off] [--avatar <path on the bb server>]
  [--clear-avatar]`. The api `calendar` action adds a per-event `source` and a
  `google` summary.
* HTTP: `GET /google/callback`, `GET /bot/avatar-preview?v=` (renders with the
  saved botName; the page appends `&name=` only as a cache-buster).
* An occurrence gets no bot when another scheduled or live bot for the same
  Zoom meeting is within 30 min (same event in two calendars / ICS + Google /
  a manual bot). Deselected or vanished Google calendars cancel their bots.
* Avatar on the bot: with fake devices Chrome lists "Fake Default Audio
  Output" plus extra fake outputs; only "default" reaches PulseAudio, and
  Zoom picks it on a fresh profile (the bot logs Zoom's speaker choice and
  warns otherwise). `silence.wav` is mandatory (the fake mic beeps
  otherwise); the bot derives it from `<dir(dir(avatarVideo))>/silence.wav`,
  else writes `fake-mic.wav` into the meeting dir. Zoom's in-meeting camera
  button reads "stop my video"/"start my video" and is briefly disabled while
  the camera starts; the bot's self-view is mirrored (others see it
  unmirrored). The camera's device label in Zoom is the .mjpeg path.
