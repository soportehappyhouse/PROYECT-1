"""Sprint 3b «Perfil de estilo» (docs/trabajo/sprint3b-contratos.md, section B)."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import services
from ..config import get_settings
from ..errors import NotFoundError
from ..style.analyze import analyze_style
from ..style.infer import VISION_VRAM_MB, infer_preset
from ..tasks import Task, TaskQueue
from .analyze import resolve_input

router = APIRouter(prefix="/style", tags=["style"])


@lru_cache
def style_queue() -> TaskQueue:
    """Reference analyses: one at a time (FFmpeg + OCR on the CPU)."""
    return TaskQueue("style")


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str = ""


class AnalyzeRequest(BaseModel):
    path: str = Field(min_length=1)
    # Folder relative to STORAGE_DIR for analysis.json, contact_sheet.png and thumbs/.
    output_dir: str = Field(min_length=1)
    max_frames: int = Field(default=24, ge=4, le=24)
    ocr: bool | None = None  # None = use the ocr pack when installed
    transcript: list[TranscriptSegment] | None = None


class InferRequest(BaseModel):
    analysis_path: str = Field(min_length=1)
    contact_sheet_path: str = Field(min_length=1)
    model: str | None = None  # default STYLE_VISION_MODEL / qwen2.5vl:3b
    temperature: float | None = Field(default=None, ge=0, le=2)


@router.post("/analyze")
def analyze(req: AnalyzeRequest) -> dict[str, Any]:
    """Queue the analysis -> {task_id}; GET /style/tasks/{id} -> {analysis_path, analysis}."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    out_dir = settings.storage_path(req.output_dir)
    transcript = [s.model_dump() for s in req.transcript] if req.transcript else None

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = min(0.99, max(task.progress, p))
            task.add_log(msg)

        analysis = analyze_style(
            src,
            out_dir,
            settings.storage_root,
            max_frames=req.max_frames,
            ocr=req.ocr,
            transcript=transcript,
            step=step,
        )
        return {"analysis_path": analysis.pop("analysis_path"), "analysis": analysis}

    task = style_queue().submit("style.analyze", f"{req.path}->{req.output_dir}", job)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = style_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    return task.public()


def _release_gpu() -> list[str]:
    released = services.gpu_budget().make_room(VISION_VRAM_MB)
    return [f"gpu_released:{released}"] if released else []


@router.post("/infer")
async def infer(req: InferRequest) -> dict[str, Any]:
    """StylePreset draft from Ollama qwen2.5vl:3b (409 PACK_REQUIRED vision-llm when missing)."""
    settings = get_settings()
    analysis_file = resolve_input(settings, req.analysis_path)
    sheet = resolve_input(settings, req.contact_sheet_path)
    try:
        analysis = json.loads(analysis_file.read_text("utf-8"))
    except ValueError as exc:
        raise ValueError(f"El análisis no es JSON válido: {req.analysis_path}") from exc
    return await infer_preset(
        services.ollama_client(),
        analysis,
        sheet,
        model=req.model,
        temperature=settings.agent_temperature if req.temperature is None else req.temperature,
        keep_alive=settings.agent_keep_alive,
        before_llm=_release_gpu,
    )


# BEGIN sprint5:M1
@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str) -> dict[str, Any]:
    """Sprint 5: cancel the task (TaskCancelResponse); 404 TASK_NOT_FOUND when unknown."""
    from ..tasks import cancel_or_404

    return cancel_or_404(style_queue(), task_id)


# END sprint5:M1
