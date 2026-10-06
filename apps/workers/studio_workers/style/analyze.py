"""StyleAnalysis of a reference video (packages/shared/src/style.ts, StyleAnalysisSchema).

One call = probe -> cuts -> shot stats -> motion -> audio -> contact sheet + thumbnails -> OCR
(pack ``ocr``, optional) -> ``<output_dir>/analysis.json``. Paths inside the JSON are relative to
STORAGE_DIR (the api serves them under /files). CPU only; ~10-20 s for 1 minute of 1080p.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import ocr as ocr_mod
from .audio import audio_profile
from .video import (
    THUMB_BOX,
    analyze_motion,
    aspect_label,
    build_contact_sheet,
    detect_cuts,
    ffmpeg_scene_cuts,
    gray_frames,
    probe_media,
    scenes_from_cuts,
    shot_stats,
    tile_size,
)

log = logging.getLogger("studio_workers")

StepFn = Callable[[float, str], None]
EXCERPT_CHARS = 600


def transcript_excerpt(segments: list[dict[str, Any]] | None) -> str | None:
    """First lines of the transcript (≤ 600 characters), or None."""
    if not segments:
        return None
    text = " ".join(str(s.get("text", "")).strip() for s in segments[:20]).strip()
    if not text:
        return None
    return text if len(text) <= EXCERPT_CHARS else text[: EXCERPT_CHARS - 1].rstrip() + "…"


def analyze_style(
    src: Path,
    out_dir: Path,
    storage_root: Path,
    *,
    max_frames: int = 24,
    ocr: bool | None = None,
    transcript: list[dict[str, Any]] | None = None,
    step: StepFn | None = None,
    ocr_engine: Any = None,
) -> dict[str, Any]:
    """Run the whole analysis and write ``out_dir/analysis.json``; returns the JSON dict.

    ``ocr``: None = use the pack when installed, False = skip, True = wanted (a missing pack only
    adds the warning ``ocr_pack_missing``; the analysis never fails for OCR)."""
    say = step or (lambda _p, _m: None)
    started = time.perf_counter()
    warnings: list[str] = []
    out_dir.mkdir(parents=True, exist_ok=True)

    def rel(p: Path) -> str:
        return p.resolve().relative_to(storage_root.resolve()).as_posix()

    say(0.02, "Leyendo el video")
    info = probe_media(src)
    duration = float(info["duration"])

    say(0.08, "Detectando cortes")
    try:
        scenes, method = detect_cuts(src, duration)
    except Exception as exc:  # PySceneDetect failed on this file: the FFmpeg detector still works
        log.warning("scenedetect failed on %s (%s): ffmpeg fallback", src.name, exc)
        warnings.append("scenedetect_failed_ffmpeg_fallback")
        scenes, method = scenes_from_cuts(ffmpeg_scene_cuts(src), duration), "ffmpeg"
    stats = shot_stats(scenes, duration)

    say(0.3, "Estimando el movimiento de cámara")
    motion = analyze_motion(gray_frames(src), scenes)

    say(0.5, "Analizando el audio")
    audio = audio_profile(src, duration, bool(info["has_audio"]), transcript)

    say(0.7, "Armando la hoja de contactos")
    sheet = build_contact_sheet(src, out_dir, info, max_frames)
    warnings.extend(sheet["warnings"])

    text_on_screen: list[dict[str, Any]] | None = None
    if ocr is not False:
        if ocr_engine is not None or ocr_mod.ocr_available():
            say(0.85, "Leyendo textos en pantalla (OCR)")
            try:
                thumb = tile_size(info["width"], info["height"], THUMB_BOX)
                text_on_screen = ocr_mod.read_frames(
                    sheet["thumbnails"], sheet["times"], engine=ocr_engine, size_of=lambda _p: thumb
                )
            except Exception as exc:  # OCR is optional: report and go on
                log.warning("ocr failed: %s", exc)
                warnings.append("ocr_failed")
        elif ocr:
            warnings.append("ocr_pack_missing")

    analysis: dict[str, Any] = {
        "version": 1,
        "source_path": rel(src) if storage_root in src.resolve().parents else src.name,
        "duration_s": round(duration, 3),
        "fps": info["fps"],
        "canvas": {
            "w": info["width"],
            "h": info["height"],
            "aspect": aspect_label(info["width"], info["height"]),
        },
        "scenes": scenes,
        "scenes_method": method,
        "shot_stats": stats,
        "motion": motion,
        "audio": audio,
        "contact_sheet_path": rel(sheet["path"]),
        "contact_sheet": {
            "columns": sheet["columns"],
            "rows": sheet["rows"],
            "width": sheet["width"],
            "height": sheet["height"],
            "times": sheet["times"],
            "timestamps": sheet["timestamps"],
        },
        "thumbnails": [rel(p) for p in sheet["thumbnails"]],
        "thumbnail_times": sheet["times"],
        "warnings": warnings,
    }
    if text_on_screen is not None:
        analysis["text_on_screen"] = text_on_screen
    excerpt = transcript_excerpt(transcript)
    if excerpt:
        analysis["transcript_excerpt"] = excerpt
    analysis["elapsed_s"] = round(time.perf_counter() - started, 2)
    path = out_dir / "analysis.json"
    path.write_text(json.dumps(analysis, ensure_ascii=False, indent=1) + "\n", "utf-8")
    analysis["analysis_path"] = rel(path)
    say(0.99, "Listo")
    return analysis
