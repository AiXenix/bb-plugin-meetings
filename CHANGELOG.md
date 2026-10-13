# Changelog

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
