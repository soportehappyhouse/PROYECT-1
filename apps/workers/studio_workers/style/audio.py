"""Audio side of the style analysis (FFmpeg filters + standard library).

- Loudness: EBU R128 integrated loudness (``ebur128``), the number platforms normalize to.
- Silence ratio: ``silencedetect`` at -35 dB / 300 ms (the same detector «Cortar silencios» uses).
- Speech ratio: from the transcript when there is one (merged segment time / duration);
  otherwise an ENERGY HEURISTIC: 0.5 s windows of 50 ms RMS frames (``astats``); speech is
  "active and strongly modulated" (syllables: the RMS jumps >= ``SPEECH_STD_DB`` dB inside the
  window) and not noise-like (spectral flatness < ``NOISE_FLATNESS``).
- Music: HEURISTIC on spectral flatness (``aspectralstats``) + modulation: music beds are steady
  (RMS std < ``STEADY_STD_DB``) and tonal (flatness < ``MUSIC_FLATNESS``). ``music_detected`` is
  true when such windows are >= ``MUSIC_SHARE`` of the active ones. ``null`` when there is no
  audio or FFmpeg lacks ``aspectralstats`` (FFmpeg < 5.1).

Both heuristics are rough by design: they tell "talking head with a music bed" from "music only"
or "voice only", which is what the preset needs (duck the music, cut silences or not).
"""

from __future__ import annotations

import math
import re
import subprocess
from pathlib import Path
from statistics import median, pstdev
from typing import Any

from ..analyze import run_silencedetect
from ..vision.frames import ffmpeg_exe

FRAME_S = 0.05
WINDOW_FRAMES = 10  # 0.5 s
ACTIVE_DB = -50.0
SPEECH_STD_DB = 3.5
STEADY_STD_DB = 3.0
NOISE_FLATNESS = 0.6
MUSIC_FLATNESS = 0.45
MUSIC_SHARE = 0.3
SILENCE_DB = -35.0
SILENCE_MS = 300

_LUFS = re.compile(r"^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS", re.M)
_KV = re.compile(r"^(lavfi\.[\w.]+)=(\S+)", re.M)
_PTS = re.compile(r"pts_time:([\d.]+)")


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-nostats", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )  # fmt: skip


def parse_lufs(stderr: str) -> float | None:
    """Integrated loudness from the ebur128 summary (the last 'I:' line)."""
    found = _LUFS.findall(stderr)
    if not found:
        return None
    value = found[-1]
    return None if value == "-inf" else round(float(value), 1)


def loudness_lufs(path: Path) -> float | None:
    proc = _run(["-i", str(path), "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg ebur128 falló: {proc.stderr.strip()[-300:]}")
    return parse_lufs(proc.stderr)


def _db(value: str) -> float:
    try:
        v = float(value)
    except ValueError:
        return -90.0
    return -90.0 if math.isinf(v) or math.isnan(v) else max(-90.0, v)


def parse_metadata(text: str, key: str) -> list[tuple[float, str]]:
    """(pts_time, value) of ``key`` in ``ametadata=print`` output."""
    out: list[tuple[float, str]] = []
    t = 0.0
    for line in text.splitlines():
        if m := _PTS.search(line):
            t = float(m.group(1))
        elif (m := _KV.match(line.strip())) and m.group(1) == key:
            out.append((t, m.group(2)))
    return out


def rms_envelope(path: Path) -> list[float]:
    """RMS (dBFS) of consecutive 50 ms frames, mono 16 kHz."""
    n = int(16000 * FRAME_S)
    key = "lavfi.astats.Overall.RMS_level"
    proc = _run(
        ["-loglevel", "error", "-i", str(path), "-vn", "-af",
         f"aresample=16000,aformat=channel_layouts=mono,asetnsamples=n={n}:p=0,"
         f"astats=metadata=1:reset=1,ametadata=print:key={key}:file=-",
         "-f", "null", "-"]
    )  # fmt: skip
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg astats falló: {proc.stderr.strip()[-300:]}")
    return [_db(v) for _t, v in parse_metadata(proc.stdout, key)]


def flatness_track(path: Path) -> list[tuple[float, float]] | None:
    """(t, spectral flatness 0-1) every 128 ms; None when FFmpeg has no aspectralstats."""
    key = "lavfi.aspectralstats.1.flatness"
    proc = _run(
        ["-loglevel", "error", "-i", str(path), "-vn", "-af",
         "aresample=16000,aformat=channel_layouts=mono,"
         f"aspectralstats=win_size=2048:overlap=0:measure=flatness,ametadata=print:key={key}:file=-",
         "-f", "null", "-"]
    )  # fmt: skip
    if proc.returncode != 0:
        return None
    out = []
    for t, v in parse_metadata(proc.stdout, key):
        try:
            f = float(v)
        except ValueError:
            continue
        if not math.isnan(f):
            out.append((t, max(0.0, min(1.0, f))))
    return out


def classify_windows(
    rms: list[float], flatness: list[tuple[float, float]] | None
) -> list[dict[str, Any]]:
    """Per 0.5 s window: {t, active, std_db, flatness, speech, music} (see module doc)."""
    windows = []
    for k in range(0, len(rms) - WINDOW_FRAMES + 1, WINDOW_FRAMES):
        frames = rms[k : k + WINDOW_FRAMES]
        t0 = k * FRAME_S
        t1 = t0 + WINDOW_FRAMES * FRAME_S
        active = sum(1 for x in frames if x > ACTIVE_DB) >= WINDOW_FRAMES * 0.6
        std = pstdev(frames)
        flat_vals = [f for t, f in flatness or [] if t0 <= t < t1]
        flat = median(flat_vals) if flat_vals else None
        noise_like = flat is not None and flat >= NOISE_FLATNESS
        speech = active and std >= SPEECH_STD_DB and not noise_like
        music = active and flat is not None and std < STEADY_STD_DB and flat < MUSIC_FLATNESS
        windows.append(
            {
                "t": round(t0, 2),
                "active": active,
                "std_db": round(std, 2),
                "flatness": None if flat is None else round(flat, 4),
                "speech": speech,
                "music": music,
            }
        )
    return windows


def merged_coverage(segments: list[dict[str, Any]], duration: float) -> float:
    """Seconds covered by the union of [start, end] segments (clipped to the duration)."""
    spans = sorted(
        (max(0.0, float(s["start"])), min(duration, float(s["end"])))
        for s in segments
        if float(s["end"]) > float(s["start"])
    )
    total = 0.0
    cur: list[float] | None = None
    for s, e in spans:
        if cur is None or s > cur[1]:
            if cur is not None:
                total += cur[1] - cur[0]
            cur = [s, e]
        else:
            cur[1] = max(cur[1], e)
    if cur is not None:
        total += cur[1] - cur[0]
    return total


def audio_profile(
    path: Path,
    duration: float,
    has_audio: bool,
    transcript: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """StyleAnalysis.audio (+ the per-window classification under ``windows`` for debugging)."""
    if not has_audio or duration <= 0:
        return {
            "has_audio": False,
            "loudness_lufs": None,
            "speech_ratio": None,
            "music_detected": None,
            "silence_ratio": None,
            "speech_method": None,
            "music_method": None,
        }
    lufs = loudness_lufs(path)
    silences, _total = run_silencedetect(path, SILENCE_DB, SILENCE_MS)
    silent = sum(e - s for s, e in silences)
    rms = rms_envelope(path)
    flat = flatness_track(path)
    windows = classify_windows(rms, flat)
    active = [w for w in windows if w["active"]]
    if transcript:
        speech_ratio = merged_coverage(transcript, duration) / duration
        speech_method = "transcript"
    else:
        speech_ratio = (sum(1 for w in windows if w["speech"]) / len(windows)) if windows else 0.0
        speech_method = "energy-modulation-heuristic"
    if flat is None:
        music: bool | None = None
        music_method = "unavailable (FFmpeg sin aspectralstats)"
    else:
        share = (sum(1 for w in active if w["music"]) / len(active)) if active else 0.0
        music = bool(windows) and len(active) >= 0.2 * len(windows) and share >= MUSIC_SHARE
        music_method = "spectral-flatness-heuristic"
    return {
        "has_audio": True,
        "loudness_lufs": lufs,
        "speech_ratio": round(min(1.0, max(0.0, speech_ratio)), 3),
        "music_detected": music,
        "silence_ratio": round(min(1.0, silent / duration), 3),
        "speech_method": speech_method,
        "music_method": music_method,
    }
