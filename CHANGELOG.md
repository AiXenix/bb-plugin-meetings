# Changelog

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
