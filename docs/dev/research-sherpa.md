## install

Everything was installed in /tmp/sherpa-probe/venv. Nothing under /home/bb/.bb/plugins/gigaam was modified; its uv binary was only executed.

```
UV=/home/bb/.bb/plugins/gigaam/host-data/bin/uv        # uv 0.13.0 (x86_64-unknown-linux-musl)
$UV venv /tmp/sherpa-probe/venv --python 3.12          # took 0.09 s, used /usr/bin/python3.12 (CPython 3.12.3)
$UV pip install --python /tmp/sherpa-probe/venv/bin/python sherpa-onnx numpy   # 0.69 s wall
```

Resolved packages:
- sherpa-onnx==1.13.8: wheel sherpa_onnx-1.13.8-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl, 4,400,575 B. Its only dependency is sherpa-onnx-core==1.13.8.
- sherpa-onnx-core==1.13.8: wheel sherpa_onnx_core-1.13.8-py3-none-manylinux2014_x86_64.whl, 10,642,497 B.
- numpy==2.5.4: about 16 MiB wheel.

Package info:
- sherpa_onnx.git_sha1 is 11afbd00 (built Thu Sep 10 2026).
- sherpa_onnx.onnxruntime_version is "1.28.2". onnxruntime is bundled as lib/libonnxruntime.so, so there is no separate onnxruntime pip package and no torch.
- numpy is not a declared dependency of sherpa-onnx, but you need it to pass arrays. Pin it explicitly.
- The venv has no pip module; use `uv pip`.

Sizes:
- Whole venv: 100-102 MB (du -sh).
- site-packages/sherpa_onnx: 38 MB, plus sherpa_onnx.libs 5.3 MB.
- numpy: 30 MB, plus numpy.libs 27 MB.
- Downloaded models: 279 MB in /tmp/sherpa-probe/models, but that includes 9 candidate speaker models. A production set is about 43 MB: silero_vad_v5 (2.3 MB) plus titanet_small (40 MB).

Other tools:
- espeak-ng 1.51 was installed with `sudo -n apt-get install -y espeak-ng`.
- ffmpeg was already at /usr/bin/ffmpeg.

## vadApi

Main VAD scripts:
- /tmp/sherpa-probe/vad_test.py: streams a growing file. A writer thread appends dialog.wav to growing.wav, with a 0xFFFFFFFF-size WAV header, at 8x real time. The reader tails it, reads 0.5 s chunks and pops segments as they finish.
- /tmp/sherpa-probe/vad_sweep.py: compares VAD models and parameters.
- /tmp/sherpa-probe/vad_maxspeech_test.py: shows how max_speech_duration behaves.

Classes and fields:
- sherpa_onnx.VadModelConfig has: silero_vad (SileroVadModelConfig), ten_vad (TenVadModelConfig), sample_rate=16000, num_threads=1, provider='cpu', debug=False, and validate().
- SileroVadModelConfig(model, threshold=0.5, min_silence_duration=0.5, min_speech_duration=0.25, window_size=512, max_speech_duration=20). repr() also shows neg_threshold=-1, but it is not settable from Python. -1 means the default hysteresis: once speech is triggered, it stays speech while prob > threshold-0.15.
- TenVadModelConfig has the same fields, with window_size=256.
- sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60) has methods accept_waveform(samples), empty(), front (a property returning SpeechSegment), pop(), flush(), reset(), is_speech_detected(), and current_segment (the in-progress SpeechSegment, for live partials).
- SpeechSegment.start is an int sample index counted from VAD creation or the last reset(). SpeechSegment.samples is a Python list of float.
- Low-level per-window decisions (no raw probability): sherpa_onnx.VadModel.create(cfg), with .is_speech(win512), .window_size(), .min_silence_duration_samples().

Working code (from vad_test.py / pipeline_demo.py):
```python
import numpy as np, sherpa_onnx
SR, WINDOW = 16000, 512
cfg = sherpa_onnx.VadModelConfig()
cfg.silero_vad.model = "/tmp/sherpa-probe/models/silero_vad_v5.onnx"
cfg.silero_vad.threshold = 0.4             # speech-prob threshold
cfg.silero_vad.min_silence_duration = 0.4  # s of silence that closes a segment
cfg.silero_vad.min_speech_duration = 0.25  # s; shorter blips dropped
cfg.silero_vad.max_speech_duration = 20.0  # s; SOFT cap (see gotchas)
cfg.silero_vad.window_size = 512           # 32 ms @16k; silero requires 512
cfg.sample_rate = SR
cfg.num_threads = 1
assert cfg.validate()
vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)

def drain(out):
    while not vad.empty():
        seg = vad.front
        start = seg.start / SR
        samples = np.asarray(seg.samples, dtype=np.float32)
        out.append((start, start + len(samples) / SR, samples))
        vad.pop()

# tail loop: chunk = 0.5 s float32 [-1,1] read from the growing file
for i in range(0, len(chunk), WINDOW):     # FEED 512-SAMPLE WINDOWS, NOT THE WHOLE CHUNK
    vad.accept_waveform(chunk[i:i + WINDOW])
drain(segments)
# end of input:
vad.flush()          # finalizes the open trailing segment
drain(segments)
```
- Leftover pieces shorter than 512 samples can be passed in; the VAD buffers them internally.
- Live partial: `if vad.is_speech_detected(): cs = vad.current_segment` gives cs.start and cs.samples of speech so far.

The tail reader (WavTailReader in vad_test.py) parses RIFF chunks once to find the 'data' offset, then reads newly appended bytes and keeps an odd trailing byte for the next read.

Results, streaming, 0.5 s chunks fed as windows:
- silero_vad_v5 (th 0.4, min_sil 0.4) gave 9/9 segments matching the 9 ground-truth utterances on all four test files. Example from dialog.wav: 0.77-5.17 (gt 0.80-5.08), 5.92-10.64, 11.26-15.86, 16.99-23.54, 24.03-27.44, 28.35-32.37, 33.21-37.42, 37.82-41.07, 41.98-45.94.
- Boundaries are within about 0.1 s of ground truth.
- A segment is emitted about 0.5-1.0 s of audio after it ends (min_silence plus chunk granularity).
- VAD CPU: about 0.45 s for 46 s of audio (RTF about 0.01). RSS: import is about 34 MB; with the VAD loaded, 69 MB.

Comparison on dialog_piper_hard (window feeding, th 0.5):
- silero_vad.onnx from asr-models (643 KB): decisions are identical to silero_vad_v4.onnx, so it is v4. It merged turns across gaps of 0.56-0.9 s even with min_silence 0.1-0.3 (5-7 segments instead of 9), because v4's speech probability decays slowly after speech.
- silero_vad_v5.onnx at ms=0.3 split all 9 turns.
- ten-vad at ms=0.3 gave 8 segments.
- silero_vad.int8 behaved like v4 and was 2x slower.
- On the robotic espeak audio, v5 at th=0.5 dropped the short word "Отлично"; th=0.4 fixed it.
- Recommendation: silero_vad_v5.onnx with threshold 0.4, min_silence 0.4, max_speech 15-20.

## embeddingApi

Scripts: /tmp/sherpa-probe/emb_test.py (model comparison and clustering) and /tmp/sherpa-probe/emb_extra_test.py (minimum length, resampling, threading, memory).

Working code:
```python
import numpy as np, sherpa_onnx
cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model="/tmp/sherpa-probe/models/nemo_en_titanet_small.onnx",
    num_threads=1, debug=False, provider="cpu")
assert cfg.validate()
ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)   # ext.dim -> 192

def embed(samples_f32, sr=16000):
    s = ext.create_stream()                      # an OnlineStream
    s.accept_waveform(sample_rate=sr, waveform=samples_f32)  # float32 in [-1,1]; resamples if sr != 16k
    s.input_finished()
    if not ext.is_ready(s):
        return None
    e = np.asarray(ext.compute(s), dtype=np.float32)   # returns a Python list, NOT normalized (norm ~0.92)
    return e / np.linalg.norm(e)
```

Model choice: **nemo_en_titanet_small.onnx** (40.3 MB, 192-dim, load 0.2-0.4 s, RSS +92 MB):
- It is the fastest: about 85 ms per 4 s segment and about 30 ms per 1.5 s window on 1 thread (RTF 0.02).
- On whole-segment embeddings it had the largest same-vs-different margins: piper +0.55, piper_hard (two male voices) +0.47, espeak +0.62, espeak_hard +0.18.

Runner-up: **3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx** (28.3 MB, 192-dim, about 95 ms per segment, RSS +60 MB):
- Margins were +0.48, +0.48, +0.46 and +0.09.
- Its usable thresholds were the most consistent across test sets.

Others:
- eres2net_base_sv_zh-cn_3dspeaker (39.6 MB, 512-dim) had good margins (+0.55/+0.54/+0.60/+0.23) but is 2.7x slower (230-260 ms per segment).
- Avoid both voxceleb CAM++ models (3dspeaker_speech_campplus_sv_en_voxceleb_16k and wespeaker_en_voxceleb_CAM++): margins were negative (-0.3 to -0.7) on every test file.
- Avoid the wespeaker resnet34 and resnet34_LM models: they could not separate similar voices (margins -0.03 to -0.07 on the hard sets).

Timing scaling:
- The num_threads setting (intra-op) scales poorly: titanet went from 88 ms (1 thread) to 64 ms (2) to 54 ms (4).
- A Python ThreadPoolExecutor sharing ONE extractor scales almost linearly: compute releases the GIL, the extractor is thread-safe, and results were identical. For 60 x 1.5 s windows: 1.72 s sequential, 0.48 s with 4 threads (x3.6), 0.32 s with 8 threads (x5.4).

Minimum length:
- is_ready() returns True even for 0.05 s of audio, and eres2net returned NaN at 0.05 s.
- Similarity to the same speaker's 4 s embedding grows with length: 0.5 s gives 0.52, 1.0 s gives 0.72, 1.5 s gives 0.81, 2 s gives 0.94.
- So set your own minimum (at least 1.0 s; 1.5-2 s is better).

Input sample rate: models expect 16 kHz. 48 kHz input is resampled internally (cosine 1.000 against native 16k) but prints a "Creating a resampler" log line to stderr. 8 kHz input degrades the embedding (cosine 0.59-0.73).

## clustering

The working numpy-only clustering is average-linkage agglomerative on cosine similarity over L2-normalized embeddings (in emb_test.py and pipeline_demo.py):
```python
def agglomerative(embs, threshold):
    X = embs / np.linalg.norm(embs, axis=1, keepdims=True)
    n = len(X); S = (X @ X.T).astype(np.float64); np.fill_diagonal(S, -np.inf)
    size, active, members = np.ones(n), np.ones(n, bool), {i: [i] for i in range(n)}
    while active.sum() > 1:
        Sm = np.where(active[:, None] & active[None, :], S, -np.inf)
        i, j = np.unravel_index(np.argmax(Sm), Sm.shape)
        if Sm[i, j] < threshold: break
        S[i, :] = (size[i]*S[i, :] + size[j]*S[j, :]) / (size[i] + size[j]); S[:, i] = S[i, :]; S[i, i] = -np.inf
        size[i] += size[j]; active[j] = False; S[j, :] = S[:, j] = -np.inf
        members[i] += members.pop(j)
    lab = np.empty(n, int)
    for k, (_, idx) in enumerate(sorted(members.items(), key=lambda kv: min(kv[1]))): lab[idx] = k
    return lab
```

Online, streaming-friendly variant: assign a segment to the nearest running centroid (the sum of normalized embeddings) if cosine >= threshold, otherwise create a new speaker. pipeline_demo.py uses it live, then re-clusters offline at the end.

Built-in clustering is exposed in Python:
```python
fc = sherpa_onnx.FastClustering(sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5, compute_confidence=False))
labels = fc(np.ascontiguousarray(E, dtype=np.float32))   # 2-D float32 (N, dim) -> list[int]
```
- It is complete-linkage on cosine DISTANCE (1 - similarity). `threshold` is a distance cutoff (verified: a larger threshold gives fewer clusters).
- With num_clusters=k > 0 it ignores the threshold and cuts into k clusters. That gave the best accuracy whenever the speaker count was known.
- sherpa_onnx.SpeakerEmbeddingManager(dim) also exists, with add(name, emb or list of embs), search(emb, threshold) -> name or "", verify, score, remove. It suits enrolled or known speakers.

Results (frame-level accuracy over ground-truth speech, best label permutation):
- Whole VAD segments (silero v5, 9 per file), titanet_small, average linkage: 2 speakers and 100% accuracy on both Piper files (99.5% and 98.6% on the espeak files, where the shortfall is VAD edges) for thresholds 0.65-0.75 on all four files.
  - The easy files work from 0.3 to 0.75. espeak_hard needs at least 0.65. At 0.8 some files over-split.
  - **Recommended: average-linkage cosine-similarity threshold 0.7 for whole segments of 2 s or more.**
  - campplus_adv: 0.65-0.75 works on all four. eres2net_base: 0.5-0.75.
- 1.5 s sub-windows (hop 0.75 s), needed when VAD merges speakers. With the v4 silero_vad.onnx merged segments, window clustering still reached 0.97-1.0 accuracy.
  - Similarities drop for short windows, so the threshold must be lower.
  - titanet: 0.3-0.5 on Piper and espeak_easy, but espeak_hard needs 0.6. campplus_adv: 0.5 works on all four.
  - **Recommended for 1.5 s windows: about 0.5** (FastClustering distance threshold about 0.5-0.7).
- Online centroid on segments: titanet works at 0.4-0.75 on three files and at 0.7 or more on espeak_hard. **pipeline_demo uses 0.6 online plus a final offline average linkage at 0.7.** It gave all 9 segments correct on piper_hard, piper and espeak dialog.
- FastClustering on titanet segments: distance threshold 0.2-0.4 worked on all files (distance 0.5 or more merged espeak_hard). On windows it needs about 0.7.

All of these are synthetic TTS voices. Re-tune on real meeting audio; expect real-world thresholds to be lower (about 0.5-0.6). Use num_clusters when the speaker count is known.

## models

```json
[
  {
    "name": "silero_vad_v5.onnx (RECOMMENDED VAD)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx",
    "bytes": 2313101,
    "sha256": "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396"
  },
  {
    "name": "silero_vad.onnx (requested default; behaves exactly like v4, merges turns)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    "bytes": 643854,
    "sha256": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
  },
  {
    "name": "silero_vad_v4.onnx",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v4.onnx",
    "bytes": 1807522,
    "sha256": "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"
  },
  {
    "name": "silero_vad.int8.onnx",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.int8.onnx",
    "bytes": 212860,
    "sha256": "c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20"
  },
  {
    "name": "ten-vad.onnx",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.onnx",
    "bytes": 332211,
    "sha256": "718cb7eef47e3cf5ddbe7e967a7503f46b8b469c0706872f494dfa921b486206"
  },
  {
    "name": "nemo_en_titanet_small.onnx (RECOMMENDED speaker model, dim 192)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
    "bytes": 40257283,
    "sha256": "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e"
  },
  {
    "name": "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx (runner-up, dim 192)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "bytes": 28281164,
    "sha256": "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"
  },
  {
    "name": "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx (good margins, 2.7x slower, dim 512)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    "bytes": 39593761,
    "sha256": "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"
  },
  {
    "name": "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx (dim 512)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx",
    "bytes": 39593765,
    "sha256": "e2d2048292e055f7b61cdec3db010503f35369b245bf0b3bbad021c9a91e4053"
  },
  {
    "name": "3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx (dim 192)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
    "bytes": 26485263,
    "sha256": "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5"
  },
  {
    "name": "wespeaker_en_voxceleb_resnet34.onnx (weak on similar voices, dim 256)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx",
    "bytes": 26534365,
    "sha256": "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94"
  },
  {
    "name": "wespeaker_en_voxceleb_resnet34_LM.onnx (dim 256)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    "bytes": 26530550,
    "sha256": "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"
  },
  {
    "name": "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx (AVOID: negative margin)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    "bytes": 29596978,
    "sha256": "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b"
  },
  {
    "name": "wespeaker_en_voxceleb_CAM++.onnx (AVOID: negative margin)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx",
    "bytes": 29292684,
    "sha256": "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef"
  },
  {
    "name": "vits-piper-ru_RU-ruslan-medium-int8.tar.bz2 (test-audio TTS only)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-ruslan-medium-int8.tar.bz2",
    "bytes": 21127907,
    "sha256": "93b9f8c7b34c1420bdc253a0ce5ab1cb6b6be2e8fa26c1f3b36c6189233c3e7e"
  },
  {
    "name": "vits-piper-ru_RU-irina-medium-int8.tar.bz2 (test-audio TTS only)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-irina-medium-int8.tar.bz2",
    "bytes": 21149417,
    "sha256": "b0000a509f7551a80742eed5c43b8eb03f469cb9f0a42f6feee96ce0da0ebab8"
  },
  {
    "name": "vits-piper-ru_RU-denis-medium-int8.tar.bz2 (test-audio TTS only)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-denis-medium-int8.tar.bz2",
    "bytes": 21058905,
    "sha256": "d710e29eb7854c42461d16d65d3cef753cc559639ca75806edc75ba71f23af66"
  },
  {
    "name": "vits-piper-ru_RU-dmitri-medium-int8.tar.bz2 (test-audio TTS only)",
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-dmitri-medium-int8.tar.bz2",
    "bytes": 21129441,
    "sha256": "7636793307f634ce54c6e65528a91a61683114f1a6635a08caf64ba6c54e6a63"
  }
]
```

## gigaamHttp

Port: `bb gigaam status --json` returned {"mode":"managed","phase":"ready","model":"v3_e2e_rnnt","threads":0,"port":38271,...}. GET /health returned {"ready":true,"model":"v3_e2e_rnnt","threads":5}; threads 0 means half the cores.

Server behaviour (read-only look at /home/bb/.bb/plugins/gigaam/host-data/gigaam_server.py):
- Fields are file (required) and response_format ("json" returns {"text": ...}; "text" returns text/plain).
- Any format ffmpeg can decode is accepted. Uploads are limited to 25 MB (413 above that).
- Audio shorter than 0.1 s returns "".
- Audio longer than 20 s is split internally at the quietest point between 12 and 20 s and decoded as one batch.
- Inference runs under a global lock, so concurrent requests are serialized: 6 segments took 3.01 s sequentially and 3.63 s with 6 parallel requests.

Working stdlib-only client (gigaam_test.py):
```python
import io, json, subprocess, urllib.request, urllib.error, uuid, wave
import numpy as np
def gigaam_port():
    st = json.loads(subprocess.run(["bb","gigaam","status","--json"], capture_output=True, text=True, check=True, timeout=30).stdout)
    if st.get("phase") != "ready": raise RuntimeError(st)
    return int(st["port"])
def wav_bytes(x, sr=16000):                     # float32 [-1,1] -> in-memory 16-bit PCM WAV
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()
def multipart(fields, files):
    b = "----sherpaprobe" + uuid.uuid4().hex; crlf = b"\r\n"; body = io.BytesIO()
    for k, v in fields.items():
        body.write(f"--{b}".encode()+crlf+f'Content-Disposition: form-data; name="{k}"'.encode()+crlf+crlf+str(v).encode()+crlf)
    for k, (fn, data, ct) in files.items():
        body.write(f"--{b}".encode()+crlf+f'Content-Disposition: form-data; name="{k}"; filename="{fn}"'.encode()+crlf)
        body.write(f"Content-Type: {ct}".encode()+crlf+crlf+data+crlf)
    body.write(f"--{b}--".encode()+crlf)
    return body.getvalue(), f"multipart/form-data; boundary={b}"
def transcribe(port, wav, timeout=120.0):
    body, ctype = multipart({"response_format": "json"}, {"file": ("segment.wav", wav, "audio/wav")})
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/audio/transcriptions", data=body, method="POST",
                                 headers={"Content-Type": ctype, "Content-Length": str(len(body))})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))["text"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from None
```

Output on dialog_piper_hard.wav (each VAD segment POSTed separately):
```
[  0.77-  4.75] 4.0s 517 ms CER 0.00 Добрый день, коллеги. Давайте начнём наше совещание по проекту.
[  5.50-  9.78] 4.3s 515 ms CER 0.00 Здравствуйте. Я подготовила отчёт о результатах тестирования за прошлую неделю.
[ 10.30- 14.90] 4.6s 492 ms CER 0.00 Отлично. Расскажите, пожалуйста, какие основные проблемы вы обнаружили?
[ 15.93- 21.90] 6.0s 595 ms CER 0.07 Главная проблема в том, что сервер иногда не отвечает под нагрузкой. Мы зафиксировали около 20 таких случаев.
[ 22.33- 25.52] 3.2s 401 ms Понятно, сколько времени потребуется на исправление?
[ 26.46- 29.58] 3.1s 496 ms Думаю, примерно три дня, если никто не будет отвлекать команду.
[ 30.33- 34.42] 4.1s 500 ms Хорошо, тогда назначим срок на пятницу. Есть ещё вопросы?
[ 34.91- 38.10] 3.2s 403 ms Да, нужно обсудить бюджет на новое оборудование для лаборатории.
[ 38.97- 43.06] 4.1s 485 ms Давайте вернёмся к этому вопросу завтра утром. Всем спасибо.
```
- Mean latency was 489 ms per segment (max 595 ms; the first request after idle was about 1.1 s). RTF about 0.12. Mean CER 0.008. The only error is that numbers are normalized ("двадцати" becomes "20").
- dialog_piper.wav gave mean CER 0.010.
- Whole-file single requests take about 0.1 s per audio second: 10 s took 1.14 s, 20 s took 2.08 s, 30 s took 3.02 s, and the 46.5 s file took 4.1 s.
- On the espeak-ng audio (dialog.wav) GigaAM returned "" for 4 of 9 segments (mean CER 0.58). That is a TTS-quality problem, not a client problem; the same client works perfectly on the Piper audio.

## testAudio

All files are 16 kHz mono s16 WAV in /tmp/sherpa-probe. Each has a ground-truth JSON next to it ({sample_rate, duration, voices, segments: [{speaker, start, end, text}]}).

Every file is the same 9-utterance A/B/A/... Russian meeting dialogue with:
- 0.8 s of lead-in silence
- 0.5-1.5 s gaps (random.Random(7))
- utterance silence trimmed at |x| > 0.01, so ground-truth boundaries are tight
- about -55 dBFS white noise added

Files:
1. dialog.wav (46.4 s) and dialog_gt.json, as requested. espeak-ng 1.51; A is `-v ru+m3 -p 35 -s 145`, B is `-v ru+f4 -p 75 -s 170`. Each utterance is piped through ffmpeg (`-ar 16000 -ac 1 -f s16le`). Script: make_dialog.py.
2. dialog_hard.wav and dialog_hard_gt.json: two similar male espeak voices (`ru+m1 -p 45 -s 150` vs `ru+m7 -p 50 -s 160`). Made with `make_dialog.py --voice-a ... --voice-b ... --out ...`.
3. dialog_piper.wav (46.5 s) and dialog_piper_gt.json: sherpa-onnx OfflineTts with the Piper VITS int8 voices ru_RU-ruslan (A, speed 0.95) and ru_RU-irina (B, speed 1.1). Resampled from 22.05 kHz with ffmpeg. Script: make_dialog_piper.py. Voices are in /tmp/sherpa-probe/tts.
4. dialog_piper_hard.wav (43.5 s) and dialog_piper_hard_gt.json: two male Piper voices, denis vs dmitri (`--a denis --b dmitri`).

**Use the Piper files for ASR tests.** GigaAM transcribes them with CER about 0.01 but cannot recognize much of the robotic espeak Russian. Both TTS engines give clean speaker separation.

TTS snippet that worked:
`sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=.../ru_RU-irina-medium.onnx, tokens=.../tokens.txt, data_dir=.../espeak-ng-data), num_threads=4), max_num_sentences=1)).generate(text, sid=0, speed=1.0)`, which returns .samples and .sample_rate (22050).

vad_segments.json holds the last VAD output from vad_test.py.

## gotchas

1. **Feed the VAD 512-sample windows, not whole 0.5 s chunks.**
   - accept_waveform() runs every window in the call but ORs the per-window decisions into a single speech/non-speech result per call. It also computes the segment start and end from the buffer tail.
   - Passing an 8000-sample chunk in one call merged 9 utterances into 3-5 segments of up to 25 s, with starts about 0.35 s late.
   - Read the file in 0.5 s chunks, but loop `for i in range(0, len(chunk), 512): vad.accept_waveform(chunk[i:i+512])`.
2. **The default asr-models silero_vad.onnx behaves exactly like silero v4.** It keeps speech going through 0.5-0.9 s gaps regardless of min_silence (even 0.1 s), so speaker turns merge.
   - silero_vad_v5.onnx with threshold 0.4 and min_silence 0.4 split every turn.
   - In real meetings turn gaps are often under 0.3 s, so do not rely on VAD alone for speaker boundaries. Use sub-windows of 1.5 s (hop 0.75 s) inside long segments for diarization when needed.
3. **max_speech_duration is a SOFT cap.** Once a segment exceeds it, the VAD switches to min_silence 0.1 s and threshold 0.9 and cuts at the next short dip. Segments can still exceed it: 10.97 s with max 5, and 21.08 s with max 20.
   - Enforce a hard cut yourself if you need one. The GigaAM server handles longer input anyway (it splits over 20 s internally; the model's own limit is 25 s).
4. **Segment indexing and buffer size.**
   - SpeechSegment.start is in samples since VAD creation or reset(); reset() restarts it at 0, so keep your own offset when tailing across resets.
   - .samples is a Python list; convert with np.asarray(..., np.float32).
   - buffer_size_in_seconds (default 60) must exceed max_speech_duration.
   - Call flush() at end of input, otherwise the trailing segment is lost.
5. **sample_rate must match.** VadModelConfig.sample_rate must equal the input rate (16000; silero window 512, ten-vad window 256). The VAD does not resample. The speaker OnlineStream.accept_waveform(sample_rate, x) does resample, but logs a "Creating a resampler" message to stderr. Audio must be float32 in [-1, 1].
6. **Embedding output.** Embeddings are returned as a Python list and are NOT L2-normalized; normalize them before cosine similarity.
   - is_ready() is True even for 0.05 s, and eres2net returned NaN there. Enforce a minimum length of at least 1.0 s and check np.isfinite.
   - Shorter segments give lower similarity (0.5 s: 0.52; 1 s: 0.72; 2 s: 0.94 against the same speaker), so the clustering threshold depends on segment length: about 0.7 for whole segments, about 0.5 for 1.5 s windows.
   - For segments that are too short, inherit the previous speaker.
7. **Threads.**
   - Extractor num_threads (intra-op) scales poorly: 1 to 4 threads is only 1.6x.
   - compute() releases the GIL, and one shared extractor is thread-safe. A ThreadPoolExecutor with num_threads=1 scaled x3.6 at 4 threads and x5.4 at 8, with identical outputs.
   - VAD num_threads=1 is enough (RTF 0.01).
   - CPU budget: GigaAM already uses 5 torch threads (half of 10 cores), so leave about 4 cores for VAD plus embeddings.
8. **Memory (RSS).** Python plus numpy plus sherpa_onnx: 34 MB. Plus VAD v5: 69 MB. Plus titanet_small: about 130 MB, peaking around 220 MB under 8-thread parallel compute. campplus_adv: about 98 MB. eres2net_base: about 153 MB.
9. **GigaAM server limits.** It serializes requests under a lock (parallel POSTs give no speed-up), has a 25 MB upload limit, and returns "" for audio under 0.1 s. Numbers come back as digits and punctuation is included (e2e model). The first request after idle is about 2x slower.
10. **API details.**
   - FastClustering's threshold is a cosine DISTANCE with complete linkage; it is not a similarity.
   - SileroVadModelConfig has a hidden neg_threshold (-1 means threshold-0.15 hysteresis) that is not settable from Python.
   - sherpa-onnx 1.13.8 split into sherpa-onnx (4.4 MB) plus sherpa-onnx-core (10.6 MB) and does not declare numpy, so install numpy explicitly.
11. **Model quality.** The two voxceleb CAM++ models and the wespeaker resnet34 models performed badly here; prefer titanet_small or campplus_zh_en_advanced. All conclusions come from synthetic TTS voices, so re-tune thresholds on real Russian meeting audio.
12. **Running scripts.** They were run with `python -I` (isolated mode) from /tmp. Downloaded archives and models are kept in models/, tts/ and dl/, separate from the scripts.

## scriptPaths

```json
[
  "/tmp/sherpa-probe/vad_test.py",
  "/tmp/sherpa-probe/emb_test.py",
  "/tmp/sherpa-probe/gigaam_test.py",
  "/tmp/sherpa-probe/pipeline_demo.py",
  "/tmp/sherpa-probe/emb_extra_test.py",
  "/tmp/sherpa-probe/vad_sweep.py",
  "/tmp/sherpa-probe/vad_maxspeech_test.py",
  "/tmp/sherpa-probe/make_dialog.py",
  "/tmp/sherpa-probe/make_dialog_piper.py",
  "/tmp/sherpa-probe/voice_probe.py",
  "/tmp/sherpa-probe/scratch/gigaam_concurrency.py",
  "/tmp/sherpa-probe/scratch/vad_sweep_piper.py",
  "/tmp/sherpa-probe/dialog.wav",
  "/tmp/sherpa-probe/dialog_gt.json",
  "/tmp/sherpa-probe/dialog_hard.wav",
  "/tmp/sherpa-probe/dialog_hard_gt.json",
  "/tmp/sherpa-probe/dialog_piper.wav",
  "/tmp/sherpa-probe/dialog_piper_gt.json",
  "/tmp/sherpa-probe/dialog_piper_hard.wav",
  "/tmp/sherpa-probe/dialog_piper_hard_gt.json",
  "/tmp/sherpa-probe/models",
  "/tmp/sherpa-probe/venv"
]
```
