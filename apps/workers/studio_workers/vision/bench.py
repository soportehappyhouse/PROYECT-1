"""Vision part of the AI performance test: rvm_fps, sam2_fps, yunet_fps (skipped with reason
when the pack is missing). Clips are synthetic (lavfi testsrc2); fps = whole pipeline (decode +
model + encode), which is what the UI time estimates need."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .. import services
from ..config import Settings
from ..media import run_ffmpeg


def _clip(dst: Path, size: str, seconds: float, rate: int = 25) -> Path:
    run_ffmpeg([
        "-f", "lavfi", "-i", f"testsrc2=s={size}:r={rate}:d={seconds}", "-c:v", "libx264",
        "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(dst),
    ])  # fmt: skip
    return dst


def bench_yunet(settings: Settings, work: Path) -> float:
    from .frames import FrameReader, probe  # noqa: PLC0415
    from .reframe import YuNetDetector, yunet_path  # noqa: PLC0415

    clip = _clip(work / "yunet.mp4", "640x360", 3)
    det = YuNetDetector(yunet_path(settings.models_root))
    info = probe(clip)
    frames = [f.copy() for _i, f in FrameReader(clip, info, pix_fmt="bgr24")]
    t0 = time.perf_counter()
    for f in frames:
        det(f)
    return round(len(frames) / max(1e-6, time.perf_counter() - t0), 1)


def bench_rvm(work: Path) -> tuple[float, list[str]]:
    engine = services.matte_engine()
    clip = _clip(work / "rvm.mp4", "1920x1080", 2)
    t0 = time.perf_counter()
    res = engine.matte_video(clip, work / "rvm.webm", model="rvm", chunk=300)
    fps = (res.get("frames") or 50) / max(1e-6, time.perf_counter() - t0)
    return round(fps, 1), list(res.get("warnings") or [])


def bench_sam2(work: Path) -> tuple[float, list[str]]:
    from .sam import Prompt  # noqa: PLC0415

    mgr = services.sam_manager()
    clip = _clip(work / "sam.mp4", "640x360", 2)
    s = mgr.create(clip)
    try:
        mgr.add_prompt(s, Prompt(0, 1, [(320.0, 180.0)], [1]))
        t0 = time.perf_counter()
        res = mgr.propagate(s, alpha=False)
        fps = s.n / max(1e-6, time.perf_counter() - t0)
        return round(fps, 1), list(res.get("warnings") or [])
    finally:
        mgr.delete(s.id)


def run_vision_bench(settings: Settings, work: Path, result: dict[str, Any]) -> None:
    from ..packs import is_installed  # noqa: PLC0415

    skipped: dict[str, str] = result["skipped"]
    errors: dict[str, str] = result["errors"]
    root = settings.models_root
    for key in ("rvm_fps", "sam2_fps", "yunet_fps"):
        result.setdefault(key, None)

    if not is_installed("reframe", root):
        skipped["yunet"] = "paquete reframe no instalado"
    else:
        try:
            result["yunet_fps"] = bench_yunet(settings, work)
        except Exception as exc:
            errors["yunet"] = str(exc)

    engine = services.matte_engine()
    if not engine.rvm_available():
        st = engine.gpl_status()["state"]
        skipped["rvm"] = (
            "paquete matting no instalado"
            if st == "missing" or not is_installed("matting", root)
            else f"entorno .venv-gpl {st} (reinstala el paquete matting)"
        )
    else:
        try:
            result["rvm_fps"], warns = bench_rvm(work)
            result["warnings"] += warns
        except Exception as exc:
            errors["rvm"] = str(exc)

    if not services.sam_manager().available():
        skipped["sam2"] = "paquete sam2 no instalado"
    else:
        try:
            result["sam2_fps"], warns = bench_sam2(work)
            result["warnings"] += warns
        except Exception as exc:
            errors["sam2"] = str(exc)
