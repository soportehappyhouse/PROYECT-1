"""Sprint 5 task contract (mirror of WorkerTaskSchema / WorkerTaskCancelSchema in
packages/shared/src/ai.ts). ``TaskQueue`` tasks expose ``TaskPublic`` on
``GET /<area>/tasks/{id}`` and answer ``TaskCancelResponse`` on ``POST /<area>/tasks/{id}/cancel``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

TaskStatus = Literal["queued", "running", "done", "error", "canceled"]


class TaskPublic(BaseModel):
    task_id: str
    kind: str
    target: str
    status: TaskStatus
    progress: float
    bytes_done: int = 0
    bytes_total: int = 0
    current_file: str | None = None
    done: int | None = None
    total: int | None = None
    stage_es: str | None = None
    eta_s: float | None = None
    cancellable: bool = True
    error: str | None = None
    code: str | None = None
    message: str | None = None
    result: Any = None


class TaskCancelResponse(BaseModel):
    task_id: str
    canceled: bool
    was: Literal["queued", "running", "finished"]


class TranscribeCancelRequest(BaseModel):
    """POST /transcribe/cancel body (answer: ``{stopped: bool}``)."""

    job_id: str
