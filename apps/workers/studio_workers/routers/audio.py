from typing import Any, Literal

from fastapi import APIRouter
from pydantic import Field

from ..config import get_settings
from ..errors import NotFoundError
from ..schemas import DenoiseRequest, SnakeModel
from ..services import audio_queue, denoise_engine, stems_engine
from ..tasks import Task
from .analyze import resolve_input

router = APIRouter(prefix="/audio", tags=["audio"])


@router.post("/denoise")
def denoise(req: DenoiseRequest) -> dict[str, Any]:
    """DeepFilterNet voice cleanup -> {path} (WAV, or MP3 by format/extension); voz-limpia."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    base = settings.storage_path(req.output_base)
    suffix = base.suffix.lower()
    fmt = req.format or (suffix.lstrip(".") if suffix in (".wav", ".mp3") else "wav")
    out = (
        base.with_suffix(f".{fmt}")
        if suffix in (".wav", ".mp3")
        else base.with_name(f"{base.name}.{fmt}")
    )
    path, device, warnings = denoise_engine().denoise(src, out)
    result: dict[str, Any] = {"path": settings.storage_relative(path), "device": device}
    if warnings:
        result["warnings"] = warnings
    return result


# ------------------------------------------------------------ sprint 3b: stems (audio/stems.py)


class StemsRequest(SnakeModel):
    path: str
    mode: Literal["two", "four"] = "two"
    output_base: str = Field(min_length=1)


@router.post("/stems")
def stems(req: StemsRequest) -> dict[str, Any]:
    """Demucs htdemucs -> {task_id}; poll GET /audio/tasks/{id}. 409 PACK_REQUIRED (stems) first.

    Task result: {stems: {vocals, no_vocals} | {vocals, drums, bass, other}, sample_rate, device,
    segment, chunks, duration_s, warnings?} (paths relative to STORAGE_DIR, WAV 44.1 kHz)."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    engine = stems_engine()
    engine.require()
    out = settings.storage_path(req.output_base)

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = max(task.progress, min(0.99, p))
            task.current_file = msg
            task.message = msg

        res = engine.separate(src, out, req.mode, progress=step)
        result: dict[str, Any] = {
            "stems": {k: settings.storage_relative(v) for k, v in res["paths"].items()},
            "sample_rate": 44_100,
            "mode": req.mode,
            "device": res["device"],
            "segment": res["segment"],
            "chunks": res["chunks"],
            "duration_s": res["duration_s"],
        }
        if res["warnings"]:
            result["warnings"] = res["warnings"]
        return result

    task = audio_queue().submit("audio.stems", f"{req.mode}:{out}", job)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = audio_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    out = task.public()
    warnings = (task.result or {}).get("warnings") if isinstance(task.result, dict) else None
    if warnings:
        out["warnings"] = warnings
    return out
