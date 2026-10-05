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
