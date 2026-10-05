from typing import Any

from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError
from ..perf import perf_path, read_last, run_perf
from ..services import perf_queue
from ..tasks import Task

router = APIRouter(prefix="/perf", tags=["perf"])


@router.post("/run")
def run() -> dict[str, Any]:
    """Queue the AI performance test; the result goes to storage/run/perf.json."""
    settings = get_settings()

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = min(0.99, p)
            task.current_file = msg

        run_perf(settings, step)
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
