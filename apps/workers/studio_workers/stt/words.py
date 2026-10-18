"""Sprint 6 M1 «Guion editable por palabras»: task ``stt.words`` (sprint6-contratos.md, M1).

faster-whisper with word timestamps and **no VAD** (keeps «eh/em» and the real pauses),
``hallucination_silence_threshold`` (2.0) and ``condition_on_previous_text=False``. After the
transcription the 16 kHz mono WAV (extracted by the api) is read with numpy:

- RMS in dBFS every 5 ms over the whole file -> ``<output_base>/script-rms.f32`` (float32 LE);
- noise floor = 10th percentile of 50 ms windows inside the clip;
- gaps between consecutive words (>= 30 ms) with their mean level and ``voiced`` (>= floor + 10 dB).

Results (source seconds of the input): ``<output_base>/transcript.json`` and ``script-audio.json``.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Any

import numpy as np

from ..config import Settings
from ..schemas import Transcript
from ..task_schema import AudioGap, ScriptAudio, SttWordsRequest
from ..tasks import Task

WINDOW_MS = 5
FLOOR_WINDOW_MS = 50
FLOOR_PERCENTILE = 10
VOICED_DB_OVER_FLOOR = 10.0
MIN_GAP_S = 0.03
SILENCE_DB = -120.0


def mmss(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    return f"{s // 60}:{s % 60:02d}"


def read_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    """PCM WAV -> float32 samples in [-1, 1] (first channel) and the sample rate."""
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        width = w.getsampwidth()
        channels = w.getnchannels()
        raw = w.readframes(w.getnframes())
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"WAV de {width * 8} bits no soportado")
    if channels > 1:
        data = data[::channels]
    return data, rate


def rms_db(samples: np.ndarray, rate: int, window_ms: int = WINDOW_MS) -> np.ndarray:
    """RMS level in dBFS of consecutive windows (the last partial window included)."""
    n = max(1, int(rate * window_ms / 1000))
    count = int(np.ceil(len(samples) / n)) if len(samples) else 0
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    padded = np.zeros(count * n, dtype=np.float32)
    padded[: len(samples)] = samples
    power = np.mean(padded.reshape(count, n) ** 2, axis=1)
    with np.errstate(divide="ignore"):
        db = 10.0 * np.log10(np.maximum(power, 1e-12))
    return np.maximum(db, SILENCE_DB).astype(np.float32)


def noise_floor(db: np.ndarray, a: float, b: float) -> float:
    """10th percentile of 50 ms windows (power-averaged) inside [a, b] seconds."""
    per = FLOOR_WINDOW_MS // WINDOW_MS
    lo = max(0, int(a * 1000 / WINDOW_MS))
    hi = min(len(db), int(np.ceil(b * 1000 / WINDOW_MS)))
    part = db[lo:hi]
    if len(part) == 0:
        return SILENCE_DB
    count = len(part) // per
    if count == 0:
        return float(np.min(part))
    blocks = part[: count * per].reshape(count, per)
    level = 10.0 * np.log10(np.mean(10.0 ** (blocks / 10.0), axis=1))
    return round(float(np.percentile(level, FLOOR_PERCENTILE)), 2)


def mean_db(db: np.ndarray, a: float, b: float) -> float:
    lo = max(0, int(a * 1000 / WINDOW_MS))
    hi = min(len(db), max(lo + 1, int(b * 1000 / WINDOW_MS)))
    part = db[lo:hi]
    if len(part) == 0:
        return SILENCE_DB
    return round(float(10.0 * np.log10(np.mean(10.0 ** (part / 10.0)))), 2)


def word_gaps(transcript: Transcript, db: np.ndarray, floor: float) -> list[AudioGap]:
    words = sorted(
        (w for s in transcript.segments for w in (s.words or [])),
        key=lambda w: (w.start, w.end),
    )
    gaps: list[AudioGap] = []
    for prev, nxt in zip(words, words[1:], strict=False):
        a, b = float(prev.end), float(nxt.start)
        if b - a < MIN_GAP_S:
            continue
        level = mean_db(db, a, b)
        gaps.append(
            AudioGap(
                start=round(a, 3),
                end=round(b, 3),
                rms_db=level,
                voiced=level >= floor + VOICED_DB_OVER_FLOOR,
            )
        )
    return gaps


def clip_transcript(transcript: Transcript, a: float, b: float) -> Transcript:
    """Keep the segments / words that fall inside [a, b] (clip_timestamps may overshoot)."""
    segments = []
    for seg in transcript.segments:
        if seg.end <= a or seg.start >= b:
            continue
        words = None
        if seg.words is not None:
            words = [
                w for w in seg.words if (w.start + w.end) / 2 >= a and (w.start + w.end) / 2 <= b
            ]
        segments.append(seg.model_copy(update={"words": words}))
    return transcript.model_copy(update={"segments": segments})


def run_stt_words(
    task: Task, req: SttWordsRequest, engine: Any, settings: Settings
) -> dict[str, Any]:
    """Body of the ``stt.words`` task (runs in the ``transcribe`` TaskQueue thread)."""
    src = settings.storage_path(req.input_path)
    samples, rate = read_wav_mono(src)
    file_s = len(samples) / float(rate) if rate else 0.0
    a = max(0.0, float(req.clip_in_s or 0.0))
    b = float(req.clip_out_s) if req.clip_out_s is not None else file_s
    b = min(b, file_s) if file_s > 0 else b
    if b <= a:
        a, b = 0.0, file_s
    total = max(1, int(round(b - a)))
    task.set_items(0, total, f"Transcribiendo palabras · 0:00 de {mmss(b - a)}")

    def on_progress(p: float, message: str) -> None:
        done_s = max(0.0, min(1.0, p)) * (b - a)
        if message and message.startswith(("VRAM", "CUDA")):
            task.add_log(message)
        task.set_items(
            int(done_s), total, f"Transcribiendo palabras · {mmss(done_s)} de {mmss(b - a)}"
        )

    clip = None if a <= 0 and abs(b - file_s) < 1e-3 else (a, b)
    transcript = engine.transcribe(
        src,
        model=req.model,
        language=req.language,
        word_timestamps=True,
        vad=False,
        on_progress=on_progress,
        extra={"hallucination_silence_threshold": float(req.hallucination_silence_threshold)},
        clip=clip,
    )
    task.check_canceled()
    transcript = clip_transcript(transcript, a, b)
    task.set_items(total, total, "Midiendo el audio entre palabras")
    db = rms_db(samples, rate)
    floor = noise_floor(db, a, b)
    out_dir = settings.storage_path(req.output_base)
    out_dir.mkdir(parents=True, exist_ok=True)
    rms_path = out_dir / "script-rms.f32"
    rms_path.write_bytes(db.astype("<f4").tobytes())
    audio = ScriptAudio(
        noise_floor_db=floor,
        window_ms=5,
        rms_db_path=settings.storage_relative(rms_path),
        gaps=word_gaps(transcript, db, floor),
    )
    transcript_json = transcript.model_dump(by_alias=True, exclude_none=True)
    (out_dir / "transcript.json").write_text(
        json.dumps(transcript_json, ensure_ascii=False), encoding="utf-8"
    )
    audio_json = audio.model_dump()
    (out_dir / "script-audio.json").write_text(json.dumps(audio_json), encoding="utf-8")
    result: dict[str, Any] = {"transcript": transcript_json, "audio": audio_json}
    if transcript.warnings:
        result["warnings"] = transcript.warnings
    return result
