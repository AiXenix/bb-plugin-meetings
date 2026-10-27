# Changelog

## 0.3.1 — 2026-10-27

- **Deaf-bot guard.** When the meeting shows people speaking but the bot records digital silence (seen on Zoom on 2026-10-27: computer audio "connected", indicators busy, recording and every WebRTC track exactly zero), the bot notices within ~45 s and recovers by itself: it rejoins the meeting audio twice (Zoom: default speaker, "Leave Computer Audio", Join Audio), then reloads the meeting page and joins again, waiting room included, while ffmpeg keeps recording. Still deaf: a warning «Бот не слышит участников встречи…» with what was tried shows on the live card and the detail page, the requesting thread gets one message, and the audio rejoin repeats every 3 min. The warning clears when sound returns. Silent meetings, sticky indicators (screen share) and a lone bot never trigger it. Every decision is in `events.jsonl`; tuning via `speakerSelectors.deafGuard`.
- `state.json` gains an optional `audioIssue`; `MeetingSummary` an optional `warning`; `bb meetings show`, `meetings_status` and `bb meetings api show/list` include it.
- Mock meeting: `deaf=rejoin|reload|forever`, a Zoom-like "More audio controls" menu, `speaker=other`, `silent=1`, `sticky=<name>`, `loops=N`; e2e scenarios `deaf-rejoin`, `deaf-reload`, `deaf-forever`, `deaf-silent`.
- Deaf-bot guard hardening (review): a sticky indicator that flickers off and on (re-render, screen share) no longer counts as speaker changes; a sub-second burst on a WebRTC track no longer counts as recovered; an escalated episode that relapses warns again but keeps the 3-minute rejoin cadence; the Telemost/Meet/Jitsi media kick only restarts the meeting's live streams, never the page's file-backed UI sounds (Jitsi's ringing and chimes would have been recorded and faked a recovery); an overrunning Zoom audio rejoin is called off instead of clicking on in the background; the recording is measured in full across slow sampler ticks and always on whole samples; Zoom's Russian "Выйти из аудиоконференции" is no longer blocked by the meeting-control filter.
- **Deaf-bot guard: capture mode.** The second way to an empty recording is caught too: the participants' WebRTC tracks carry sound (≥ -40 dBFS for ≥ 10 s of the 45 s window, the bot not alone) while `audio.pcm` stays below -80 dBFS throughout. It needs no speaking indicators, so it also works on Telemost, Meet and Jitsi. Same recovery ladder and warning, with its own text «Бот слышит участников, но звук не попадает в запись…»; such an episode counts as recovered only when the recording has sound again (the tracks had it all along). `audioIssue` gains an optional `reason` (`"deaf"` | `"capture"`). Tuning: `speakerSelectors.deafGuard.capture` (`"act"` default, `"log"`, `"off"`), `captureTrackLevel`, `captureSoundMs`. Replayed on all 14 real recordings: no action on any normal meeting, even with a 100 times lower track threshold, 0.5 s of sound and a 20 s window; the incident is handled exactly as before. Mock meeting `capture=rejoin|forever`, e2e scenario `deaf-capture`.
- Deaf-bot guard fixes carried over from the reviews of the two products sharing the runtime:
  - the silence timeout (default 30 min) no longer sends a deaf bot home while the meeting is visibly talking (the guard's own evidence over the last window), and restarts after every recovery step, so time a reload spent in the waiting room does not count as silence;
  - a failed page sample is passed to the guard as unknown and keeps the last indicators, instead of "nobody speaks";
  - a stop requested just before a recovery step is no longer turned into a page reload or an audio rejoin;
  - the wall clock stepping back (NTP step, VM resume) no longer blinds the guard, the recording measurement and the audio check until it catches up;
  - the media kick logs how many platform sound files it left alone; `bot-runner.mjs` also starts when run through a symlinked runtime path.
- Deaf-bot guard fixes from the independent verification (replayed through the real sampling loop on all 14 recordings):
  - once the bot is known to be deaf, one person talking with a steady indicator is a talking meeting: the silence timeout is held and the warning's audio rejoins go on every 3 min as promised (with the audio zeroed, a 2 h 11 min recording ended "for silence" after 93 min with the 30 min timeout, and the rejoins paused for up to 20 min). The detection, the steps before the warning and a persistent reload (if configured) still need speaker changes, so a sticky indicator never triggers a reload. Tuning: `speakerSelectors.deafGuard.openMinChanges` (default 0);
  - time that was not observed is no silence: a VM resume or the wall clock stepping forward no longer ends a talking meeting on the next quiet read, and a clock stepping back restarts the silence timeout instead of delaying it;
  - after the wall clock steps back, the popup sweep, `signals.jsonl`, the live screenshots, the no-speaker debug dump and the sampler itself no longer stall until the clock catches up, and a recovery no longer logs a negative duration or an `audioIssue.since` in the future.
- **Telemost speakers are detected again.** The current Telemost web client marks a speaking participant by outlining the tile (CSS class `rootStroke_…` on the tile's inner root, set from the server's voice activity while the participant is unmuted), not with the "speaking" class or label the adapter looked for. So no Telemost recording had named speakers, and the deaf-bot guard always saw "nobody is speaking". The adapter now reads the outline (several speakers at once are fine). Also: the default guest name «Гость» counts as a participant; the bot's self view is never a participant, even under a signed-in account's name; a participant whose name is only part of the bot's name is no longer dropped. Telemost's SFU-mixed audio slots still feed the guard's levels (and `signals.jsonl` as `levels`), but no longer the speaker fusion's track-to-name voting, which would name the mixed track after the dominant speaker. Checked against all 13 recorded Telemost DOM dumps (active = the outlined tiles in 13 of 13) and a transcript-based replay of the three long recordings: speakers named on 84–99 % of the speech, no guard action.

## 0.3.0 — 2026-10-14

- Add Google Meet, Yandex Telemost and Jitsi adapters, URL normalization, calendar link discovery and per-platform browser accounts.
- Keep independent recording profiles/audio sinks, preserve signed-in profiles across Zoom retries, and prohibit outgoing screen sharing while retaining the avatar camera and microphone.
- Add compact settings, per-meeting recording/transcription/analysis options, avatar generation and failed-join retry.
- Add five summary templates, custom template editing/copying, exact applied-rule snapshots, structured decisions/tasks/risks/chapters/follow-up, speech metrics and grounded cross-meeting Q&A.
- Use the requesting BB agent by default; optionally configure an OpenAI-compatible analysis API. Model failures never produce a fabricated successful analysis.
- Add portable MCP stdio through the official BB CLI, authenticated stateless HTTP MCP/REST, rotatable personal access tokens and signed completion webhooks with final transcript data and explicit truncation metadata.
- Keep external-agent integrations on the same BB registry through the authenticated CLI and optional transport adapters.
- Cancel pending analysis/delivery on unload or meeting deletion; audio-only completion never waits for ASR.
- Add a compact recording-file import dialog and close speaker attribution at the stop request instead of after browser cleanup.

## 0.2.0 — 2026-10-13

- **Google Calendar over OAuth.** Connect a Google account on the Встречи page, with your own OAuth client (Web application, Calendar API, read-only scope, PKCE), and tick the calendars to watch.
  - The bot joins every event with a Zoom link a minute before it starts and leaves when the call ends.
  - Calendar recordings are capped at the event length + `calendarOvertimeMinutes` (default 60).
  - The calendar handles recurring events, declined, cancelled and all-day events, links from Zoom conferencing, location or description, moved and deleted events, and the same meeting in two calendars.
- **Calendar auto-join toggle** on the page, shared by Google and ICS calendars.
- **Bot name and avatar.**
  - The **Бот** card sets the name participants see.
  - An uploaded avatar turns the bot's camera on: the avatar in a circle with the name, rendered on the recording machine.
  - Settings: `showAvatar`, `googleClientId`, `googleClientSecret`, `calendarOvertimeMinutes`.
- **CLI.** `bb meetings google [sync|disconnect]`, `bb meetings bot`. The `bb meetings api` calendar action now includes Google.

## 0.1.0 — 2026-10-13

First release.

- A notetaker bot joins Zoom meetings from a link through the Zoom web client
  (Google Chrome on Xvfb, silent PulseAudio microphone) and records them
  (Opus archive and live PCM).
- Speaker detection fuses Zoom's own state (active speaker and roster), the lit
  video tile, and per-participant WebRTC audio tracks. After the meeting,
  TitaNet voice embeddings refine the speakers.
- Live transcription with local GigaAM v3 (the `gigaam` plugin) and Silero
  VAD. The final transcript is ready 1–3 minutes after the meeting ends.
- **Встречи** page in bb: join form, live view with remote control for
  captchas and sign-in, audio player, speakers with renaming, transcript with
  search, Markdown summary, and downloads (md, txt, srt, vtt, json, audio).
- `bb meetings` CLI and 7 agent tools. The thread that started a recording
  gets a notification with a summary request when the meeting ends.
- Optional Zoom account sign-in for the bot, ICS calendar auto-join,
  full-text search across all transcripts, and import of existing recordings.
- `bb meetings doctor` / `setup` install the runtime. The per-version runtime
  reinstalls itself automatically after plugin updates.
