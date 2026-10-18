"""Deterministic analysis: scene cuts (PySceneDetect) and silence/filler cut plans.

Silences + fillers (docs/INVESTIGACION-IA-LOCAL.md §4): FFmpeg ``silencedetect`` gives the silent
intervals; Whisper word timestamps give the fillers (rioplatense list, §4.3). Cuts get a padding
(kept margin next to speech), adjacent cuts are merged and very short ones dropped. Nothing is
applied here: the api returns the plan and the web shows a review dialog.
"""

from __future__ import annotations

import re
import subprocess
import time
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .media import FfmpegNotFoundError, find_ffmpeg
from .packs import PackRequiredError, module_present

# §4.3 contract list. Sound fillers are always candidates; discourse fillers only when isolated.
SOUND_FILLERS = frozenset({"eh", "ehh", "eeh", "em", "emm", "mm", "mmm", "ah"})
DISCOURSE_FILLERS = frozenset({"este", "o sea", "digamos", "viste", "bueno", "tipo", "nada"})
FILLERS = SOUND_FILLERS | DISCOURSE_FILLERS
ISOLATION_GAP_S = 0.12  # §4.3: a word inside a phrase without pauses is not a filler
STUTTER_MAX_GAP_S = 0.3
MIN_SILENCE_CUT_S = 0.15
MIN_FILLER_CUT_S = 0.05
MERGE_GAP_S = 0.05


# ------------------------------------------------------------------------------------- scenes


def detect_scenes(
    path: Path, threshold: float | None = None, min_scene_len_s: float | None = None
) -> dict[str, Any]:
    if not (module_present("scenedetect") and module_present("cv2")):
        raise PackRequiredError("scenes")
    from scenedetect import (  # noqa: PLC0415 - optional pack
        ContentDetector,
        SceneManager,
        StatsManager,
        open_video,
    )

    started = time.perf_counter()
    video = open_video(str(path))
    fps = float(video.frame_rate) or 25.0
    min_frames = max(1, round((min_scene_len_s if min_scene_len_s is not None else 0.6) * fps))
    stats = StatsManager()
    manager = SceneManager(stats_manager=stats)
    manager.add_detector(
        ContentDetector(
            threshold=threshold if threshold is not None else 27.0, min_scene_len=min_frames
        )
    )
    frames = manager.detect_scenes(video=video)
    raw = manager.get_scene_list(start_in_scene=True)
    key = getattr(ContentDetector, "FRAME_SCORE_KEY", "content_val")
    scenes = []
    for start, end in raw:
        score = 0.0
        frame = start.frame_num
        if frame and stats.metrics_exist(frame, [key]):
            value = stats.get_metrics(frame, [key])[0]
            score = float(value) if value is not None else 0.0
        scenes.append(
            {
                "start": round(start.seconds, 3),
                "end": round(end.seconds, 3),
                "score": round(score, 3),
            }
        )
    elapsed = time.perf_counter() - started
    return {
        "scenes": scenes,
        "fps": round(fps, 3),
        "frames": int(frames),
        "analysis_fps": round(frames / elapsed, 1) if elapsed > 0 else None,
    }


# ----------------------------------------------------------------------------------- silences

_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")
_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def parse_silencedetect(stderr: str) -> tuple[list[tuple[float, float | None]], float | None]:
    """[(start, end|None)], media duration (from the input header) out of ffmpeg's stderr."""
    out: list[tuple[float, float | None]] = []
    pending: float | None = None
    duration: float | None = None
    for line in stderr.splitlines():
        if duration is None and (m := _DURATION.search(line)):
            h, mi, se = m.groups()
            duration = int(h) * 3600 + int(mi) * 60 + float(se)
        if m := _SIL_START.search(line):
            pending = max(0.0, float(m.group(1)))
        elif (m := _SIL_END.search(line)) and pending is not None:
            out.append((pending, float(m.group(1))))
            pending = None
    if pending is not None:
        out.append((pending, None))  # silence runs until the end of the file
    return out, duration


def run_silencedetect(
    path: Path, noise_db: float, min_silence_ms: int
) -> tuple[list[tuple[float, float]], float]:
    exe = find_ffmpeg()
    if not exe:
        raise FfmpegNotFoundError(
            "ffmpeg no encontrado: instalalo (setup.ps1) o defini FFMPEG_PATH en .env"
        )
    filt = f"silencedetect=noise={noise_db}dB:d={max(0.01, min_silence_ms / 1000):.3f}"
    proc = subprocess.run(
        [exe, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", filt, "-f", "null", "-"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg silencedetect fallo: {proc.stderr.strip()[-400:]}")
    raw, duration = parse_silencedetect(proc.stderr)
    total = duration or 0.0
    intervals = [(s, e if e is not None else max(total, s)) for s, e in raw]
    return [(s, e) for s, e in intervals if e > s], total


@dataclass
class Word:
    w: str
    s: float
    e: float

    @property
    def norm(self) -> str:
        return normalize_word(self.w)


def normalize_word(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^\w\s]", "", text).strip()


def _has_trailing_punct(text: str) -> bool:
    return bool(re.search(r"[,.;:?!…]\s*$", text.strip()))


def find_fillers(words: list[Word]) -> list[dict[str, Any]]:
    """Filler words (and immediate stutters) as cut candidates [{start, end, kind, text}]."""
    cuts: list[dict[str, Any]] = []
    n = len(words)
    i = 0
    while i < n:
        w = words[i]
        token = w.norm
        span = 1
        if i + 1 < n and f"{token} {words[i + 1].norm}" in FILLERS:  # "o sea"
            token = f"{token} {words[i + 1].norm}"
            span = 2
        last = words[i + span - 1]
        gap_before = w.s - words[i - 1].e if i > 0 else float("inf")
        gap_after = words[i + span].s - last.e if i + span < n else float("inf")
        if token in SOUND_FILLERS:
            cuts.append(
                _cut(w.s, last.e, "filler", " ".join(x.w.strip() for x in words[i : i + span]))
            )
        elif token in DISCOURSE_FILLERS:
            isolated = gap_before >= ISOLATION_GAP_S and gap_after >= ISOLATION_GAP_S
            # "bueno, ..." / "..., viste?": Whisper's punctuation marks the pause it heard.
            punct = _has_trailing_punct(last.w) and (
                gap_before >= ISOLATION_GAP_S or gap_after >= ISOLATION_GAP_S
            )
            repeated = i + span < n and words[i + span].norm == token
            if isolated or punct or repeated:
                text = " ".join(x.w.strip() for x in words[i : i + span])
                cuts.append(_cut(w.s, last.e, "filler", text))
        elif (
            token
            and i + 1 < n
            and words[i + 1].norm == token
            and words[i + 1].s - w.e <= STUTTER_MAX_GAP_S
        ):
            # Stutter "el el": cut the first occurrence (up to the repetition).
            cuts.append(
                _cut(w.s, words[i + 1].s, "filler", f"{w.w.strip()} {words[i + 1].w.strip()}")
            )
        i += span
    return [c for c in cuts if c["end"] - c["start"] >= MIN_FILLER_CUT_S]


def _cut(start: float, end: float, kind: str, text: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"start": float(start), "end": float(end), "kind": kind}
    if text:
        out["text"] = text
    return out


def pad_silences(
    intervals: Iterable[tuple[float, float]], padding_s: float, duration: float
) -> list[dict[str, Any]]:
    """Keep `padding_s` of silence next to speech (not at the very start/end of the media)."""
    cuts = []
    for s, e in intervals:
        start = s if s <= 0.001 else s + padding_s
        end = e if duration and e >= duration - 0.001 else e - padding_s
        if end - start >= MIN_SILENCE_CUT_S:
            cuts.append(_cut(start, end, "silence"))
    return cuts


def merge_cuts(
    cuts: list[dict[str, Any]], gap_s: float = MERGE_GAP_S, filler_gap_s: float | None = None
) -> list[dict[str, Any]]:
    """Join overlapping/adjacent cuts. Next to a removed filler there is no speech to protect,
    so a filler and a cut closer than `filler_gap_s` (2 x padding) are joined too."""
    merged: list[dict[str, Any]] = []
    for cut in sorted(cuts, key=lambda c: (c["start"], c["end"])):
        gap = gap_s
        if merged and filler_gap_s and "filler" in (cut["kind"], merged[-1]["kind"]):
            gap = max(gap_s, filler_gap_s)
        if merged and cut["start"] <= merged[-1]["end"] + gap:
            prev = merged[-1]
            prev["end"] = max(prev["end"], cut["end"])
            if cut["kind"] == "filler":
                prev["kind"] = "filler"
            texts = [t for t in (prev.get("text"), cut.get("text")) if t]
            if texts:
                prev["text"] = " ".join(dict.fromkeys(texts))
        else:
            merged.append(dict(cut))
    for c in merged:
        c["start"] = round(c["start"], 3)
        c["end"] = round(c["end"], 3)
    return merged


def plan_cuts(
    silences: list[tuple[float, float]],
    duration: float,
    words: list[Word] | None,
    *,
    padding_ms: int,
) -> dict[str, Any]:
    cuts = pad_silences(silences, padding_ms / 1000, duration)
    if words:
        cuts.extend(find_fillers(sorted(words, key=lambda w: w.s)))
    if duration:
        cuts = [{**c, "start": max(0.0, c["start"]), "end": min(duration, c["end"])} for c in cuts]
    filler_gap = 2 * padding_ms / 1000 + MERGE_GAP_S
    merged = [c for c in merge_cuts(cuts, filler_gap_s=filler_gap) if c["end"] > c["start"]]
    total = round(sum(c["end"] - c["start"] for c in merged), 3)
    return {"cuts": merged, "total_removed_s": total, "duration_s": round(duration, 3)}


def words_from_transcript(transcript: Any) -> list[Word]:
    """Flatten a studio Transcript (segments[].words[]) into Word items."""
    out: list[Word] = []
    for seg in getattr(transcript, "segments", None) or []:
        for w in getattr(seg, "words", None) or []:
            out.append(Word(str(w.word), float(w.start), float(w.end)))
    return out


# ------------------------------------------------------------------- import suggestions (S6 M3)
# docs/trabajo/sprint6-contratos.md M3 + fuentes-sprint6.md §3: ONE ffmpeg decode gives the
# loudness (``ebur128=peak=true``: integrated LUFS, LRA, true peak) and an 8 kHz mono PCM stream
# read here in 1 s chunks. From the PCM: the noise floor (10th percentile of the RMS in 50 ms
# windows) and the silences with ``silencedetect`` semantics (every sample under the threshold
# for >= d) at 10 ms resolution, with a RELATIVE threshold (floor + rel_db, clamped to
# [-50, -30] dB) that a fixed ``silencedetect=noise=`` cannot know before decoding. Low priority
# (``-threads 2``, BELOW_NORMAL on Windows, nice on POSIX), cancel within <= 1 s of audio.

SUGGEST_RATE = 8000
SUGGEST_CHUNK_S = 1.0
SUGGEST_RMS_WINDOW_S = 0.05
SUGGEST_PEAK_BLOCK_S = 0.01
SUGGEST_THRESHOLD_MIN_DB = -50.0
SUGGEST_THRESHOLD_MAX_DB = -30.0
SUGGEST_FLOOR_MIN_DB = -90.0  # digital silence (zeros) would be -inf
SUGGEST_STAGE_ES = "Midiendo silencios y volumen"
BELOW_NORMAL_PRIORITY_CLASS = 0x4000

_EBU_I = re.compile(r"^\s*I:\s*(-?[\d.]+|-?inf)\s*LUFS", re.MULTILINE)
_EBU_LRA = re.compile(r"^\s*LRA:\s*(-?[\d.]+|-?inf)\s*LU\b", re.MULTILINE)
_EBU_PEAK = re.compile(r"^\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS", re.MULTILINE)


def _db(value: float) -> float:
    import math

    return 20.0 * math.log10(value) if value > 0 else float("-inf")


def _num(text: str | None) -> float | None:
    if text is None or "inf" in text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_ebur128_summary(stderr: str) -> tuple[float | None, float | None, float | None]:
    """(integrated LUFS, LRA, true peak dBTP) from the final ``Summary:`` of ``ebur128``.

    I <= -70 LUFS (nothing passed the absolute gate: silent file) and -inf peaks give None."""
    idx = stderr.rfind("Summary:")
    tail = stderr[idx:] if idx >= 0 else ""
    m_i, m_lra, m_peak = _EBU_I.search(tail), _EBU_LRA.search(tail), _EBU_PEAK.search(tail)
    lufs = _num(m_i.group(1)) if m_i else None
    if lufs is not None and lufs <= -70.0:
        lufs = None
    lra = _num(m_lra.group(1)) if m_lra else None
    peak = _num(m_peak.group(1)) if m_peak else None
    return lufs, lra, peak


def chunk_stats(samples: Any) -> tuple[list[float], list[float]]:
    """Per 1 s chunk of int16 samples -> (RMS dB of each 50 ms window, peak dB of each 10 ms
    block), full scale = 32768. numpy when present, pure Python otherwise (same numbers)."""
    win = int(SUGGEST_RATE * SUGGEST_RMS_WINDOW_S)
    blk = int(SUGGEST_RATE * SUGGEST_PEAK_BLOCK_S)
    try:
        import numpy as np  # noqa: PLC0415 - optional speed-up
    except ImportError:  # pragma: no cover - CI and the PC have numpy
        np = None  # type: ignore[assignment]
    if np is not None:
        arr = np.asarray(samples, dtype=np.float64) / 32768.0
        rms: list[float] = []
        for i in range(0, len(arr), win):
            part = arr[i : i + win]
            if len(part):
                rms.append(_db(float(np.sqrt(np.mean(part * part)))))
        n_blk = len(arr) // blk
        peaks = (
            [_db(float(v)) for v in np.abs(arr[: n_blk * blk]).reshape(n_blk, blk).max(axis=1)]
            if n_blk
            else []
        )
        rest = arr[n_blk * blk :]
        if len(rest):
            peaks.append(_db(float(np.abs(rest).max())))
        return rms, peaks
    vals = [s / 32768.0 for s in samples]
    rms = []
    for i in range(0, len(vals), win):
        part = vals[i : i + win]
        if part:
            rms.append(_db((sum(v * v for v in part) / len(part)) ** 0.5))
    peaks = [_db(max(abs(v) for v in vals[i : i + blk])) for i in range(0, len(vals), blk)]
    return rms, peaks


def noise_floor_db(rms_db: list[float]) -> float:
    """10th percentile of the 50 ms RMS windows (dB), never below -90."""
    if not rms_db:
        return SUGGEST_FLOOR_MIN_DB
    ordered = sorted(rms_db)
    value = ordered[min(len(ordered) - 1, int(len(ordered) * 0.10))]
    return max(SUGGEST_FLOOR_MIN_DB, value)


def silence_threshold_db(floor_db: float, rel_db: float) -> float:
    return max(SUGGEST_THRESHOLD_MIN_DB, min(SUGGEST_THRESHOLD_MAX_DB, floor_db + rel_db))


def silences_from_peaks(
    peaks_db: list[float], threshold_db: float, min_silence_ms: int
) -> list[tuple[float, float]]:
    """``silencedetect`` semantics on 10 ms peak blocks: runs where every block's peak is under
    the threshold for >= ``min_silence_ms`` -> [(start_s, end_s)] (source seconds)."""
    out: list[tuple[float, float]] = []
    min_blocks = max(1, round(min_silence_ms / 1000 / SUGGEST_PEAK_BLOCK_S))
    start: int | None = None
    for i, p in enumerate([*peaks_db, float("inf")]):
        if p < threshold_db:
            if start is None:
                start = i
        elif start is not None:
            if i - start >= min_blocks:
                out.append(
                    (round(start * SUGGEST_PEAK_BLOCK_S, 3), round(i * SUGGEST_PEAK_BLOCK_S, 3))
                )
            start = None
    return out


def _low_priority_cmd(cmd: list[str]) -> tuple[list[str], dict[str, Any]]:
    """argv + Popen kwargs for a background ffmpeg: own process group (kill_process_tree),
    BELOW_NORMAL_PRIORITY_CLASS on Windows, ``nice -n 10`` on POSIX."""
    import shutil
    import sys

    from .tasks import new_group_kwargs

    kwargs = new_group_kwargs()
    if sys.platform == "win32":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | BELOW_NORMAL_PRIORITY_CLASS
        return cmd, kwargs
    nice = shutil.which("nice")
    return ([nice, "-n", "10", *cmd] if nice else cmd), kwargs


def analyze_for_suggestions(
    path: Path,
    *,
    silence_min_ms: int = 500,
    silence_rel_db: float = 9.0,
    task: Any = None,
) -> dict[str, Any]:
    """One ffmpeg pass -> SuggestAnalyzeResult dict (source seconds). ``task``: the TaskQueue
    Task (progress in seconds read, stage text, cancel); None in direct calls."""
    import threading

    from .tasks import TaskCanceled, on_cancel_kill

    exe = find_ffmpeg()
    if not exe:
        raise FfmpegNotFoundError(
            "ffmpeg no encontrado: instalalo (setup.ps1) o defini FFMPEG_PATH en .env"
        )
    graph = (
        f"[0:a:0]asplit=2[m][p];[m]ebur128=peak=true:framelog=quiet,anullsink;"
        f"[p]aresample={SUGGEST_RATE},aformat=sample_fmts=s16:channel_layouts=mono[pcm]"
    )
    base = [exe, "-hide_banner", "-nostats", "-threads", "2", "-i", str(path), "-vn"]
    base += ["-filter_complex", graph, "-map", "[pcm]", "-f", "s16le", "-threads", "2", "pipe:1"]
    cmd, kwargs = _low_priority_cmd(base)
    proc = subprocess.Popen(  # noqa: S603 - fixed argv
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs
    )
    on_cancel_kill(proc)
    err_parts: list[str] = []
    header: dict[str, float] = {}

    def read_stderr() -> None:
        assert proc.stderr is not None
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", errors="replace")
            err_parts.append(line)
            if "duration" not in header and (m := _DURATION.search(line)):
                h, mi, se = m.groups()
                header["duration"] = int(h) * 3600 + int(mi) * 60 + float(se)

    reader = threading.Thread(target=read_stderr, name="suggest-ffmpeg-stderr", daemon=True)
    reader.start()
    if task is not None:
        task.stage_es = SUGGEST_STAGE_ES
        task.current_file = SUGGEST_STAGE_ES
    import array

    rms_db: list[float] = []
    peaks_db: list[float] = []
    n_samples = 0
    chunk_bytes = int(SUGGEST_RATE * SUGGEST_CHUNK_S) * 2
    pending = b""
    assert proc.stdout is not None
    try:
        while True:
            if task is not None:
                task.check_canceled()
            data = proc.stdout.read(chunk_bytes)
            if not data:
                break
            data = pending + data
            usable = len(data) - (len(data) % 2)
            pending = data[usable:]
            samples = array.array("h")
            samples.frombytes(data[:usable])
            if sys_byteorder_big():
                samples.byteswap()
            r, p = chunk_stats(samples)
            rms_db.extend(r)
            peaks_db.extend(p)
            n_samples += len(samples)
            if task is not None:
                done_s = n_samples / SUGGEST_RATE
                total_s = max(header.get("duration") or 0.0, done_s, 1.0)
                task.set_items(int(done_s), int(round(total_s)) or 1, SUGGEST_STAGE_ES)
        proc.wait(timeout=60)
    except TaskCanceled:
        from .tasks import kill_process_tree

        kill_process_tree(proc)
        raise
    finally:
        reader.join(timeout=5)
    if task is not None and task.cancel_event.is_set():
        raise TaskCanceled(task.id)
    stderr = "".join(err_parts)
    if proc.returncode != 0:
        if "matches no streams" in stderr or "Stream specifier" in stderr:
            raise ValueError("El medio no tiene audio: no hay silencios ni volumen para medir")
        raise RuntimeError(f"ffmpeg (sugerencias) fallo: {stderr.strip()[-400:]}")
    lufs, lra, peak = parse_ebur128_summary(stderr)
    floor = noise_floor_db(rms_db)
    threshold = silence_threshold_db(floor, silence_rel_db)
    duration = round(n_samples / SUGGEST_RATE, 3) if n_samples else header.get("duration", 0.0)
    return {
        "duration_s": float(duration or 0.0),
        "noise_floor_db": round(floor, 2),
        "silence_threshold_db": round(threshold, 2),
        "silences": [list(s) for s in silences_from_peaks(peaks_db, threshold, silence_min_ms)],
        "lufs_i": lufs,
        "lra": lra,
        "true_peak_db": peak,
    }


def sys_byteorder_big() -> bool:
    import sys

    return sys.byteorder == "big"
