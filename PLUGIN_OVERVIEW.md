## What you get

- A **Встречи** page in the sidebar: paste a Zoom link, watch the bot's screen live, read the transcript as it grows, play the recording, rename speakers, search all meetings, and download md, txt, srt, vtt or json.
- `meetings_*` agent tools, so an agent can send the bot from a link, report whether it got in, and write a summary with decisions and action items when the meeting ends.
- A `bb meetings` command for the same work from a terminal, plus `doctor`, `setup` and `selftest`.
- Optional auto-join for every Zoom meeting in a Google, Outlook or Yandex calendar (secret ICS address).

## How it works

A bot runs Google Chrome on a virtual display and joins through the Zoom web client, with no Zoom API keys. ffmpeg records what the bot hears, and GigaAM v3 transcribes it on your machine while the meeting runs. Speakers are named from Zoom's own signals (the active speaker, the highlighted tile, per-participant audio tracks) and from voice clustering.

Audio and recognition never leave the machine. Transcripts do reach your AI model provider whenever an agent reads them. By default this happens after every meeting started from an agent thread, because the agent is asked to summarize it. Turn off `notifyThread` to keep everything local.

## Requirements

Linux (x86-64 or arm64) with Google Chrome, Xvfb, PulseAudio and ffmpeg; `bb meetings setup` installs the rest. Speech recognition needs the `gigaam` plugin or another OpenAI-compatible transcription server. Russian only.
