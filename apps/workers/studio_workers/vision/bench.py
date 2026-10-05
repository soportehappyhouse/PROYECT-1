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


RVM_BENCH_SIZE = "1920x1080"
RVM_BENCH_SECONDS = 5.0
RVM_BENCH_RATE = 25
RVM_TARGET_FPS = 15  # plan v2 criterion: >= 15 fps at 1080p on the RTX 4050


def bench_rvm(work: Path) -> dict[str, Any]:
    """A real 1080p 5 s lavfi clip through the GPL subprocess (``vision_gpl.rvm`` in .venv-gpl,
    the same path as «Quitar fondo»). fps = whole pipeline (decode + model + VP9 alpha encode)."""
    engine = services.matte_engine()
    clip = _clip(work / "rvm.mp4", RVM_BENCH_SIZE, RVM_BENCH_SECONDS, RVM_BENCH_RATE)
    t0 = time.perf_counter()
    res = engine.matte_video(clip, work / "rvm.webm", model="rvm", chunk=300)
    frames = res.get("frames") or int(RVM_BENCH_SECONDS * RVM_BENCH_RATE)
    fps = frames / max(1e-6, time.perf_counter() - t0)
    return {
        "rvm_fps": round(fps, 1),
        "rvm_proc_fps": res.get("proc_fps") or None,
        "rvm_device": res.get("device"),
        "rvm_precision": res.get("precision") or None,
        "rvm_downsample": res.get("downsample"),
        "rvm_resolution": RVM_BENCH_SIZE.replace("x", "×"),
        "rvm_target_fps": RVM_TARGET_FPS,
        "warnings": list(res.get("warnings") or []),
    }


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
            measured = bench_rvm(work)
            result["warnings"] += measured.pop("warnings")
            result.update(measured)
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
