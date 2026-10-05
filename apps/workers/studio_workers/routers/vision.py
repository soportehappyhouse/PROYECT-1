"""Sprint 2 vision endpoints (docs/trabajo/sprint2-contratos.md). Long jobs -> {task_id}; poll
GET /vision/tasks/{id} -> {status: queued|running|done|error, progress, result}. Missing pack ->
409 PACK_REQUIRED (checked before queuing)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from ..config import Settings, get_settings
from ..errors import NotFoundError
from ..packs import PackRequiredError, is_installed, module_present
from ..schemas import (
    BBox,
    MatteImageRequest,
    MatteRequest,
    ReframeRequest,
    SamPointsRequest,
    SamPropagateRequest,
    SamSessionRequest,
    TrackRequest,
)
from ..services import matte_engine, sam_manager, vision_queue
from ..tasks import Task
from ..vision.frames import probe, read_gray
from ..vision.sam import Prompt
from .analyze import resolve_input

router = APIRouter(prefix="/vision", tags=["vision"])


def _step(task: Task) -> Callable[[float, str], None]:
    def step(p: float, msg: str) -> None:
        task.progress = max(task.progress, min(0.99, p))
        task.current_file = msg
        task.message = msg

    return step


def _out(settings: Settings, base: str, suffix: str) -> Path:
    path = settings.storage_path(base)
    return path if path.suffix.lower() == suffix else path.with_name(path.name + suffix)


def _submit(kind: str, target: str, fn: Callable[[Task], Any]) -> dict[str, Any]:
    task = vision_queue().submit(kind, target, fn)
    return {"task_id": task.id, "status": task.status}


def _normalized(values: list[float], flag: bool | None) -> bool:
    return flag if flag is not None else all(v <= 1.0 for v in values)


def _bbox_px(b: BBox, width: int, height: int) -> tuple[float, float, float, float]:
    if _normalized([b.x, b.y, b.w, b.h], None):
        return b.x * width, b.y * height, b.w * width, b.h * height
    return b.x, b.y, b.w, b.h


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = vision_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    return task.public()


# ------------------------------------------------------------------------------------- matte


@router.post("/matte")
def matte(req: MatteRequest) -> dict[str, Any]:
    """RVM (subprocess, .venv-gpl) or BiRefNet -> WebM VP9 yuva420p + preview PNG (task)."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    engine = matte_engine()
    engine.require(req.model)
    out = _out(settings, req.output_base, ".webm")

    def job(task: Task) -> dict[str, Any]:
        res = engine.matte_video(
            src,
            out,
            model=req.model,
            downsample=req.downsample,
            chunk=req.chunk_frames,
            progress=_step(task),
        )
        result = {
            "alpha_path": settings.storage_relative(out),
            "preview_path": settings.storage_relative(res["preview"]),
            "fps": res["fps"],
            "frames": res.get("frames"),
            "model": req.model,
            "device": res["device"],
        }
        if res.get("proc_fps"):
            result["proc_fps"] = res["proc_fps"]
        if res.get("warnings"):
            result["warnings"] = res["warnings"]
        return result

    return _submit("vision.matte", f"{req.model}:{out}", job)


@router.post("/matte-image")
def matte_image(req: MatteImageRequest) -> dict[str, Any]:
    """BiRefNet-lite -> PNG RGBA (synchronous)."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    out = _out(settings, req.output_base, ".png")
    res = matte_engine().matte_image(src, out)
    body: dict[str, Any] = {"path": settings.storage_relative(out), "device": res["device"]}
    if res["warnings"]:
        body["warnings"] = res["warnings"]
    return body


# --------------------------------------------------------------------------------------- SAM


@router.post("/sam/session")
def sam_session(req: SamSessionRequest) -> dict[str, Any]:
    settings = get_settings()
    src = resolve_input(settings, req.path)
    mgr = sam_manager()
    s = mgr.create(src, req.frame_range, req.asset_id)
    return {
        "session_id": s.id,
        "frames": s.n,
        "fps": round(s.info.fps_float, 6),
        "frame_range": [s.start, s.end],
        "width": s.info.width,
        "height": s.info.height,
        "model": f"sam2.1-{mgr.choose_size()}",
    }


@router.post("/sam/session/{session_id}/points")
def sam_points(session_id: str, req: SamPointsRequest) -> dict[str, Any]:
    """Points (label 1 = include, 0 = exclude) on a session frame -> mask PNG + bbox (0..1)."""
    mgr = sam_manager()
    s = mgr.get(session_id)
    norm = _normalized([v for p in req.points for v in (p.x, p.y)], req.normalized)
    w, h = s.info.width, s.info.height
    pts = [(p.x * w, p.y * h) if norm else (p.x, p.y) for p in req.points]
    prompt = Prompt(req.frame, req.obj_id, pts, [int(p.label) for p in req.points])
    res = mgr.add_prompt(s, prompt, replace=req.replace)
    if not res["warnings"]:
        res.pop("warnings")
    return res


@router.post("/sam/session/{session_id}/propagate")
def sam_propagate(session_id: str, req: SamPropagateRequest | None = None) -> dict[str, Any]:
    body = req or SamPropagateRequest()
    mgr = sam_manager()
    s = mgr.get(session_id)
    if not s.prompts:
        raise ValueError("Marca al menos un punto antes de propagar")

    def job(task: Task) -> dict[str, Any]:
        return mgr.propagate(s, chunk_frames=body.chunk_frames, alpha=body.alpha,
                             progress=_step(task))  # fmt: skip

    return _submit("vision.sam.propagate", session_id, job)


@router.delete("/sam/session/{session_id}")
def sam_delete(session_id: str) -> dict[str, Any]:
    if not sam_manager().delete(session_id):
        raise NotFoundError(f"Sesion SAM desconocida: {session_id}")
    return {"deleted": True, "session_id": session_id}


# ------------------------------------------------------------------------------------- track


@router.post("/track")
def track(req: TrackRequest) -> dict[str, Any]:
    """Box or mask on the first frame of the range -> TrackFile (One-Euro smoothed) (task)."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    if (req.bbox is None) == (req.mask_png is None):
        raise ValueError("Envia bbox o mask_png (uno de los dos)")
    mask_path = resolve_input(settings, req.mask_png) if req.mask_png else None
    if req.method == "csrt":
        if not (module_present("cv2") and module_present("numpy")):
            raise PackRequiredError("reframe")
    else:
        sam_manager().require()
    base = req.output_base or f"renders/vision/track-{uuid.uuid4().hex[:10]}"
    out = _out(settings, base, ".json")
    if not out.name.endswith(".track.json"):
        out = out.with_name(out.name.removesuffix(".json") + ".track.json")

    def job(task: Task) -> dict[str, Any]:
        info = probe(src)
        mask = None
        box_px: tuple[float, float, float, float] | None = None
        if mask_path is not None:
            from ..vision.frames import mask_bbox  # noqa: PLC0415

            mask = read_gray(mask_path, (info.width, info.height)) > 127
            mb = mask_bbox(mask)
            if mb is None:
                raise ValueError("La mascara esta vacia")
            box_px = tuple(float(v) for v in mb)  # type: ignore[assignment]
        else:
            assert req.bbox is not None
            box_px = _bbox_px(req.bbox, info.width, info.height)
        warnings: list[str] = []
        if req.method == "csrt":
            from ..vision.tracking import track_opencv  # noqa: PLC0415

            trk = track_opencv(src, box_px, frame_range=req.frame_range, asset_id=req.asset_id,
                               smoothing=req.smoothing, progress=_step(task))  # fmt: skip
        else:
            x, y, w, h = box_px
            trk, res = sam_manager().track_box(
                src,
                box=None if mask is not None else (x, y, x + w, y + h),
                mask=mask,
                frame_range=req.frame_range,
                asset_id=req.asset_id,
                progress=_step(task),
            )
            warnings += res.get("warnings") or []
            if not req.smoothing:
                trk.smoothed = False
        trk.save(out)
        body: dict[str, Any] = {
            "track_path": settings.storage_relative(out),
            "smoothed": trk.smoothed,
            "method": trk.source.method,
            "frames": len(trk.frames),
            "track": trk.payload(),
        }
        if warnings:
            body["warnings"] = list(dict.fromkeys(warnings))
        return body

    return _submit("vision.track", f"{req.method}:{out}", job)


# ----------------------------------------------------------------------------------- reframe


@router.post("/reframe")
def reframe(req: ReframeRequest) -> dict[str, Any]:
    """Faces (YuNet) or a TrackFile per scene -> crop keyframes for 9:16 / 1:1 / 4:5 (task)."""
    from ..vision import reframe as rf  # noqa: PLC0415

    settings = get_settings()
    src = resolve_input(settings, req.path)
    root = settings.models_root
    track_file: Path | None = None
    if req.subject == "track":
        if not req.track_path:
            raise ValueError("subject 'track' necesita track_path")
        track_file = resolve_input(settings, req.track_path)
    elif not (module_present("cv2") and module_present("numpy") and rf.yunet_path(root).is_file()):
        raise PackRequiredError("reframe")

    def job(task: Task) -> dict[str, Any]:
        import json  # noqa: PLC0415

        step = _step(task)
        warnings: list[str] = []
        if track_file is not None:
            info = probe(src)
            data = json.loads(track_file.read_text("utf-8"))
            samples = rf.samples_from_track(data, info.width, info.height)
        else:
            detector = rf.YuNetDetector(rf.yunet_path(root))
            samples, info = rf.detect_samples(src, detector, progress=step)
        scenes = [(s.start, s.end) for s in req.scenes] if req.scenes else None
        if scenes is None:
            if is_installed("scenes", root):
                from ..analyze import detect_scenes  # noqa: PLC0415

                step(0.92, "escenas")
                found = detect_scenes(src)["scenes"]
                scenes = [(float(s["start"]), float(s["end"])) for s in found] or None
            else:
                warnings.append("scenes_not_detected")
        duration = info.duration or (samples[-1][0] if samples else 0.0)
        plan = rf.plan_reframe(
            samples,
            width=info.width,
            height=info.height,
            target=req.target,
            duration=duration,
            scenes=scenes,
            subject=req.subject,
            fps=info.fps_float,
        )
        if any(s["fallback"] for s in plan["per_scene"]):
            warnings.append("reframe_center_fallback")
        plan["source"] = {
            "width": info.width,
            "height": info.height,
            "fps": round(info.fps_float, 6),
            "duration": round(duration, 4),
        }
        if warnings:
            plan["warnings"] = warnings
        return plan

    return _submit("vision.reframe", f"{req.target}:{req.subject}:{src}", job)
