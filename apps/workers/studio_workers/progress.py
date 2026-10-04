"""In-memory progress registry polled by the api through GET /jobs/{jobId}.

Worker calls are synchronous (the queue lives in the api). While a long call runs in FastAPI's
threadpool, the api polls this registry with the same jobId it sent in the request body.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

from .schemas import JobProgress

_TTL_SEC = 3600.0


class ProgressRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, JobProgress]] = {}

    def update(
        self,
        job_id: str | None,
        progress: float | None = None,
        message: str | None = None,
        status: str | None = None,
        error: str | None = None,
    ) -> None:
        if not job_id:
            return
        with self._lock:
            self._gc()
            current = self._items.get(job_id, (0.0, JobProgress(job_id=job_id, status="running")))[
                1
            ]
            data = current.model_dump()
            if progress is not None:
                data["progress"] = max(0.0, min(1.0, float(progress)))
            if message is not None:
                data["message"] = message
            if status is not None:
                data["status"] = status
            if error is not None:
                data["error"] = error
            self._items[job_id] = (time.monotonic(), JobProgress(**data))

    def get(self, job_id: str) -> JobProgress | None:
        with self._lock:
            item = self._items.get(job_id)
            return item[1] if item else None

    def _gc(self) -> None:
        now = time.monotonic()
        for key in [k for k, (ts, _) in self._items.items() if now - ts > _TTL_SEC]:
            del self._items[key]

    @contextmanager
    def track(self, job_id: str | None, message: str) -> Iterator[None]:
        """Mark a job running, then succeeded/failed when the block exits."""
        self.update(job_id, 0.0, message, status="running")
        try:
            yield
        except Exception as exc:
            self.update(job_id, message="Error", status="failed", error=str(exc))
            raise
        self.update(job_id, 1.0, "Listo", status="succeeded")


registry = ProgressRegistry()
