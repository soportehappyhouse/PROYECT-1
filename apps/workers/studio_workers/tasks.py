"""Background task queues (one worker thread each => strictly sequential).

Used for model pack downloads (GET /packs/tasks/{id}) and the AI performance test (/perf).
Tasks live in memory: a workers restart forgets them, the api simply re-submits.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("studio_workers")

_KEEP = 200  # finished tasks kept for polling


@dataclass
class Task:
    id: str
    kind: str
    target: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    bytes_done: int = 0
    bytes_total: int = 0
    current_file: str | None = None
    error: str | None = None
    message: str | None = None
    log: list[str] = field(default_factory=list)
    result: Any = None
    created: float = field(default_factory=time.time)
    finished: float | None = None

    def set_progress(self, done: int, total: int | None = None) -> None:
        self.bytes_done = max(0, int(done))
        if total:
            self.bytes_total = int(total)
        if self.bytes_total:
            self.progress = max(0.0, min(0.99, self.bytes_done / self.bytes_total))

    def add_log(self, line: str) -> None:
        line = line.rstrip()
        if line:
            self.log.append(line)
            del self.log[:-30]
            self.message = line

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "task_id": self.id,
            "kind": self.kind,
            "target": self.target,
            "status": self.status,
            "progress": round(self.progress, 4),
            "bytes_done": self.bytes_done,
            "bytes_total": self.bytes_total,
            "current_file": self.current_file,
        }
        if self.error:
            out["error"] = self.error
        if self.message:
            out["message"] = self.message
        if self.result is not None:
            out["result"] = self.result
        return out


TaskFn = Callable[[Task], Any]


class TaskQueue:
    def __init__(self, name: str) -> None:
        self.name = name
        self._q: queue.Queue[tuple[Task, TaskFn]] = queue.Queue()
        self._tasks: dict[str, Task] = {}
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def submit(self, kind: str, target: str, fn: TaskFn, *, dedupe: bool = True) -> Task:
        with self._lock:
            if dedupe:
                for t in self._tasks.values():
                    if t.kind == kind and t.target == target and t.status in ("queued", "running"):
                        return t
            task = Task(id=uuid.uuid4().hex[:16], kind=kind, target=target)
            self._tasks[task.id] = task
            self._gc()
            self._q.put((task, fn))
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._run, name=f"tasks-{self.name}", daemon=True
                )
                self._thread.start()
            return task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def active(self) -> list[Task]:
        with self._lock:
            return [t for t in self._tasks.values() if t.status in ("queued", "running")]

    def wait(self, task_id: str, timeout: float = 30.0) -> Task | None:
        """Test helper: poll until the task finishes."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            task = self.get(task_id)
            if task is None or task.status in ("done", "error"):
                return task
            time.sleep(0.02)
        return self.get(task_id)

    def _gc(self) -> None:
        done = [t for t in self._tasks.values() if t.finished]
        for t in sorted(done, key=lambda t: t.finished or 0)[:-_KEEP]:
            self._tasks.pop(t.id, None)

    def _run(self) -> None:
        while True:
            try:
                task, fn = self._q.get(timeout=60)
            except queue.Empty:
                with self._lock:
                    if self._q.empty():
                        self._thread = None
                        return
                continue
            task.status = "running"
            try:
                task.result = fn(task)
                task.progress = 1.0
                task.status = "done"
            except Exception as exc:
                log.warning("task %s (%s %s) failed: %s", task.id, task.kind, task.target, exc)
                task.error = str(exc) or exc.__class__.__name__
                task.status = "error"
            finally:
                task.finished = time.time()
                self._q.task_done()
