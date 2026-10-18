"""Sprint 5 task contract (task_schema.py mirrors WorkerTaskSchema in packages/shared/src/ai.ts)."""

import pytest
from pydantic import ValidationError

from studio_workers.errors import SPRINT5_ERROR_STATUS, TASK_NOT_FOUND_ES, CodedError
from studio_workers.task_schema import TaskCancelResponse, TaskPublic, TranscribeCancelRequest
from studio_workers.tasks import Task


def test_task_public_defaults_and_current_public_shape() -> None:
    t = TaskPublic(task_id="t1", kind="eval", target="golden", status="canceled", progress=0.4)
    assert t.cancellable is True
    assert t.bytes_done == 0 and t.eta_s is None and t.result is None
    # today's Task.public() output is a valid TaskPublic (M1 adds done/total/stage_es/eta_s)
    task = Task(id="t2", kind="packs", target="whisper")
    TaskPublic.model_validate(task.public())
    with pytest.raises(ValidationError):
        TaskPublic(task_id="t", kind="k", target="x", status="paused", progress=0)


def test_cancel_models() -> None:
    assert TaskCancelResponse(task_id="t1", canceled=False, was="finished").was == "finished"
    with pytest.raises(ValidationError):
        TaskCancelResponse(task_id="t1", canceled=True, was="error")
    assert TranscribeCancelRequest(job_id="j1").job_id == "j1"


def test_task_not_found_code() -> None:
    err = CodedError("TASK_NOT_FOUND", TASK_NOT_FOUND_ES.format(id="t9"))
    assert err.status == SPRINT5_ERROR_STATUS["TASK_NOT_FOUND"] == 404
    assert err.payload() == {
        "detail": "La tarea t9 ya no existe en la IA local (¿se reinició?).",
        "code": "TASK_NOT_FOUND",
    }
