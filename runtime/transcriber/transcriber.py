"""Meeting transcriber for bb-plugin-meetings (docs/dev/DESIGN.md §4.4-§4.6, §5).

Reads a meeting directory written by the bot runner, splits speech with Silero
VAD (sherpa-onnx), transcribes every piece with the local GigaAM server,
attributes speakers from the bot's speakers.jsonl and, once the meeting is
over, refines them with acoustic speaker embeddings + clustering.

    python -I transcriber.py --meeting-dir D --mode live|offline --models-dir M
                             [--gigaam-url U] [--host-data H] [--threads N]

live     tail the growing audio.pcm while the bot records; finalize when the
         bot is gone and the audio stopped growing. Resumes from the
         transcriber.json checkpoint after a restart. When the bot ends
         without recording anything, no transcript is written and
         transcriber.json is removed.
offline  transcribe from scratch (re-transcription, imported files): the
         complete audio.pcm if there is one, else audio.ogg decoded into
         audio.decoded.pcm (deleted afterwards).

Only the standard library, numpy and sherpa_onnx are used. Without sherpa_onnx
(or with MEETINGS_DISABLE_SHERPA=1) it falls back to an energy VAD and
UI-only speakers; without the speaker model, to UI-only speakers.
"""

import argparse
import base64
import bisect
import collections
import fcntl
import http.client
import io
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SAMPLE_RATE = 16000
VAD_MODEL_FILE = "silero_vad_v5.onnx"
SPEAKER_MODEL_FILE = "nemo_en_titanet_small.onnx"

# Silero VAD (research-sherpa.md: v5, threshold 0.4, min silence 0.4 s).
VAD_WINDOW = 512  # feed exactly one window per accept_waveform call (gotcha #1)
VAD_THRESHOLD = 0.4
VAD_MIN_SILENCE_S = 0.4
VAD_MIN_SPEECH_S = 0.25
VAD_MAX_SPEECH_S = 15.0  # soft: Silero cuts at the next short dip after this
VAD_BUFFER_S = 60
FORCE_FLUSH_S = 45.0  # emergency flush when "speech" never ends (music, noise)
HARD_MAX_PIECE_S = 20.0  # longer pieces are cut at the quietest frame
FRAME = SAMPLE_RATE // 100  # 10 ms energy frame

# Energy VAD fallback (no sherpa_onnx).
ENERGY_MARGIN_DB = 12.0
ENERGY_MIN_DB = -50.0
ENERGY_ONSET_FRAMES = 3
ENERGY_PAD_FRAMES = 3
ENERGY_FLOOR_WINDOW_S = 20.0
ENERGY_MAX_SEGMENT_S = 30.0

# Reading audio.pcm.
CHUNK_SAMPLES = 16 * VAD_WINDOW  # ~0.5 s, whole windows
READ_MAX_SAMPLES = 10 * SAMPLE_RATE
POLL_S = 0.5
AUDIO_IDLE_EXIT_S = 3.0
NO_BOT_STATE_GRACE_S = 120.0
STATE_MIN_INTERVAL_S = 1.0
RESUME_SILENCE_MARGIN_S = 1.0  # a Silero segment starts at most ~0.3 s before it is detected
TIMELINE_KEEP_S = 120.0

# Speaker attribution.
DEFAULT_SPEAKER_LAG_MS = 700
MIN_SPLIT_PIECE_S = 1.2
SPLIT_SEARCH_S = 0.3
# The cut for a UI speaker change is searched mostly BEFORE the reported change:
# signals report a turn late (soft onsets, debounce), almost never early.
SPLIT_SEARCH_BEFORE_S = 0.6
SPLIT_SEARCH_AFTER_S = 0.3
UI_CONFIDENT_COVERAGE = 0.6
IMPURE_SHARE = 0.3

# Speaker embeddings + clustering.
MIN_EMBED_S = 1.0
EMBED_WINDOW_S = 3.0
# Voice change detection inside a VAD segment when the UI cannot split it:
# cosine of the 1.5 s windows left/right of each 0.5 s grid point.
CHANGE_WINDOW_S = 1.5
CHANGE_HOP_S = 0.5
CHANGE_MAX_SIM = 0.3
CHANGE_SEARCH_MAX_S = 0.5
DEFAULT_CLUSTER_THRESHOLD = 0.6
MAX_CLUSTER_ITEMS = 4000

# GigaAM HTTP.
ASR_TIMEOUT_S = 120
BACKOFF_MIN_S = 1.0
BACKOFF_MAX_S = 30.0
RETRYABLE_4XX = (404, 405, 408, 409, 425, 429)
UNAVAILABLE_5XX = (502, 503, 504)  # (re)starting or behind a proxy: wait, as for a refused connection
# Any other 4xx/5xx may be this piece's fault or the server's (auth, wrong API,
# broken model). A second of silence tells them apart: when the server
# transcribes it, the piece is skipped (a 5xx only after this many tries);
# otherwise transcription waits for the server, never dropping audio.
PIECE_5XX_TRIES = 5
PROBE_S = 1.0

# Renderings.
TURN_MERGE_GAP_S = 2.0
UNKNOWN_KEY = "unknown"
UNKNOWN_LABEL = "Неизвестный"
MAX_NAME_LEN = 290

DIARIZATION_MODES = ("ui+acoustic", "ui", "acoustic")
TERMINAL_BOT_PHASES = ("ended", "failed")


class Stopped(Exception):
    """SIGTERM/SIGINT: save state and exit 0 so a later run can resume."""


# ----------------------------------------------------------------------------- small helpers


def log(msg):
    try:
        sys.stdout.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass


def now_ms():
    return int(time.time() * 1000)


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def write_text_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def write_json_atomic(path, obj):
    write_text_atomic(path, json.dumps(obj, ensure_ascii=False))


def read_json(path):
    try:
        with open(path, "rb") as f:
            obj = json.loads(f.read())
    except (OSError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def iter_jsonl(path):
    """Objects from a JSONL file; skips blank, partial and malformed lines."""
    try:
        f = open(path, "rb")
    except OSError:
        return
    with f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if isinstance(obj, dict):
                yield obj


def append_jsonl(path, obj):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def fmt_hms(sec):
    s = int(max(0.0, sec))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def clean_name(name):
    return " ".join(str(name).split())[:MAX_NAME_LEN]


# ----------------------------------------------------------------------------- audio helpers


def pcm_to_float(buf):
    return np.frombuffer(buf, dtype="<i2").astype(np.float32) / 32768.0


def wav_bytes(x):
    """In-memory 16 kHz mono 16-bit WAV."""
    pcm = np.clip(np.round(np.asarray(x, dtype=np.float64) * 32768.0), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def frame_energy(x, smooth_frames=1):
    n = len(x) // FRAME
    if n == 0:
        return np.zeros(0)
    e = np.square(x[: n * FRAME].astype(np.float64)).reshape(n, FRAME).mean(axis=1)
    if smooth_frames > 1 and n >= smooth_frames:
        e = np.convolve(e, np.ones(smooth_frames) / smooth_frames, mode="same")
    return e


def quietest_sample(energy, lo, hi):
    """Centre of the lowest-energy 10 ms frame between samples lo and hi."""
    lo_f, hi_f = max(0, lo // FRAME), min(len(energy), max(lo // FRAME + 1, hi // FRAME))
    if lo_f >= hi_f:
        return (lo + hi) // 2
    k = lo_f + int(np.argmin(energy[lo_f:hi_f]))
    return min(max(k * FRAME + FRAME // 2, lo), hi)


def hard_cut(start, x, max_s=HARD_MAX_PIECE_S):
    """Cut pieces longer than max_s at the quietest point of their second half."""
    max_len = int(max_s * SAMPLE_RATE)
    if len(x) <= max_len:
        return [(start, x)]
    energy = frame_energy(x, smooth_frames=21)
    pieces, a = [], 0
    while len(x) - a > max_len:
        # Leave at least 1 s for the next piece so no sliver is left at the end.
        cut = quietest_sample(energy, a + max_len // 2, min(a + max_len, len(x) - SAMPLE_RATE))
        pieces.append((start + a, x[a:cut]))
        a = cut
    pieces.append((start + a, x[a:]))
    return pieces


class PcmSource:
    """Reads s16le 16 kHz mono audio.pcm from a sample position (the file may still grow)."""

    def __init__(self, path, start_sample):
        self.path = path
        self.pos = start_sample * 2

    def size(self):
        try:
            return os.stat(self.path).st_size
        except FileNotFoundError:
            return None

    def read(self, max_samples):
        try:
            f = open(self.path, "rb")
        except FileNotFoundError:
            return np.zeros(0, dtype=np.float32)
        with f:
            avail = (os.fstat(f.fileno()).st_size - self.pos) // 2 * 2
            avail = min(avail, max_samples * 2)
            if avail <= 0:
                return np.zeros(0, dtype=np.float32)
            f.seek(self.pos)
            buf = f.read(avail)
        n = len(buf) // 2 * 2
        self.pos += n
        return pcm_to_float(buf[:n])


# ----------------------------------------------------------------------------- VAD


class SileroVad:
    """sherpa-onnx Silero VAD with absolute sample offsets."""

    name = "silero"

    def __init__(self, sherpa, model_path, base):
        cfg = sherpa.VadModelConfig()
        cfg.silero_vad.model = model_path
        cfg.silero_vad.threshold = VAD_THRESHOLD
        cfg.silero_vad.min_silence_duration = VAD_MIN_SILENCE_S
        cfg.silero_vad.min_speech_duration = VAD_MIN_SPEECH_S
        cfg.silero_vad.max_speech_duration = VAD_MAX_SPEECH_S
        cfg.silero_vad.window_size = VAD_WINDOW
        cfg.sample_rate = SAMPLE_RATE
        cfg.num_threads = 1
        if not cfg.validate():
            raise RuntimeError(f"invalid VAD config for {model_path}")
        self.vad = sherpa.VoiceActivityDetector(cfg, buffer_size_in_seconds=VAD_BUFFER_S)
        self.base = base  # absolute sample index of the detector's sample 0
        self.fed = base
        self.speech_since = None

    @property
    def in_speech(self):
        return self.vad.is_speech_detected()

    def accept(self, x):
        """Feed samples (a multiple of VAD_WINDOW); return finished (abs_start, samples)."""
        for i in range(0, len(x), VAD_WINDOW):
            self.vad.accept_waveform(x[i:i + VAD_WINDOW])
        self.fed += len(x)
        out = self._drain()
        if not self.in_speech:
            self.speech_since = None
        elif self.speech_since is None:
            self.speech_since = self.fed
        elif self.fed - self.speech_since > FORCE_FLUSH_S * SAMPLE_RATE:
            log(f"VAD: speech never ended for {FORCE_FLUSH_S:.0f}s; forcing a cut")
            out += self.flush()
            self.vad.reset()
            self.base = self.fed
            self.speech_since = None
        return out

    def flush(self):
        self.vad.flush()
        return self._drain()

    def _drain(self):
        out = []
        while not self.vad.empty():
            seg = self.vad.front
            out.append((self.base + seg.start, np.asarray(seg.samples, dtype=np.float32)))
            self.vad.pop()
        return out


class EnergyVad:
    """numpy fallback: adaptive-threshold energy detector with the SileroVad interface."""

    name = "energy"

    def __init__(self, base):
        self.fed = base
        self.rest = np.zeros(0, dtype=np.float32)  # partial window carried to the next call
        self.history = collections.deque(maxlen=int(ENERGY_FLOOR_WINDOW_S * SAMPLE_RATE / VAD_WINDOW))
        self.floor_db = -90.0
        self.count = 0
        self.pre = collections.deque(maxlen=ENERGY_ONSET_FRAMES + ENERGY_PAD_FRAMES)
        self.frames = None  # frames of the open segment
        self.seg_start = 0
        self.voiced = 0
        self.onset = 0
        self.silent_run = 0
        self.hang = math.ceil(VAD_MIN_SILENCE_S * SAMPLE_RATE / VAD_WINDOW)

    @property
    def in_speech(self):
        return self.frames is not None

    def accept(self, x):
        if len(self.rest):
            x = np.concatenate([self.rest, x])
        n = len(x) // VAD_WINDOW * VAD_WINDOW
        self.rest = x[n:]
        out = []
        for i in range(0, n, VAD_WINDOW):
            self._frame(x[i:i + VAD_WINDOW], out)
        return out

    def flush(self):
        out = []
        if self.frames is not None:
            self._emit(out)
        return out

    def _frame(self, f, out):
        pos = self.fed
        self.fed += len(f)
        e = 10.0 * math.log10(float(np.mean(np.square(f, dtype=np.float64))) + 1e-12)
        self.history.append(e)
        self.count += 1
        if self.count % 8 == 1:
            self.floor_db = float(np.percentile(self.history, 5))
        loud = e > max(self.floor_db + ENERGY_MARGIN_DB, ENERGY_MIN_DB)
        if self.frames is None:
            self.pre.append((pos, f))
            self.onset = self.onset + 1 if loud else 0
            if self.onset >= ENERGY_ONSET_FRAMES:
                self.seg_start = self.pre[0][0]
                self.frames = [fr for _, fr in self.pre]
                self.pre.clear()
                self.voiced, self.silent_run = self.onset, 0
            return
        self.frames.append(f)
        if loud:
            self.voiced += 1
            self.silent_run = 0
        else:
            self.silent_run += 1
        if self.silent_run >= self.hang:
            self._emit(out)
        elif len(self.frames) * VAD_WINDOW >= ENERGY_MAX_SEGMENT_S * SAMPLE_RATE:
            self._emit(out, keep_open=True)

    def _emit(self, out, keep_open=False):
        n = len(self.frames) - max(0, self.silent_run - ENERGY_PAD_FRAMES)
        if n > 0 and self.voiced * VAD_WINDOW >= VAD_MIN_SPEECH_S * SAMPLE_RATE:
            out.append((self.seg_start, np.concatenate(self.frames[:n])))
        if keep_open:
            self.seg_start += len(self.frames) * VAD_WINDOW
            self.frames, self.voiced = [], 0
        else:
            self.frames, self.onset, self.silent_run = None, 0, 0
            self.pre.clear()


# ----------------------------------------------------------------------------- UI speakers


class SpeakerTimeline:
    """Active UI speaker sets from speakers.jsonl, piecewise constant between events.

    Times are effective epoch ms: the observation time minus the indicator lag
    (the event's lagMs, else the configured default).
    """

    def __init__(self, path, default_lag_ms):
        self.path = path
        self.default_lag_ms = default_lag_ms
        self.times = []
        self.sets = []
        self.offset = 0
        self.partial = b""

    def poll(self):
        """Read complete lines appended since the last call."""
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return
        if size < self.offset:  # replaced or truncated
            self.times, self.sets, self.offset, self.partial = [], [], 0, b""
        if size == self.offset:
            return
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(size - self.offset)
        self.offset += len(data)
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()
        for line in lines:
            self.add_line(line)

    def load_all(self):
        self.poll()
        if self.partial:
            self.add_line(self.partial)  # accepted only if it is complete JSON
            self.partial = b""
        return self

    def add_line(self, line):
        line = line.strip()
        if not line:
            return
        try:
            ev = json.loads(line)
        except ValueError:
            return
        if isinstance(ev, dict):
            self.add(ev)

    def add(self, ev):
        t, speakers = ev.get("t"), ev.get("speakers")
        if not is_number(t) or not isinstance(speakers, list):
            return
        names = []
        for s in speakers:
            if isinstance(s, str):
                s = clean_name(s)
                if s and s not in names:
                    names.append(s)
        lag = ev.get("lagMs")
        # The bot stamps each signal with its own lag; the speakerLagMs setting
        # shifts all of them relative to the default, so it still tunes timing.
        if is_number(lag):
            lag = max(0.0, float(lag) + float(self.default_lag_ms) - DEFAULT_SPEAKER_LAG_MS)
        else:
            lag = float(self.default_lag_ms)
        t_eff = float(t) - lag
        i = bisect.bisect_right(self.times, t_eff)
        self.times.insert(i, t_eff)
        self.sets.insert(i, tuple(names))

    def prune(self, before_ms):
        """Forget events before before_ms, keeping the one still active then."""
        i = bisect.bisect_right(self.times, before_ms) - 1
        if i > 0:
            del self.times[:i]
            del self.sets[:i]

    def intervals(self, a, b):
        """[(start, end, names)] covering [a, b) in effective epoch ms."""
        i = bisect.bisect_right(self.times, a) - 1
        cur = self.sets[i] if i >= 0 else ()
        s, j, out = a, i + 1, []
        while j < len(self.times) and self.times[j] < b:
            if self.times[j] > s:
                out.append((s, self.times[j], cur))
                s = self.times[j]
            cur = self.sets[j]
            j += 1
        out.append((s, b, cur))
        return out


def ui_coverage(timeline, rec_start_ms, a, b):
    """{name: share of [a, b] (audio seconds)}; simultaneous speakers share the time."""
    if rec_start_ms is None or not timeline.times or b <= a:
        return {}
    a_ms, b_ms = rec_start_ms + a * 1000.0, rec_start_ms + b * 1000.0
    total = b_ms - a_ms
    cov = {}
    for s, e, names in timeline.intervals(a_ms, b_ms):
        for n in names:
            cov[n] = cov.get(n, 0.0) + (e - s) / len(names) / total
    return cov


def top_speaker(cov):
    """(name, share) of the largest coverage, or (None, 0.0)."""
    if not cov:
        return None, 0.0
    name = min(cov, key=lambda n: (-cov[n], n))
    return name, cov[name]


def ui_runs(timeline, rec_start_ms, a, b):
    """Dominant UI speaker runs [[name, start, end]] (audio seconds) covering [a, b].

    A speaker who joins the lit set takes the turn from that moment: at a
    hand-over the previous speaker's indicator (a per-participant track's
    release, Zoom's active-speaker slots) stays lit for a few hundred ms after
    they stop. Otherwise, in an overlap the speaker who was already talking
    keeps the turn. Pauses without a lit speaker are split between the
    neighbouring runs; brief interjections are folded back by merge_short_runs.
    """
    if rec_start_ms is None or not timeline.times or b <= a:
        return []
    runs, prev, prev_set = [], None, ()
    for s, e, names in timeline.intervals(rec_start_ms + a * 1000.0, rec_start_ms + b * 1000.0):
        if not names:
            prev_set = ()
            continue
        joined = [n for n in names if n not in prev_set]
        if joined and prev_set:
            name = joined[0]
        else:
            name = prev if prev in names else names[0]
        prev, prev_set = name, names
        s, e = (s - rec_start_ms) / 1000.0, (e - rec_start_ms) / 1000.0
        if runs and runs[-1][0] == name:
            runs[-1][2] = e
        else:
            runs.append([name, s, e])
    if not runs:
        return []
    runs[0][1], runs[-1][2] = a, b
    for left, right in zip(runs, runs[1:]):
        if left[2] < right[1]:
            mid = (left[2] + right[1]) / 2
            left[2] = right[1] = mid
    return runs


def merge_short_runs(runs, min_len):
    """Absorb runs shorter than min_len into a neighbour (flicker, lag edges)."""
    runs = [list(r) for r in runs]

    def coalesce(rs):
        out = []
        for r in rs:
            if out and out[-1][0] == r[0]:
                out[-1][2] = r[2]
            else:
                out.append(r)
        return out

    runs = coalesce(runs)
    while len(runs) > 1:
        lengths = [e - s for _, s, e in runs]
        i = min(range(len(runs)), key=lambda k: lengths[k])
        if lengths[i] >= min_len:
            break
        if i == 0:
            j = 1
        elif i == len(runs) - 1:
            j = i - 1
        else:
            j = i - 1 if lengths[i - 1] >= lengths[i + 1] else i + 1
        if j < i:
            runs[j][2] = runs[i][2]
        else:
            runs[j][1] = runs[i][1]
        del runs[i]
        runs = coalesce(runs)
    return runs


def ui_split_offsets(timeline, rec_start_ms, start_sample, x):
    """Sample offsets inside x where the dominant UI speaker changes (both sides >= 1.2 s)."""
    n = len(x)
    if n < 2 * MIN_SPLIT_PIECE_S * SAMPLE_RATE:
        return []
    a = start_sample / SAMPLE_RATE
    runs = merge_short_runs(ui_runs(timeline, rec_start_ms, a, a + n / SAMPLE_RATE), MIN_SPLIT_PIECE_S)
    if len(runs) < 2:
        return []
    raw = [int(round((r[2] - a) * SAMPLE_RATE)) for r in runs[:-1]]
    energy = frame_energy(x)
    min_piece = int(MIN_SPLIT_PIECE_S * SAMPLE_RATE)
    before, after = int(SPLIT_SEARCH_BEFORE_S * SAMPLE_RATE), int(SPLIT_SEARCH_AFTER_S * SAMPLE_RATE)
    cuts, prev = [], 0
    for k, c in enumerate(raw):
        nxt = raw[k + 1] if k + 1 < len(raw) else n
        lo, hi = max(c - before, prev + min_piece), min(c + after, nxt - min_piece)
        cut = quietest_sample(energy, lo, hi) if lo <= hi else c
        if prev < cut < n:
            cuts.append(cut)
            prev = cut
    return cuts


def pick_voice_changes(grid, sims, x):
    """Cut offsets from a similarity curve: one per run of grid points below
    CHANGE_MAX_SIM (deepest first), at the quietest frame near the run centre."""
    n = len(x)
    min_piece = int(MIN_SPLIT_PIECE_S * SAMPLE_RATE)
    candidates, i = [], 0
    while i < len(grid):
        if sims[i] >= CHANGE_MAX_SIM:
            i += 1
            continue
        j = i
        while j + 1 < len(grid) and sims[j + 1] < CHANGE_MAX_SIM:
            j += 1
        candidates.append((min(sims[i:j + 1]), (grid[i] + grid[j]) // 2, (grid[j] - grid[i]) // 2))
        i = j + 1
    if not candidates:
        return []
    energy = frame_energy(x, smooth_frames=5)
    cuts = []
    for _, centre, half in sorted(candidates):
        r = max(int(SPLIT_SEARCH_S * SAMPLE_RATE), min(half, int(CHANGE_SEARCH_MAX_S * SAMPLE_RATE)))
        lo, hi = max(min_piece, centre - r), min(n - min_piece, centre + r)
        if lo > hi:
            continue
        cut = quietest_sample(energy, lo, hi)
        if all(abs(cut - k) >= min_piece for k in cuts):
            cuts.append(cut)
    return sorted(cuts)


# ----------------------------------------------------------------------------- GigaAM client


def multipart(fields, file_field, filename, data, content_type):
    boundary = "----meetings" + uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ]
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode() + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def normalize_url(url):
    if not isinstance(url, str):
        return None
    url = url.strip().rstrip("/")
    return url or None


class AsrClient:
    """POSTs WAV pieces to GigaAM. Retries forever (with backoff) while the server is
    unreachable or fails every request; re-reads <hostData>/gigaam.json on every
    failure so a GigaAM restart on a new port does not stall transcription."""

    def __init__(self, primary_url, discovery_file, stop, on_status):
        self.primary = normalize_url(primary_url)
        self.discovery_file = discovery_file
        self.stop = stop
        self.on_status = on_status  # (detail or None when healthy)
        self.url = self.primary or self.discovered()
        self.model = None
        self._model_checked = False
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def discovered(self):
        obj = read_json(self.discovery_file) if self.discovery_file else None
        return normalize_url(obj.get("url")) if obj else None

    def transcribe(self, x):
        """Text for the samples; "" when nothing was recognized; None when the
        server keeps failing this piece but transcribes other audio (skipped).
        Raises Stopped on shutdown."""
        body, ctype = multipart({"response_format": "json"}, "file", "segment.wav", wav_bytes(x), "audio/wav")
        delay, failures, piece_errors = BACKOFF_MIN_S, 0, 0
        while True:
            if self.stop.is_set():
                raise Stopped()
            if not self.url:
                self.url = self.discovered() or self.primary
            url = self.url
            if not url:
                err = "GigaAM URL unknown (no --gigaam-url, config or gigaam.json)"
            else:
                try:
                    text = self._post(url, body, ctype)
                    if failures:
                        log(f"GigaAM is reachable again at {url}")
                    self.on_status(None)
                    self._check_model(url)
                    return text
                except urllib.error.HTTPError as e:
                    detail = self._error_body(e)
                    err = f"HTTP {e.code} from {url}: {detail}"
                    if e.code not in RETRYABLE_4XX and e.code not in UNAVAILABLE_5XX:
                        piece_errors += 1
                        if (e.code < 500 or piece_errors >= PIECE_5XX_TRIES) and self._probe(url):
                            log(f"GigaAM failed a {len(x) / SAMPLE_RATE:.1f}s piece (HTTP {e.code}: {detail}) "
                                f"but transcribes other audio; piece skipped")
                            self.on_status(None)
                            return None
                except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError) as e:
                    err = f"{url}: {type(e).__name__}: {e}"
            failures += 1
            self._failover(url, verbose=failures <= 2 or failures % 10 == 0)
            if failures == 1 or failures % 10 == 0:
                log(f"GigaAM unavailable ({err}); retrying in {delay:.0f}s (attempt {failures})")
            self.on_status(f"GigaAM unavailable: {err}"[:300])
            self._wait(delay)
            delay = min(delay * 2, BACKOFF_MAX_S)

    def _post(self, url, body, ctype):
        req = urllib.request.Request(
            url + "/v1/audio/transcriptions", data=body, method="POST",
            headers={"Content-Type": ctype, "Content-Length": str(len(body)), "Accept": "application/json"})
        with self._opener.open(req, timeout=ASR_TIMEOUT_S) as r:
            obj = json.loads(r.read().decode("utf-8"))
        text = obj["text"]
        if not isinstance(text, str):
            raise TypeError("response has no text")
        return " ".join(text.split())

    @staticmethod
    def _error_body(e):
        try:
            return e.read().decode("utf-8", "replace").strip()[:200]
        except Exception:  # noqa: BLE001 - best effort detail only
            return ""

    def _probe(self, url):
        """True when the server transcribes a second of silence, i.e. it works."""
        silence = wav_bytes(np.zeros(int(PROBE_S * SAMPLE_RATE), dtype=np.float32))
        body, ctype = multipart({"response_format": "json"}, "file", "probe.wav", silence, "audio/wav")
        try:
            self._post(url, body, ctype)
            return True
        except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError):
            return False

    def _failover(self, failed, verbose=True):
        """Try another URL next: gigaam.json's, else the primary. While both fail
        the attempts alternate between them (with backoff), so whichever comes
        back is used."""
        disc = self.discovered()
        if disc and disc != failed:
            if verbose:
                log(f"GigaAM: switching to {disc} (gigaam.json)")
            self.url = disc
        elif self.primary and self.primary != failed:
            self.url = self.primary

    def _wait(self, delay):
        """Sleep, but wake up early on shutdown or when gigaam.json is rewritten
        with a new URL during the wait (not merely because it differs from the
        URL to try next: that one may have just failed)."""
        end = time.monotonic() + delay
        seen = self.discovered()
        while True:
            if self.stop.is_set():
                raise Stopped()
            disc = self.discovered()
            if disc and disc != seen:
                log(f"GigaAM: gigaam.json now points to {disc}")
                self.url = disc
                return
            left = end - time.monotonic()
            if left <= 0:
                return
            self.stop.wait(min(POLL_S, left))

    def _check_model(self, url):
        if self._model_checked:
            return
        self._model_checked = True
        try:
            with self._opener.open(url + "/health", timeout=5) as r:
                model = json.loads(r.read().decode("utf-8")).get("model")
            self.model = model if isinstance(model, str) else None
        except Exception:  # noqa: BLE001 - the model name is informational
            self.model = None


# ----------------------------------------------------------------------------- embeddings


class Embedder:
    """Speaker embeddings with one shared extractor (thread-safe; compute releases the GIL)."""

    def __init__(self, sherpa, model_path, workers):
        cfg = sherpa.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=1, debug=False, provider="cpu")
        if not cfg.validate():
            raise RuntimeError(f"invalid speaker model {model_path}")
        self.ext = sherpa.SpeakerEmbeddingExtractor(cfg)
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="embed")

    def submit(self, x):
        """Futures for the <= 3 s windows of a piece, or None if it is too short."""
        n = len(x)
        if n < MIN_EMBED_S * SAMPLE_RATE:
            return None
        k = max(1, math.ceil(n / (EMBED_WINDOW_S * SAMPLE_RATE)))
        bounds = np.linspace(0, n, k + 1).astype(int)
        return [self.pool.submit(self._one, np.ascontiguousarray(x[bounds[i]:bounds[i + 1]])) for i in range(k)]

    def _one(self, x):
        stream = self.ext.create_stream()
        stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=x)
        stream.input_finished()
        if not self.ext.is_ready(stream):
            return None
        return unit(np.asarray(self.ext.compute(stream), dtype=np.float32))

    def change_points(self, x):
        """Offsets inside x where the voice changes (both sides >= 1.2 s)."""
        n = len(x)
        min_piece = int(MIN_SPLIT_PIECE_S * SAMPLE_RATE)
        if n < 2 * min_piece:
            return []
        w, hop = int(CHANGE_WINDOW_S * SAMPLE_RATE), int(CHANGE_HOP_S * SAMPLE_RATE)
        grid = list(range(min_piece, n - min_piece + 1, hop))
        cache = {}

        def window(a, b):
            if (a, b) not in cache:
                cache[(a, b)] = self.pool.submit(self._one, np.ascontiguousarray(x[a:b]))
            return cache[(a, b)]

        pairs = [(window(max(0, t - w), t), window(t, min(n, t + w))) for t in grid]
        sims = []
        for left, right in pairs:
            a, b = left.result(), right.result()
            sims.append(float(a @ b) if a is not None and b is not None else 1.0)
        return pick_voice_changes(grid, sims, x)

    @staticmethod
    def collect(futures):
        embs = [e for e in (f.result() for f in futures) if e is not None]
        return unit(np.mean(embs, axis=0)) if embs else None

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)


def unit(v):
    """L2-normalized float32 vector, or None if it is not finite."""
    v = np.asarray(v, dtype=np.float32)
    if v.ndim != 1 or not v.size or not np.all(np.isfinite(v)):
        return None
    norm = float(np.linalg.norm(v))
    return (v / norm).astype(np.float32) if math.isfinite(norm) and norm > 1e-6 else None


def encode_embedding(v):
    return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode("ascii")


def decode_embedding(s):
    try:
        raw = base64.b64decode(s, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw or len(raw) % 4:
        return None
    return unit(np.frombuffer(raw, dtype="<f4"))


def cluster_threshold():
    raw = os.environ.get("MEETINGS_CLUSTER_THRESHOLD", "")
    try:
        v = float(raw)
    except ValueError:
        return DEFAULT_CLUSTER_THRESHOLD
    return v if -1.0 < v <= 1.0 else DEFAULT_CLUSTER_THRESHOLD


def agglomerative(X, threshold):
    """Average-linkage agglomerative clustering on cosine similarity.

    X: (n, d) L2-normalized rows. Merges while the best average similarity
    between two clusters is >= threshold. Labels 0..k-1 by first appearance.
    Nearest-neighbour caching keeps it about O(n^2).
    """
    n = len(X)
    if n <= 1:
        return np.zeros(n, dtype=int)
    X = np.asarray(X, dtype=np.float32)
    S = X @ X.T  # float32, n x n: 64 MB at MAX_CLUSTER_ITEMS
    np.fill_diagonal(S, -np.inf)
    size = np.ones(n)
    members = [[i] for i in range(n)]
    active = np.ones(n, dtype=bool)
    best_idx = S.argmax(axis=1)
    best_val = S[np.arange(n), best_idx]
    while True:
        i = int(best_val.argmax())
        if not best_val[i] >= threshold:
            break
        j = int(best_idx[i])
        S[i] = (size[i] * S[i] + size[j] * S[j]) / (size[i] + size[j])
        S[:, i] = S[i]
        S[i, i] = -np.inf
        S[j, :] = -np.inf
        S[:, j] = -np.inf
        size[i] += size[j]
        members[i] += members[j]
        members[j] = []
        active[j] = False
        best_val[j] = -np.inf
        stale = active & ((best_idx == i) | (best_idx == j))
        stale[i] = True
        rows = np.flatnonzero(stale)
        sub = S[rows]
        bi = sub.argmax(axis=1)
        best_idx[rows] = bi
        best_val[rows] = sub[np.arange(len(rows)), bi]
        col = S[:, i]
        better = active & (col > best_val)
        best_idx[better] = i
        best_val[better] = col[better]
    labels = np.empty(n, dtype=int)
    groups = sorted((min(m), m) for m in members if m)
    for k, (_, m) in enumerate(groups):
        labels[m] = k
    return labels


def cluster_embeddings(X, durations, threshold):
    """Cluster rows of X; above MAX_CLUSTER_ITEMS cluster the longest pieces and
    assign the rest to the most similar cluster centroid."""
    n = len(X)
    if n <= MAX_CLUSTER_ITEMS:
        return agglomerative(X, threshold)
    keep = np.sort(np.argsort(-np.asarray(durations))[:MAX_CLUSTER_ITEMS])
    sub = agglomerative(X[keep], threshold)
    k = int(sub.max()) + 1
    cents = np.stack([unit(X[keep][sub == c].mean(axis=0)) for c in range(k)])
    labels = np.argmax(X @ cents.T, axis=1)
    labels[keep] = sub
    # relabel by first appearance
    order = {}
    for lab in labels:
        order.setdefault(int(lab), len(order))
    return np.array([order[int(lab)] for lab in labels], dtype=int)


# ----------------------------------------------------------------------------- final speakers


def ui_speaker(name):
    return f"ui:{name}", name, "ui"


def decide_speakers(segments, coverages, own_clusters, mode):
    """Final (speakerKey, speaker, source) per segment (DESIGN §5).

    segments: [{start, end}] in time order; coverages: [{name: share}];
    own_clusters: cluster id per segment, None when it has no embedding.
    """
    n = len(segments)
    dom = [top_speaker(c) for c in coverages]
    # Pieces without an embedding inherit the previous piece's cluster (or the first one).
    clusters, last = [], None
    for c in own_clusters:
        last = c if c is not None else last
        clusters.append(last)
    first = next((c for c in clusters if c is not None), None)
    clusters = [c if c is not None else first for c in clusters]

    names, impure = {}, set()
    if mode == "ui+acoustic":
        votes = collections.defaultdict(lambda: collections.defaultdict(float))
        for seg, (name, share), c in zip(segments, dom, own_clusters):
            if c is not None and name is not None and share >= UI_CONFIDENT_COVERAGE:
                votes[c][name] += max(0.0, seg["end"] - seg["start"])
        for c, v in votes.items():
            total = sum(v.values())
            ranked = sorted(v.items(), key=lambda kv: (-kv[1], kv[0]))
            if total <= 0:
                continue
            if len(ranked) > 1 and ranked[1][1] >= IMPURE_SHARE * total:
                impure.add(c)
            else:
                names[c] = ranked[0][0]

    numbers = {}

    def acoustic(c):
        if c not in numbers:
            numbers[c] = len(numbers) + 1
        k = numbers[c]
        return f"spk:{k}", f"Спикер {k}", "acoustic"

    unknown = (UNKNOWN_KEY, UNKNOWN_LABEL, "none")
    out = []
    for i in range(n):
        name, share = dom[i]
        c = clusters[i]
        if mode == "ui":
            out.append(ui_speaker(name) if name else unknown)
        elif mode == "acoustic":
            out.append(acoustic(c) if c is not None else unknown)
        elif name and share >= UI_CONFIDENT_COVERAGE:
            out.append(ui_speaker(name))
        elif c is not None and c in names:
            out.append((f"ui:{names[c]}", names[c], "mixed"))
        elif c is not None and c in impure and name:
            out.append(ui_speaker(name))
        elif c is not None:
            out.append(acoustic(c))
        elif name:
            out.append(ui_speaker(name))
        else:
            out.append(unknown)
    return out


def speaker_summary(segments):
    by_key = {}
    for s in segments:
        sp = by_key.setdefault(s["speakerKey"], {"key": s["speakerKey"], "label": s["speaker"], "sources": set(),
                                                 "talkSec": 0.0, "segments": 0})
        sp["sources"].add(s["source"])
        sp["talkSec"] += max(0.0, s["end"] - s["start"])
        sp["segments"] += 1
    out = []
    for sp in by_key.values():
        sources = sp.pop("sources")
        sp["source"] = next(iter(sources)) if len(sources) == 1 else "mixed"
        sp["talkSec"] = round(sp["talkSec"], 2)
        out.append({"key": sp["key"], "label": sp["label"], "source": sp["source"],
                    "talkSec": sp["talkSec"], "segments": sp["segments"]})
    out.sort(key=lambda sp: (-sp["talkSec"], sp["label"]))
    return out


def merge_turns(segments):
    """Consecutive same-speaker segments with gaps < 2 s form one turn."""
    turns = []
    for s in segments:
        t = turns[-1] if turns else None
        if t and t["speakerKey"] == s["speakerKey"] and s["start"] - t["end"] < TURN_MERGE_GAP_S:
            t["end"] = max(t["end"], s["end"])
            t["text"] = f"{t['text']} {s['text']}".strip()
        else:
            turns.append({"speakerKey": s["speakerKey"], "speaker": s["speaker"], "start": s["start"],
                          "end": s["end"], "text": s["text"]})
    return turns


def md_escape(text):
    return "".join("\\" + ch if ch in "\\*_`[]<>#" else ch for ch in text)


def render_markdown(transcript):
    labels = [sp["label"] for sp in transcript["speakers"]]
    lines = [
        "# Расшифровка встречи",
        "",
        f"- Длительность: {fmt_hms(transcript['audioSec'])}",
        f"- Спикеры: {', '.join(md_escape(x) for x in labels) if labels else '—'}",
        "",
    ]
    turns = merge_turns(transcript["segments"])
    if not turns:
        lines.append("_Речь не распознана._")
    for t in turns:
        lines += [f"**{md_escape(t['speaker'])}** · {fmt_hms(t['start'])}", t["text"], ""]
    return "\n".join(lines).rstrip() + "\n"


def render_text(transcript):
    return "".join(f"[{fmt_hms(t['start'])}] {t['speaker']}: {t['text']}\n"
                   for t in merge_turns(transcript["segments"]))


def load_segments(path, next_id):
    """Valid segments with id < next_id, first occurrence per id, sorted by id."""
    seen = {}
    for obj in iter_jsonl(path):
        sid = obj.get("id")
        if (isinstance(sid, int) and not isinstance(sid, bool) and 0 <= sid < next_id and sid not in seen
                and is_number(obj.get("start")) and is_number(obj.get("end")) and isinstance(obj.get("text"), str)):
            seen[sid] = obj
    return [seen[k] for k in sorted(seen)]


def load_embeddings(path, next_id):
    embs = {}
    for obj in iter_jsonl(path):
        sid = obj.get("id")
        if isinstance(sid, int) and 0 <= sid < next_id and sid not in embs and isinstance(obj.get("emb"), str):
            v = decode_embedding(obj["emb"])
            if v is not None:
                embs[sid] = v
    if embs:  # keep the most common dimension (a model change between runs)
        dims = collections.Counter(len(v) for v in embs.values())
        dim = dims.most_common(1)[0][0]
        embs = {k: v for k, v in embs.items() if len(v) == dim}
    return embs


def truncate_jsonl(path, next_id):
    """Keep valid lines with id < next_id (first occurrence); drop the rest."""
    if not os.path.exists(path):
        return 0
    kept, seen = [], set()
    for obj in iter_jsonl(path):
        sid = obj.get("id")
        if isinstance(sid, int) and 0 <= sid < next_id and sid not in seen:
            seen.add(sid)
            kept.append(json.dumps(obj, ensure_ascii=False) + "\n")
    write_text_atomic(path, "".join(kept))
    return len(kept)


# ----------------------------------------------------------------------------- the transcriber


def load_sherpa():
    if os.environ.get("MEETINGS_DISABLE_SHERPA") == "1":
        log("sherpa_onnx disabled by MEETINGS_DISABLE_SHERPA=1: energy VAD, UI-only speakers")
        return None
    try:
        import sherpa_onnx
    except Exception as e:  # noqa: BLE001 - any import failure means "not available"
        log(f"sherpa_onnx unavailable ({type(e).__name__}: {e}): energy VAD, UI-only speakers")
        return None
    return sherpa_onnx


def default_workers():
    # GigaAM already uses about half of the cores.
    return max(1, min(4, (os.cpu_count() or 2) // 2))


class Transcriber:
    def __init__(self, args):
        self.dir = os.path.abspath(args.meeting_dir)
        self.mode = args.mode
        self.host_data = args.host_data or self._default_host_data()
        self.models_dir = args.models_dir or (os.path.join(self.host_data, "models") if self.host_data else "")
        p = lambda name: os.path.join(self.dir, name)  # noqa: E731
        self.paths = {
            "config": p("config.json"), "bot": p("state.json"), "speakers": p("speakers.jsonl"),
            "pcm": p("audio.pcm"), "ogg": p("audio.ogg"), "decoded": p("audio.decoded.pcm"),
            "state": p("transcriber.json"),
            "segments": p("segments.jsonl"), "embeddings": p("embeddings.jsonl"),
            "json": p("transcript.json"), "md": p("transcript.md"), "txt": p("transcript.txt"),
            "lock": p("transcriber.lock"),
        }

        cfg = read_json(self.paths["config"]) or {}
        tr = cfg.get("transcriber") if isinstance(cfg.get("transcriber"), dict) else {}
        self.meeting_id = cfg.get("meetingId") if isinstance(cfg.get("meetingId"), str) else os.path.basename(self.dir)
        self.diarization = tr.get("diarization") if tr.get("diarization") in DIARIZATION_MODES else "ui+acoustic"
        self.lag_ms = int(tr["speakerLagMs"]) if is_number(tr.get("speakerLagMs")) else DEFAULT_SPEAKER_LAG_MS
        self.keep_raw = tr.get("keepRawAudio") is True
        threads = args.threads if args.threads is not None else tr.get("threads")
        self.workers = int(threads) if is_number(threads) and threads > 0 else default_workers()
        primary_url = args.gigaam_url or tr.get("gigaamUrl")

        self.stop = threading.Event()
        self.lock = threading.RLock()
        self.next_id = 0
        self.checkpoint = 0  # resume sample: everything before it is fully processed
        self.fed = 0  # samples consumed by the VAD
        self.audio_samples = 0
        self.pending = np.zeros(0, dtype=np.float32)
        self.rec_start = None
        self.nothing_recorded = False  # live: the bot ended without audio; leave no state behind
        self._last_write = 0.0
        self._last_prune = 0.0
        self.state = {
            "version": 1, "pid": os.getpid(), "mode": self.mode, "phase": "waiting_audio", "detail": "starting",
            "processedSec": 0.0, "audioSec": 0.0, "segments": 0, "checkpoint": {"samples": 0, "nextId": 0},
            "error": None, "startedAt": now_ms(), "updatedAt": now_ms(), "finishedAt": None,
        }
        self.sherpa = None
        self.embedder = None
        self.effective_diarization = self.diarization
        self.timeline = SpeakerTimeline(self.paths["speakers"], self.lag_ms)
        discovery = os.path.join(self.host_data, "gigaam.json") if self.host_data else None
        self.asr = AsrClient(primary_url, discovery, self.stop, self._asr_status)

    def _default_host_data(self):
        parent = os.path.dirname(self.dir)
        return os.path.dirname(parent) if os.path.basename(parent) == "meetings" else None

    # ---- state file

    def set_phase(self, phase, detail=None):
        with self.lock:
            self.state["phase"] = phase
            if detail is not None:
                self.state["detail"] = detail

    def save(self, force=False):
        with self.lock:
            now = time.monotonic()
            if self.nothing_recorded or (not force and now - self._last_write < STATE_MIN_INTERVAL_S):
                return
            self.state.update(
                processedSec=round(self.fed / SAMPLE_RATE, 3),
                audioSec=round(self.audio_samples / SAMPLE_RATE, 3),
                segments=self.next_id,
                checkpoint={"samples": int(self.checkpoint), "nextId": int(self.next_id)},
                updatedAt=now_ms(),
            )
            write_json_atomic(self.paths["state"], self.state)
            self._last_write = now

    def _heartbeat(self, done):
        while not done.wait(STATE_MIN_INTERVAL_S):
            try:
                self.save()
            except OSError as e:
                log(f"could not write transcriber.json: {e}")

    def _asr_status(self, problem):
        with self.lock:
            if problem:
                self.set_phase("waiting_asr", problem)
            elif self.state["phase"] == "waiting_asr":
                self.set_phase("live", "transcribing" if self.mode == "live" else "transcribing (offline)")
        self.save()

    # ---- entry point

    def run(self):
        if not os.path.isdir(self.dir):
            log(f"meeting directory {self.dir} does not exist")
            return 1
        lock_file = open(self.paths["lock"], "a")
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log(f"another transcriber is already running for {self.dir}; exiting")
            return 0
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: self.stop.set())
        heartbeat_done = threading.Event()
        heartbeat = None
        try:
            log(f"transcriber {self.mode} for {self.dir} (pid {os.getpid()}, diarization {self.diarization})")
            if self.mode == "live" and not self._prepare_live():
                return 0
            if self.mode == "offline":
                self._prepare_offline()
            self.save(force=True)
            heartbeat = threading.Thread(target=self._heartbeat, args=(heartbeat_done,), daemon=True)
            heartbeat.start()
            self._load_models()
            if self.mode == "offline":
                self._run_offline()
            else:
                self._run_live()
            return 0
        except Stopped:
            log("stopped by signal; state saved, resumable")
            with self.lock:
                self.state["detail"] = "interrupted; resumable"
            self.save(force=True)
            return 0
        except Exception as e:  # noqa: BLE001 - report every fatal error in transcriber.json
            log(f"fatal: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            with self.lock:
                self.state.update(phase="failed", detail="failed", error=f"{type(e).__name__}: {e}"[:1000],
                                  finishedAt=now_ms())
            try:
                self.save(force=True)
            except OSError:
                pass
            return 1
        finally:
            heartbeat_done.set()
            if heartbeat:
                heartbeat.join(timeout=5)
            if self.embedder:
                self.embedder.close()
            lock_file.close()

    def _prepare_live(self):
        prev = read_json(self.paths["state"])
        if prev and prev.get("phase") == "done" and os.path.exists(self.paths["json"]):
            log("transcript is already final; nothing to do")
            return False
        cp = prev.get("checkpoint") if prev else None
        if isinstance(cp, dict) and isinstance(cp.get("samples"), int) and isinstance(cp.get("nextId"), int):
            self.checkpoint = max(0, cp["samples"])
            self.next_id = max(0, cp["nextId"])
            log(f"resuming at {self.checkpoint / SAMPLE_RATE:.2f}s, next segment id {self.next_id}")
        kept = truncate_jsonl(self.paths["segments"], self.next_id)
        truncate_jsonl(self.paths["embeddings"], self.next_id)
        if kept != self.next_id:
            log(f"note: {kept} of {self.next_id} checkpointed segments are present in segments.jsonl")
        self.fed = self.checkpoint
        return True

    def _prepare_offline(self):
        for key in ("segments", "embeddings", "json", "md", "txt"):
            remove_quietly(self.paths[key])

    def _load_models(self):
        self.sherpa = load_sherpa()
        if self.diarization == "ui":
            return
        spk_path = os.path.join(self.models_dir, SPEAKER_MODEL_FILE)
        if self.sherpa is None:
            pass
        elif not os.path.isfile(spk_path):
            log(f"speaker model {spk_path} not found: UI-only speakers")
        else:
            try:
                self.embedder = Embedder(self.sherpa, spk_path, self.workers)
                log(f"speaker embeddings: {SPEAKER_MODEL_FILE}, {self.workers} worker(s)")
            except Exception as e:  # noqa: BLE001
                log(f"could not load the speaker model ({e}): UI-only speakers")
        if self.embedder is None and not load_embeddings(self.paths["embeddings"], self.next_id):
            self.effective_diarization = "ui"

    def make_vad(self, base):
        path = os.path.join(self.models_dir, VAD_MODEL_FILE)
        if self.sherpa is not None:
            if os.path.isfile(path):
                try:
                    return SileroVad(self.sherpa, path, base)
                except Exception as e:  # noqa: BLE001
                    log(f"could not load Silero VAD ({e}); using the energy VAD")
            else:
                log(f"VAD model {path} not found; using the energy VAD")
        return EnergyVad(base)

    # ---- bot state

    def _read_bot(self):
        bot = read_json(self.paths["bot"])
        if bot and is_number(bot.get("recordingStartedAt")):
            self.rec_start = float(bot["recordingStartedAt"])
        return bot

    def _pid_alive(self, pid):
        if not os.path.isdir("/proc/self"):
            return True
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmdline = f.read()
        except FileNotFoundError:
            return False
        except OSError:
            return os.path.exists(f"/proc/{pid}")
        # Zombies have an empty cmdline; a reused pid will not mention this meeting.
        return bool(cmdline) and os.path.basename(self.dir).encode() in cmdline

    def _bot_finished(self, bot, elapsed):
        if bot is None:
            return elapsed > NO_BOT_STATE_GRACE_S
        if bot.get("phase") in TERMINAL_BOT_PHASES:
            return True
        pid = bot.get("pid")
        return isinstance(pid, int) and pid > 0 and not self._pid_alive(pid)

    # ---- modes

    def _run_live(self):
        pcm = PcmSource(self.paths["pcm"], self.checkpoint)
        vad = self.make_vad(self.checkpoint)
        log(f"VAD: {vad.name}; speakers: {self.effective_diarization}; GigaAM: {self.asr.url or 'gigaam.json'}")
        t0 = time.monotonic()
        last_size, last_growth, tried_ogg = None, time.monotonic(), False
        self.set_phase("waiting_audio", "waiting for audio")
        while True:
            if self.stop.is_set():
                raise Stopped()
            bot = self._read_bot()
            self.timeline.poll()
            self._prune_timeline()
            size = pcm.size()
            now = time.monotonic()
            if size != last_size:
                last_size, last_growth = size, now
            finished = self._bot_finished(bot, now - t0)
            if not size:  # no audio.pcm yet, or ffmpeg has not written to it
                if finished and not tried_ogg:
                    tried_ogg = True
                    if self._decode_ogg():
                        pcm.path = self.paths["decoded"]
                        continue
                if finished:
                    log("the bot has finished and there is no audio")
                    break
                self.set_phase("waiting_audio", "waiting for audio")
                self.save()
                self.stop.wait(POLL_S)
                continue
            self.audio_samples = size // 2
            if self.state["phase"] != "waiting_asr":
                self.set_phase("live", "transcribing")
            if self._consume(pcm, vad, READ_MAX_SAMPLES):
                continue
            if finished and now - last_growth >= AUDIO_IDLE_EXIT_S:
                break
            self.save()
            self.stop.wait(POLL_S)
        while self._consume(pcm, vad, READ_MAX_SAMPLES):
            pass
        self._consume(pcm, vad, READ_MAX_SAMPLES, final=True)
        if self._recorded_nothing():
            log("nothing was recorded: no transcript")
            self._discard_state()
            return
        self._finalize()

    def _recorded_nothing(self):
        """True when there is no audio by the server's measure too (audio.ogg empty or
        missing, state.json audio.bytes 0): the join failed or was cancelled, and an
        empty final transcript would make the server report the meeting as done."""
        if self.next_id or self.checkpoint or self.audio_samples:
            return False
        if os.path.isfile(self.paths["ogg"]) and os.path.getsize(self.paths["ogg"]) > 0:
            return False
        bot = read_json(self.paths["bot"]) or {}
        audio = bot.get("audio") if isinstance(bot.get("audio"), dict) else {}
        return not (is_number(audio.get("bytes")) and audio["bytes"] > 0)

    def _discard_state(self):
        """Remove transcriber.json for good, as if live transcription had never run."""
        with self.lock:
            self.nothing_recorded = True  # save() writes nothing from now on
            remove_quietly(self.paths["state"])

    def _raw_pcm_complete(self, bot):
        """audio.pcm holds the whole recording: at least the bytes the bot reported."""
        audio = bot.get("audio") if bot and isinstance(bot.get("audio"), dict) else {}
        expected = audio.get("bytes")
        size = PcmSource(self.paths["pcm"], 0).size()
        return is_number(expected) and expected > 0 and size is not None and size >= expected

    def _run_offline(self):
        bot = self._read_bot()
        # The lossless recording (kept by keepRawAudio, or left by a live run that
        # never finalized) beats decoding the Opus archive, which never replaces it.
        if self._raw_pcm_complete(bot):
            log("transcribing the recorded audio.pcm (audio.ogg is not decoded)")
            source = self.paths["pcm"]
        elif self._decode_ogg():
            source = self.paths["decoded"]
        elif os.path.isfile(self.paths["pcm"]):
            log("audio.ogg not found; transcribing the existing audio.pcm")
            source = self.paths["pcm"]
        else:
            raise RuntimeError("no audio: neither audio.ogg nor audio.pcm exists")
        self.timeline.load_all()
        pcm = PcmSource(source, 0)
        self.audio_samples = (pcm.size() or 0) // 2
        vad = self.make_vad(0)
        log(f"VAD: {vad.name}; speakers: {self.effective_diarization}; GigaAM: {self.asr.url or 'gigaam.json'}; "
            f"audio {self.audio_samples / SAMPLE_RATE:.1f}s")
        self.set_phase("live", "transcribing (offline)")
        while self._consume(pcm, vad, READ_MAX_SAMPLES):
            pass
        self._consume(pcm, vad, READ_MAX_SAMPLES, final=True)
        self._finalize()

    def _decode_ogg(self):
        """audio.ogg -> audio.decoded.pcm (16 kHz mono s16le), deleted at finalize.
        Never written over audio.pcm, the recording keepRawAudio keeps.
        Interruptible. False when audio.ogg is missing or empty."""
        if not (os.path.isfile(self.paths["ogg"]) and os.path.getsize(self.paths["ogg"]) > 0):
            return False
        self.set_phase("live", "decoding audio.ogg")
        self.save(force=True)
        out = self.paths["decoded"]
        tmp = out + ".tmp"
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", self.paths["ogg"],
               "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", tmp]
        started = time.monotonic()
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not found") from None
        while proc.poll() is None:
            if self.stop.wait(0.2):
                proc.kill()
                proc.wait()
                remove_quietly(tmp)
                raise Stopped()
        err = proc.stderr.read().decode("utf-8", "replace").strip()
        proc.stderr.close()
        if proc.returncode != 0:
            remove_quietly(tmp)
            raise RuntimeError(f"ffmpeg could not decode audio.ogg: {err[-300:] or proc.returncode}")
        os.replace(tmp, out)
        log(f"decoded audio.ogg -> {os.path.basename(out)} ({os.path.getsize(out) / 2 / SAMPLE_RATE:.1f}s) "
            f"in {time.monotonic() - started:.1f}s")
        return True

    def _prune_timeline(self):
        now = time.monotonic()
        if self.rec_start is not None and now - self._last_prune > 60:
            self._last_prune = now
            self.timeline.prune(self.rec_start + (self.fed / SAMPLE_RATE - TIMELINE_KEEP_S) * 1000.0)

    # ---- pipeline

    def _consume(self, pcm, vad, max_samples, final=False):
        """Read up to max_samples, run the VAD, process finished speech. Returns samples read."""
        data = pcm.read(max_samples)
        if len(data):
            self.pending = np.concatenate([self.pending, data]) if len(self.pending) else data
            self.audio_samples = max(self.audio_samples, pcm.pos // 2)
        n = len(self.pending) // VAD_WINDOW * VAD_WINDOW
        for off in range(0, n, CHUNK_SAMPLES):
            chunk = self.pending[off:min(n, off + CHUNK_SAMPLES)]
            segments = vad.accept(chunk)
            self.fed = vad.fed
            for start, x in segments:
                self._process_speech(start, x)
        self.pending = self.pending[n:]
        if final:
            for start, x in vad.flush():
                self._process_speech(start, x)
            self.pending = np.zeros(0, dtype=np.float32)
        if final or not vad.in_speech:
            margin = 0 if final else int(RESUME_SILENCE_MARGIN_S * SAMPLE_RATE)
            with self.lock:
                self.checkpoint = max(self.checkpoint, self.fed - margin)
        self.save()
        return len(data)

    def _process_speech(self, start, x):
        """Split a VAD segment at speaker changes (UI first, else voice), then transcribe the pieces."""
        if self.mode == "live":
            self.timeline.poll()
        offsets = []
        if self.effective_diarization != "acoustic":
            offsets = ui_split_offsets(self.timeline, self.rec_start, start, x)
        bounds = [0] + offsets + [len(x)]
        for a, b in zip(bounds, bounds[1:]):
            sub = [a, b]
            if self._needs_voice_split(start + a, b - a):
                sub = [a] + [a + c for c in self.embedder.change_points(x[a:b])] + [b]
            for c, d in zip(sub, sub[1:]):
                for piece_start, piece in hard_cut(start + c, x[c:d]):
                    self._emit(piece_start, piece)

    def _needs_voice_split(self, start, length):
        """Look for voice changes unless the UI confidently names a single speaker."""
        if self.embedder is None or length < 2 * MIN_SPLIT_PIECE_S * SAMPLE_RATE:
            return False
        if self.effective_diarization == "acoustic":
            return True
        a = start / SAMPLE_RATE
        _, share = top_speaker(ui_coverage(self.timeline, self.rec_start, a, a + length / SAMPLE_RATE))
        return share < UI_CONFIDENT_COVERAGE

    def _emit(self, start, x):
        futures = self.embedder.submit(x) if self.embedder else None
        text = self.asr.transcribe(x)
        emb = Embedder.collect(futures) if futures else None
        end = start + len(x)
        if text:
            a, b = round(start / SAMPLE_RATE, 3), round(end / SAMPLE_RATE, 3)
            key, label, source = self._live_speaker(a, b)
            seg = {"id": self.next_id, "start": a, "end": b, "speakerKey": key, "speaker": label,
                   "source": source, "text": text}
            append_jsonl(self.paths["segments"], seg)
            if emb is not None:
                append_jsonl(self.paths["embeddings"], {"id": self.next_id, "emb": encode_embedding(emb)})
            short = text if len(text) <= 80 else text[:77] + "..."
            log(f"#{self.next_id} [{a:.2f}-{b:.2f}] {label}: {short}")
            with self.lock:
                self.next_id += 1
                self.checkpoint = max(self.checkpoint, end)
        else:
            with self.lock:
                self.checkpoint = max(self.checkpoint, end)
        self.save(force=True)

    def _live_speaker(self, a, b):
        if self.effective_diarization != "acoustic":
            name, _ = top_speaker(ui_coverage(self.timeline, self.rec_start, a, b))
            if name:
                return ui_speaker(name)
        return UNKNOWN_KEY, UNKNOWN_LABEL, "none"

    # ---- finalize

    def _finalize(self):
        self.set_phase("finalizing", "assigning speakers")
        self.save(force=True)
        started = time.monotonic()
        self._read_bot()
        segments = load_segments(self.paths["segments"], self.next_id)
        timeline = SpeakerTimeline(self.paths["speakers"], self.lag_ms).load_all()
        coverages = [ui_coverage(timeline, self.rec_start, s["start"], s["end"]) for s in segments]
        mode = self.effective_diarization
        own_clusters = [None] * len(segments)
        if mode != "ui":
            embs = load_embeddings(self.paths["embeddings"], self.next_id)
            idx = [i for i, s in enumerate(segments) if s["id"] in embs]
            if idx:
                X = np.stack([embs[segments[i]["id"]] for i in idx])
                durations = [segments[i]["end"] - segments[i]["start"] for i in idx]
                threshold = cluster_threshold()
                labels = cluster_embeddings(X, durations, threshold)
                for i, lab in zip(idx, labels):
                    own_clusters[i] = int(lab)
                log(f"clustering: {len(idx)} embeddings -> {int(labels.max()) + 1} cluster(s) at {threshold}")
            elif mode == "acoustic":
                log("no speaker embeddings: all speakers unknown")
        decisions = decide_speakers(segments, coverages, own_clusters, mode)
        final = []
        for s, (key, label, source) in zip(segments, decisions):
            final.append({"id": s["id"], "start": s["start"], "end": s["end"], "speakerKey": key,
                          "speaker": label, "source": source, "text": s["text"]})
        final.sort(key=lambda s: (s["start"], s["id"]))
        transcript = {
            "version": 1,
            "meetingId": self.meeting_id,
            "audioSec": round(self.audio_samples / SAMPLE_RATE, 3),
            "createdAt": now_ms(),
            "asr": {"engine": "gigaam", "model": self.asr.model},
            "diarization": mode,
            "speakers": speaker_summary(final),
            "segments": final,
        }
        write_json_atomic(self.paths["json"], transcript)
        write_text_atomic(self.paths["md"], render_markdown(transcript))
        write_text_atomic(self.paths["txt"], render_text(transcript))
        remove_quietly(self.paths["decoded"])
        if not self.keep_raw:
            remove_quietly(self.paths["pcm"])
        speakers = ", ".join(f"{sp['label']} {sp['talkSec']:.0f}s" for sp in transcript["speakers"])
        log(f"final transcript: {len(final)} segments, speakers: {speakers or 'none'} "
            f"({time.monotonic() - started:.2f}s)")
        with self.lock:
            self.state.update(phase="done", detail=f"{len(final)} segments", finishedAt=now_ms(), error=None)
        self.save(force=True)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--meeting-dir", required=True)
    ap.add_argument("--mode", choices=["live", "offline"], required=True)
    ap.add_argument("--models-dir", default=None, help="directory with the VAD and speaker models")
    ap.add_argument("--gigaam-url", default=None, help="overrides config.json transcriber.gigaamUrl")
    ap.add_argument("--host-data", default=None, help="plugin host data dir (for gigaam.json); default: inferred")
    ap.add_argument("--threads", type=int, default=None, help="embedding threads; 0 = auto")
    return ap.parse_args(argv)


def main(argv=None):
    return Transcriber(parse_args(argv)).run()


if __name__ == "__main__":
    sys.exit(main())
