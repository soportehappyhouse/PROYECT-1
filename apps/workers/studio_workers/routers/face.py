"""Sprint 4 M1 face routes (WORKER_FACE_ROUTES): detect faces in a frame (sync) and run FaceFusion
for a preview frame or a clip (task, polled on GET /face/tasks/{id}, cancel = kill the tree)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..config import get_settings
from ..consent_mirror import require_consent
from ..errors import CodedError, NotFoundError
from ..face.schemas import FaceDetectRequest, FaceSwapWorkerRequest
from ..face.tool import licence_accepted
from ..packs import PackRequiredError
from ..services import face_engine, face_queue
from ..tasks import Task
from .analyze import resolve_input

router = APIRouter(prefix="/face", tags=["face"])


@router.post("/detect")
def detect(req: FaceDetectRequest) -> dict[str, Any]:
    """YuNet faces of an image or of the frame `t` of a video, left to right, boxes in 0..1."""
    src = resolve_input(get_settings(), req.path)
    return face_engine().detect(src, req.t)


@router.post("/swap")
def swap(req: FaceSwapWorkerRequest) -> dict[str, Any]:
    """FaceFusion headless-run -> {task_id}. Before queueing: 403 LICENCE_REQUIRED (mirror), 400
    for paths outside storage or with `..`, 403 CONSENT_REQUIRED unless `consent_id` is a valid
    face consent of consent/active.json listing every source photo (audit fix 4); the task checks
    all of it again plus the venv, models and limits."""
    settings = get_settings()
    sources = [resolve_input(settings, p) for p in req.source_paths]
    resolve_input(settings, req.target_path)
    settings.storage_path(req.output_base)
    for lid in req.licence_ids:
        if not licence_accepted(lid):
            raise CodedError(
                "LICENCE_REQUIRED",
                "Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no "
                "comerciales + OpenRAIL-AS) en pantalla: Ajustes → Paquetes de IA.",
                details={"licenceId": lid},
            )
    require_consent(
        settings.storage_root,
        req.consent_id,
        "face",
        [settings.storage_relative(src) for src in sources],
    )
    engine = face_engine()

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = max(task.progress, min(0.99, p))
            task.message = msg
            task.current_file = msg

        try:
            return engine.run(req, task.id, step)
        except CodedError as exc:
            engine.task_errors[task.id] = (exc.code, exc.details)
            raise
        except PackRequiredError as exc:
            engine.task_errors[task.id] = ("PACK_REQUIRED", exc.payload())
            raise

    kind = "face.preview" if req.preview_t is not None else "face.swap"
    task = face_queue().submit(kind, req.output_base, job)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = face_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    out = task.public()
    err = face_engine().task_errors.get(task_id)
    if task.status == "error" and err is not None:
        out["code"] = err[0]
        if err[1] is not None:
            out["details"] = err[1]
    result = task.result if isinstance(task.result, dict) else None
    if result and result.get("warnings"):
        out["warnings"] = result["warnings"]
    return out


@router.post("/tasks/{task_id}/cancel")
def cancel(task_id: str) -> dict[str, Any]:
    task = face_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    killed = face_engine().cancel(task_id)
    return {"task_id": task_id, "canceled": True, "killed": killed}
