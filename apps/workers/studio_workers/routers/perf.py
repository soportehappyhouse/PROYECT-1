from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import get_settings
from ..errors import NotFoundError
from ..perf import perf_path, read_last, run_perf
from ..services import perf_queue
from ..tasks import Task

router = APIRouter(prefix="/perf", tags=["perf"])


class PerfRunRequest(BaseModel):
    """Sprint 4 (sent by the api): photo of the first Person with a valid face consent
    (STORAGE_DIR-relative, gate.benchFaceSource()), its consent id and the accepted licences.
    All optional."""

    face_source_path: str | None = Field(default=None, max_length=1024)
    face_consent_id: str | None = Field(default=None, max_length=64)
    licences: list[str] | None = None


@router.post("/run")
def run(req: PerfRunRequest | None = None) -> dict[str, Any]:
    """Queue the AI performance test; the result goes to storage/run/perf.json."""
    settings = get_settings()
    body = req or PerfRunRequest()
    if body.face_source_path:
        settings.storage_path(body.face_source_path)  # 400 on '..' / absolute paths

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = min(0.99, p)
            task.current_file = msg

        run_perf(
            settings,
            step,
            face_source_path=body.face_source_path,
            licences=body.licences,
            face_consent_id=body.face_consent_id,
        )
        return {"path": perf_path(settings).relative_to(settings.storage_root).as_posix()}

    task = perf_queue().submit("perf.run", "perf", job)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = perf_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    return task.public()


@router.get("/last")
def last() -> dict[str, Any]:
    """Last storage/run/perf.json (404 when the test never ran)."""
    data = read_last(get_settings())
    if data is None:
        raise NotFoundError("Todavia no se corrio el test de rendimiento")
    return data


# BEGIN sprint5:M1
@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str) -> dict[str, Any]:
    """Sprint 5: cancel the task (TaskCancelResponse); 404 TASK_NOT_FOUND when unknown."""
    from ..tasks import cancel_or_404

    return cancel_or_404(perf_queue(), task_id)


# END sprint5:M1
