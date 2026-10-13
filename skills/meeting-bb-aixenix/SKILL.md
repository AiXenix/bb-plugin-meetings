---
name: meeting-bb-aixenix
description: Russian speech in bb by AiXenix — GigaAM v3 voice input (bb gigaam) and the Meetings Zoom notetaker (bb meetings, meetings_* tools) that records Zoom calls and transcribes them locally, split by speaker. Use when the user shares a Zoom link or asks to record, stop, list or delete meetings, read or search transcripts, summarize a meeting, rename speakers, or check, configure or troubleshoot GigaAM voice input or the meeting recorder.
---

# Meeting BB (AiXenix): GigaAM voice input + Meetings notetaker

Two bb plugins work together, both on the user's own machine:

- **`gigaam`** installs GigaAM v3 (Sber's open Russian speech model) and runs
  it as a loopback HTTP server. It powers bb's microphone (voice input) and
  every meeting transcript.
- **`meetings`** sends a bot (`Notetaker`, setting `botName`) into Zoom
  meetings through the Zoom web client. The bot records the meeting and tracks
  who is speaking. Each recording is transcribed with GigaAM while the meeting
  runs. When the meeting ends, speakers are refined with voice embeddings. All
  meetings are on the **Встречи** page in bb's sidebar.

Both are Russian-only. Audio and transcripts stay on the machine. Anything you
read with these tools goes to your model provider.

## 1. Meetings

### Tools

- `meetings_join`: record a Zoom meeting now or at `startAt` (`HH:MM` server
  time, or ISO 8601 with an offset).
  - Pass `url` exactly as given, keeping `?pwd=…`; a meeting number also works.
  - Optional: `title`, `botName`, `maxDurationMinutes`, `waitSeconds` (0–300,
    default 60), `notify` (default true: this thread gets a message when the
    meeting ends).
  - It waits for the outcome and returns the meeting id, the status and what
    to tell the user.
- `meetings_status`: overview of active, upcoming and recent meetings, or one
  meeting by id (participants, who is speaking, speakers, transcript progress,
  errors).
- `meetings_stop`: the bot leaves. The final transcript is ready 1–3 minutes
  later.
- `meetings_transcript`: the transcript as `[hh:mm:ss] Speaker: text`, about 60k
  characters per page.
  - While a page ends with `[More: … fromSegment N]`, call again with that
    `fromSegment`. The last page ends with `[End of transcript]`.
  - During a meeting the text is live and not final.
- `meetings_search`: full-text search over all transcripts.
- `meetings_save_summary`: store a Markdown summary on the meeting card.
- `meetings_rename_speaker`: `Спикер 2` → a real name across one meeting.

Everything else is in the CLI (`bb meetings --help`): `list`, `show`, `cancel`,
`delete <id> --yes`, `retranscribe`, `logs`, `screenshot`, `import <file>`,
`calendar`, `google`, `bot`, `zoom-login`, `doctor`, `setup`, `selftest`.

### Calendar auto-join and the bot's look

- **Google Calendar** is connected with the user's own OAuth client: Client ID
  and Secret pasted in the **Google Календарь** card on the Встречи page, then
  "Подключить Google Календарь". The user does this in the browser; you cannot.
  - `bb meetings google` shows the connection, the watched calendars, the last
    sync and errors.
  - `bb meetings google sync` re-reads now; `bb meetings google disconnect`
    revokes access.
  - "Доступ к Google отозван или истёк": the consent screen is in *Testing*
    (7-day tokens). The user must reconnect, or publish the app in Google Cloud.
- ICS feeds work as before (`calendarIcsUrls`).
- **What auto-join does.** With `calendarAutoJoin` on (a toggle on the page),
  every event with a Zoom link gets a scheduled bot `calendarLeadMinutes`
  early. The bot leaves when the call ends. Calendar recordings are capped at
  the event length + `calendarOvertimeMinutes`.
- `bb meetings calendar` lists the events; skip one with
  `bb meetings calendar skip <key>`.
- **Bot name and avatar**: `bb meetings bot` shows them.
  - `bb meetings bot --name "…"` renames the bot (or use the Бот card).
  - The avatar is uploaded on the page. The bot then shows it as its camera,
    with the name under it (`showAvatar`).
  - A per-meeting name goes to `meetings_join botName`.

### Workflow

1. **The user shares a Zoom link to record.** Call `meetings_join`. Only one
   bot is allowed per meeting: if the meeting already has a live bot or a
   schedule within ±30 min, the call fails and names the existing id; report
   that meeting instead. Tell the user the outcome in their language:
   - `recording`: the bot is in the meeting.
   - `waiting_room`: ask the host to admit the bot by its name.
   - `waiting_for_host`: the meeting has not started; the bot keeps retrying
     until `waitingTimeoutMinutes`.
   - `scheduled`: the bot will join at the time (server time).
   - `starting` / `joining`: the join is still in progress. Check once later
     with `meetings_status`; do not loop.
   - `failed`: explain the error code (table below).
2. **Do not poll.** When the meeting ends, the thread that started it gets a
   message, usually with a request to summarize. A meeting with no recognized
   speech says so and asks for nothing.
3. **Summary.** Read the whole transcript page by page. Write in the
   transcript's language, briefly:
   - decisions;
   - action items (what, owner, deadline, when they were said);
   - open questions and risks.

   Invent nothing. Then call `meetings_save_summary` and give the user a short
   recap.
4. **Speaker names.** `Спикер N` and `Неизвестный` are speakers Zoom did not
   show. When the context makes clear who they are, offer
   `meetings_rename_speaker`.
5. **Deleting** (`bb meetings delete <id> --yes`) removes the recording,
   transcript and summary for good. Delete only when the user explicitly asks
   for that meeting.

### Error codes

| code | what to tell the user |
|---|---|
| `invalid_meeting` | Zoom says the link is invalid, or the meeting never started before the timeout |
| `wrong_passcode` | the passcode is wrong; ask for the full invite link |
| `waiting_timeout` | nobody admitted the bot or started the meeting in time |
| `auth_required` | only signed-in Zoom users may join; sign the bot in on the Встречи page («Войти в Zoom», or `bb meetings zoom-login`) and set `useZoomAccount` |
| `bot_blocked` | Zoom's bot protection refused the guest; sign the bot in (as above) or retry |
| `captcha` | a captcha needs a human: open the meeting's live view on the Встречи page and use «Управление» |
| `registration_required` | a webinar registration page; the user must register and share their personal join link |
| `browser_join_disabled` | the host disabled joining from a browser; this cannot be bypassed |
| `denied`, `meeting_locked`, `meeting_full`, `meeting_ended` | the host refused, locked or ended the meeting, or it is full |
| `dependency_missing` | `bb meetings doctor`, then `bb meetings setup` |

### Limits

- Default maximum recording length is 4 h (`maxDurationMinutes`, up to 24 h).
  Zoom itself ends free-plan meetings after 40 minutes.
- `maxConcurrentBots` (default 2) parallel recordings.
- The bot leaves when the host ends the meeting, when it is alone for 2 min,
  or after 30 min of silence (`aloneTimeoutMinutes`, `silenceTimeoutMinutes`).
- The bot is visible to every participant; participants should know they are
  being recorded.

## 2. Voice input (GigaAM)

```sh
bb gigaam status            # installing | starting | ready | failed | unsupported
bb gigaam logs --lines 80   # install.log and server.log
bb gigaam restart           # reload the model; poll status until ready
bb gigaam reinstall         # rebuild the Python environment (minutes)
bb settings ai-services set voice gigaam
bb voice transcribe <audio-file>
```

Settings (`bb plugin config gigaam set <key> <value>`):

- `model`: `v3_e2e_rnnt` (default, punctuated), `v3_e2e_ctc` (faster), or
  `v3_rnnt` / `v3_ctc` (no punctuation). A new model downloads about 450 MB.
- `threads`: `0` means half the cores, at most 8.
- `serverUrl`: use an external OpenAI-compatible `/v1/audio/transcriptions`
  server instead of the managed install.

Voice recordings must be 20 MB or smaller; audio over 20 s is split at pauses.
A minute of speech takes about 7 s of CPU. Requires Linux x64/arm64 or macOS on
Apple silicon, about 2 GB of disk and 1.5 GB of RAM.

## 3. Agents outside bb

A bot that drives the bb CLI from another machine (for example an OpenClaw
agent in Telegram) uses one JSON line per call:

```sh
echo '{"action":"list","filter":"past","limit":5}' | bb meetings api --request-stdin --json
```

Actions: `list`, `show`, `join`, `stop`, `cancel`, `delete`, `transcript`,
`search`, `summary`, `save_summary`, `rename_speaker`, `retranscribe`, `logs`,
`doctor`, `calendar`.

- `delete` needs `"confirm": true` and `"userRequest"` (the user's own words).
- `transcript` returns `nextFromSegment` until it is `null`.
- Passcodes are masked in every answer.
- Errors exit 1 with `{"ok":false,"error":{code,message,hint}}`.

## 4. Troubleshooting

| symptom | check |
|---|---|
| the bot cannot join | `bb meetings show <id>`, `bb meetings logs <id>`, `bb meetings screenshot <id>` (read the image), the live view on the Встречи page |
| transcript stuck on «Ожидание GigaAM» | `bb gigaam status`; `bb gigaam restart`; the transcriber resumes by itself |
| silent recording | `bb meetings doctor` (PulseAudio), the screenshot (an unjoined audio dialog?) |
| `Спикер N` everywhere | Zoom did not expose speakers (screen share, layout change); rename speakers; send a «Снимок DOM» to the developer |
| microphone missing in bb | `bb gigaam status` must be `ready`; `bb settings ai-services show` |

Logs: `bb plugin logs meetings`, `bb plugin logs gigaam`. Full Russian guide:
`docs/guide.ru.md` in https://github.com/AiXenix/bb-plugin-meetings. GigaAM:
https://github.com/AiXenix/bb-plugin-gigaam.
