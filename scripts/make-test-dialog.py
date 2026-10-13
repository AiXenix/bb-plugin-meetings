"""Test fixtures for the meetings transcriber and the mock meeting page.

Generates a 3-speaker Russian meeting dialogue with Piper VITS voices
(sherpa-onnx OfflineTts) and builds synthetic meeting directories from it.

    python -I scripts/make-test-dialog.py dialog  [--out .e2e/fixtures] [--tts-dir .e2e/models/tts]
    python -I scripts/make-test-dialog.py mock-script [--out .e2e/fixtures]   (rewrite it from gt.json)
    python -I scripts/make-test-dialog.py meeting --out DIR [--fixtures .e2e/fixtures]
              [--lag-ms 800] [--jitter-ms 200] [--dropout 0.1] [--lag-field]
              [--style track|sticky] [--audio pcm|ogg|both] [--diarization ui+acoustic]

`dialog` writes into --out:
  dialog.wav         16 kHz mono s16, the whole conversation with light noise
  gt.json            [{speaker, start, end, text}] ground truth, seconds
  clips/NN.wav       each utterance alone (16 kHz mono s16, trimmed, no noise)
  mock-script.json   [{speaker, clip, gapSec}] for the mock meeting page
                     (runtime/mock-meeting): the first clip starts at the page's
                     start delay; gapSec = silence after this clip before the next
                     one starts; negative = the next clip overlaps this one

`meeting` writes a meeting directory (config.json, state.json, speakers.jsonl,
audio.pcm and/or audio.ogg) whose speaker events are derived from gt.json with
a configurable indicator lag, jitter and dropout. The test suite imports this
module and calls make_meeting_dir() directly.
"""

import argparse
import json
import os
import random
import string
import subprocess
import sys
import time
import wave

import numpy as np

SR = 16000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIXTURES = os.path.join(ROOT, ".e2e", "fixtures")
DEFAULT_TTS_DIR = os.path.join(ROOT, ".e2e", "models", "tts")

# Display name -> (Piper voice, speed, peak level).
VOICES = {
    "Олег Петров": ("ruslan", 0.95, 0.80),
    "Анна Смирнова": ("irina", 1.05, 0.70),
    "Дмитрий Волков": ("denis", 1.0, 0.75),
}

DIALOG = [
    ("Олег Петров", "Добрый день, коллеги. Давайте начнём нашу встречу по запуску нового сервиса."),
    ("Анна Смирнова", "Здравствуйте. Я коротко расскажу, что мы успели сделать за последнюю неделю."),
    ("Дмитрий Волков", "Отлично. А как обстоят дела с нагрузочным тестированием?"),
    ("Анна Смирнова", "Тестирование почти завершено, но сервер иногда отвечает слишком медленно."),
    ("Олег Петров", "Понятно. Дмитрий, твоя команда сможет посмотреть на эту проблему?"),
    ("Дмитрий Волков", "Да, конечно. Думаю, нам понадобится пара дней, чтобы найти причину."),
    ("Анна Смирнова", "Я могу прислать вам подробный отчёт сегодня вечером."),
    ("Дмитрий Волков", "Спасибо, это очень поможет."),
    ("Олег Петров", "Хорошо. Тогда следующий вопрос: нам нужно согласовать дату релиза."),
    ("Анна Смирнова", "Предлагаю перенести релиз на конец месяца, чтобы спокойно всё проверить."),
    ("Дмитрий Волков", "Согласен, так будет надёжнее."),
    ("Олег Петров", "Договорились. Всем спасибо, увидимся на следующей неделе."),
]

LEAD_IN_S = 1.0
TAIL_S = 1.0
# Gap before utterances 2..12. Short gaps (< 0.4 s) make Silero merge turns, so
# the transcriber has to split them on the UI speaker change; -0.4 is an overlap.
GAPS_S = [0.6, 0.25, 0.9, 0.2, 1.1, 0.7, -0.4, 0.5, 0.3, 1.2, 0.8]
NOISE_STD = 0.0018  # about -55 dBFS


# ----------------------------------------------------------------------------- audio helpers


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path}: expected 16 kHz mono s16 WAV")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def to_s16(x):
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def write_wav(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(to_s16(x))


def resample_to_16k(x, sr):
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
         "-ar", str(SR), "-f", "s16le", "pipe:1"],
        input=to_s16(x), capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype="<i2").astype(np.float32) / 32768.0


# ----------------------------------------------------------------------------- dialog


def load_tts(tts_dir, voice):
    import sherpa_onnx

    d = os.path.join(tts_dir, f"vits-piper-ru_RU-{voice}-medium-int8")
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=os.path.join(d, f"ru_RU-{voice}-medium.onnx"),
                tokens=os.path.join(d, "tokens.txt"),
                data_dir=os.path.join(d, "espeak-ng-data")),
            num_threads=4),
        max_num_sentences=1)
    if not cfg.validate():
        raise RuntimeError(f"invalid TTS config for voice {voice} in {d}")
    return sherpa_onnx.OfflineTts(cfg)


def synthesize(tts, text, speed, peak):
    audio = tts.generate(text, sid=0, speed=speed)
    x = resample_to_16k(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)
    nz = np.flatnonzero(np.abs(x) > 0.01)
    x = x[nz[0]:nz[-1] + 1]
    return (peak * x / np.abs(x).max()).astype(np.float32)


def make_dialog(out_dir, tts_dir):
    os.makedirs(os.path.join(out_dir, "clips"), exist_ok=True)
    tts = {name: load_tts(tts_dir, voice) for name, (voice, _, _) in VOICES.items()}
    clips = []
    for i, (name, text) in enumerate(DIALOG, 1):
        _, speed, peak = VOICES[name]
        x = synthesize(tts[name], text, speed, peak)
        rel = f"clips/{i:02d}.wav"
        write_wav(os.path.join(out_dir, rel), x)
        clips.append((name, text, rel, x))
        print(f"  {rel} {name:16s} {len(x) / SR:5.2f}s {text}")

    gaps = [LEAD_IN_S] + GAPS_S
    starts, t = [], 0
    for (_, _, _, x), gap in zip(clips, gaps):
        start = max(0, t + int(round(gap * SR)))
        starts.append(start)
        t = start + len(x)
    total = max(s + len(c[3]) for s, c in zip(starts, clips)) + int(TAIL_S * SR)
    y = np.zeros(total, dtype=np.float32)
    gt = []
    for (name, text, _, x), start in zip(clips, starts):
        y[start:start + len(x)] += x
        gt.append({"speaker": name, "start": round(start / SR, 3),
                   "end": round((start + len(x)) / SR, 3), "text": text})
    y += np.random.default_rng(0).normal(0, NOISE_STD, size=y.shape).astype(np.float32)
    write_wav(os.path.join(out_dir, "dialog.wav"), y)
    with open(os.path.join(out_dir, "gt.json"), "w", encoding="utf-8") as f:
        json.dump(gt, f, ensure_ascii=False, indent=2)
    write_mock_script(out_dir, gt)
    print(f"wrote {out_dir}: dialog.wav {total / SR:.2f}s, {len(gt)} utterances")


def write_mock_script(out_dir, gt):
    """mock-script.json for the mock meeting page, with the same gaps and overlap as dialog.wav."""
    script = []
    for i, g in enumerate(gt):
        gap = round(gt[i + 1]["start"] - g["end"], 3) if i + 1 < len(gt) else TAIL_S
        script.append({"speaker": g["speaker"], "clip": f"clips/{i + 1:02d}.wav", "gapSec": gap})
    with open(os.path.join(out_dir, "mock-script.json"), "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)


# ----------------------------------------------------------------------------- meeting dirs


def load_gt(fixtures=DEFAULT_FIXTURES):
    with open(os.path.join(fixtures, "gt.json"), encoding="utf-8") as f:
        return json.load(f)


def new_meeting_id(rng=None):
    rng = rng or random.Random()
    return "mtg_" + "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(12))


def speaker_events(gt, *, rec_start_ms, lag_ms=0, jitter_ms=0, dropout=0.0, lag_field=False,
                   style="track", seed=1):
    """SpeakerEvent lines as the bot would write them for the ground truth.

    style "track": exact per-person on/off (sets may overlap, [] in pauses);
    style "sticky": one dominant speaker that stays lit until someone else talks (Zoom tile).
    Each true change at audio time x is observed at rec_start + x + lag + jitter.
    """
    rng = random.Random(seed)
    changes = []  # (audio_sec, speakers)
    if style == "sticky":
        for g in sorted(gt, key=lambda g: g["start"]):
            changes.append((g["start"], [g["speaker"]]))
    elif style == "track":
        marks = sorted([(g["start"], 1, g["speaker"]) for g in gt] + [(g["end"], 0, g["speaker"]) for g in gt])
        active = []
        for t, kind, name in marks:
            if kind == 1 and name not in active:
                active.append(name)
            elif kind == 0 and name in active:
                active.remove(name)
            if changes and abs(changes[-1][0] - t) < 1e-6:
                changes[-1] = (t, list(active))
            else:
                changes.append((t, list(active)))
    else:
        raise ValueError(f"unknown style {style!r}")
    events = []
    for t, names in changes:
        if dropout > 0 and rng.random() < dropout:
            continue
        jitter = rng.uniform(-jitter_ms, jitter_ms) if jitter_ms else 0.0
        ev = {"t": int(round(rec_start_ms + t * 1000 + lag_ms + jitter)), "speakers": names,
              "src": "track" if style == "track" else "tile"}
        if lag_field:
            ev["lagMs"] = lag_ms
        events.append(ev)
    events.sort(key=lambda e: e["t"])
    return events


def bot_config(meeting_id, transcriber=None):
    cfg = {
        "version": 1, "meetingId": meeting_id, "mode": "meeting", "platform": "mock",
        "url": "http://127.0.0.1:9/mock-meeting", "joinUrl": "http://127.0.0.1:9/mock-meeting",
        "meetingNumber": None, "passcode": None, "botName": "Notetaker",
        "maxDurationSec": 3600, "aloneTimeoutSec": 120, "waitingTimeoutSec": 600,
        "silenceTimeoutSec": 0, "screenshotIntervalSec": 10, "chatAnnouncement": "",
        "speakerSelectors": None, "chromePath": "/usr/bin/google-chrome-stable",
        "zoomProfileDir": None, "liveTranscription": True,
        "transcriber": {"gigaamUrl": None, "diarization": "ui+acoustic", "speakerLagMs": 700,
                        "keepRawAudio": False, "threads": 0},
        "createdAt": int(time.time() * 1000),
    }
    cfg["transcriber"].update(transcriber or {})
    return cfg


def bot_state(meeting_id, *, phase="ended", pid=0, rec_start_ms=None, audio_sec=0.0, names=()):
    now = int(time.time() * 1000)
    terminal = phase in ("ended", "failed")
    return {
        "version": 1, "meetingId": meeting_id, "pid": pid, "phase": phase, "detail": f"synthetic {phase}",
        "startedAt": (rec_start_ms or now) - 5000, "joinedAt": rec_start_ms, "recordingStartedAt": rec_start_ms,
        "endedAt": now if terminal else None, "endReason": "meeting_ended" if phase == "ended" else None,
        "error": None, "participants": {"count": len(names) + 1, "names": list(names)},
        "activeSpeakers": [], "audio": {"seconds": round(audio_sec, 3), "bytes": int(audio_sec * SR * 2)},
        "updatedAt": now,
    }


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def encode_ogg(pcm_path, ogg_path):
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", pcm_path,
         "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ogg_path],
        check=True)


def make_meeting_dir(out_dir, fixtures=DEFAULT_FIXTURES, *, meeting_id=None, lag_ms=0, jitter_ms=0,
                     dropout=0.0, lag_field=False, style="track", audio="pcm", rec_start_ms=None,
                     transcriber=None, phase="ended", pid=0, events=True, seed=1):
    """Create a complete (already recorded) meeting directory. Returns (dir, meeting_id, gt)."""
    gt = load_gt(fixtures)
    meeting_id = meeting_id or new_meeting_id(random.Random(seed))
    os.makedirs(out_dir, exist_ok=True)
    rec_start_ms = rec_start_ms if rec_start_ms is not None else int(time.time() * 1000) - 600_000
    x = read_wav(os.path.join(fixtures, "dialog.wav"))
    pcm_path = os.path.join(out_dir, "audio.pcm")
    with open(pcm_path, "wb") as f:
        f.write(to_s16(x))
    if audio in ("ogg", "both"):
        encode_ogg(pcm_path, os.path.join(out_dir, "audio.ogg"))
    if audio == "ogg":
        os.remove(pcm_path)
    write_json(os.path.join(out_dir, "config.json"), bot_config(meeting_id, transcriber))
    names = sorted({g["speaker"] for g in gt})
    write_json(os.path.join(out_dir, "state.json"),
               bot_state(meeting_id, phase=phase, pid=pid, rec_start_ms=rec_start_ms,
                         audio_sec=len(x) / SR, names=names))
    if events:
        with open(os.path.join(out_dir, "speakers.jsonl"), "w", encoding="utf-8") as f:
            for ev in speaker_events(gt, rec_start_ms=rec_start_ms, lag_ms=lag_ms, jitter_ms=jitter_ms,
                                     dropout=dropout, lag_field=lag_field, style=style, seed=seed):
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return out_dir, meeting_id, gt


# ----------------------------------------------------------------------------- CLI


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dialog", help="synthesize dialog.wav, gt.json, clips/, mock-script.json")
    d.add_argument("--out", default=DEFAULT_FIXTURES)
    d.add_argument("--tts-dir", default=DEFAULT_TTS_DIR)
    ms = sub.add_parser("mock-script", help="rewrite mock-script.json from gt.json")
    ms.add_argument("--out", default=DEFAULT_FIXTURES)
    m = sub.add_parser("meeting", help="build a recorded meeting directory from the fixtures")
    m.add_argument("--out", required=True)
    m.add_argument("--fixtures", default=DEFAULT_FIXTURES)
    m.add_argument("--meeting-id", default=None)
    m.add_argument("--lag-ms", type=float, default=0)
    m.add_argument("--jitter-ms", type=float, default=0)
    m.add_argument("--dropout", type=float, default=0.0)
    m.add_argument("--lag-field", action="store_true", help="write lagMs into every event")
    m.add_argument("--style", choices=["track", "sticky"], default="track")
    m.add_argument("--audio", choices=["pcm", "ogg", "both"], default="pcm")
    m.add_argument("--no-events", action="store_true", help="do not write speakers.jsonl")
    m.add_argument("--diarization", choices=["ui+acoustic", "ui", "acoustic"], default="ui+acoustic")
    m.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    if a.cmd == "dialog":
        make_dialog(a.out, a.tts_dir)
    elif a.cmd == "mock-script":
        write_mock_script(a.out, load_gt(a.out))
        print(f"wrote {os.path.join(a.out, 'mock-script.json')}")
    else:
        out, mid, _ = make_meeting_dir(
            a.out, a.fixtures, meeting_id=a.meeting_id, lag_ms=a.lag_ms, jitter_ms=a.jitter_ms,
            dropout=a.dropout, lag_field=a.lag_field, style=a.style, audio=a.audio,
            transcriber={"diarization": a.diarization}, events=not a.no_events, seed=a.seed)
        print(f"wrote {out} ({mid})")


if __name__ == "__main__":
    sys.exit(main())
