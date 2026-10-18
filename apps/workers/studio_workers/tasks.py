"""Background task queues (one worker thread each => strictly sequential).

Used for model pack downloads (GET /packs/tasks/{id}), the AI performance test (/perf), vision,
audio stems, style analysis, face swap and the agent evaluation. Tasks live in memory: a workers
restart forgets them, the api simply re-submits (404 TASK_NOT_FOUND).

Sprint 5 (docs/trabajo/sprint5-contratos.md M1): item counts (``set_items``), ETA, stage text and
cancellation. ``TaskQueue.cancel(id)``: a queued task never runs; a running one gets its
``cancel_event`` set and its ``on_cancel`` hooks called (close the Ollama request, kill the
subprocess tree). The task function stops with ``TaskCanceled`` — raised by ``check_canceled()`` or
automatically on the next progress update made from the task thread — and ends ``canceled``.
"""

from __future__ import annotations

import logging
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .task_schema import TaskCancelResponse, TaskPublic

log = logging.getLogger("studio_workers")

_KEEP = 200  # finished tasks kept for polling
TERMINAL = ("done", "error", "canceled")
# Same constants as JOB_ETA_MIN_ELAPSED_S / JOB_ETA_MIN_PROGRESS (packages/shared/src/job.ts).
ETA_MIN_ELAPSED_S = 10.0
ETA_MIN_PROGRESS = 0.02
# Progress updates from the task thread raise TaskCanceled once a cancel was requested.
_PROGRESS_FIELDS = frozenset({"progress", "current_file", "message", "bytes_done", "stage_es"})

_local = threading.local()


class TaskCanceled(Exception):  # noqa: N818 (contract name)
    """The task was canceled (TaskQueue.cancel): it ends with status ``canceled``."""


def current_task() -> Task | None:
    """The task running in this thread (engines use it to register ``on_cancel`` hooks)."""
    return getattr(_local, "task", None)


def kill_process_tree(proc: subprocess.Popen[Any] | int, *, wait_s: float = 10.0) -> None:
    """Kill a subprocess and its children (``taskkill /T /F`` on Windows, killpg on POSIX).

    POSIX: the group is killed only when the child leads its own (``start_new_session``);
    otherwise just the pid (killpg of our own group would kill the workers). With a Popen it
    waits for the exit (``wait_s``) so pipes reach EOF and VRAM is really freed."""
    pid = proc if isinstance(proc, int) else proc.pid
    if not isinstance(proc, int) and proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(  # noqa: S603 - fixed argv
                ["taskkill", "/T", "/F", "/PID", str(pid)],
                capture_output=True,
                check=False,
                timeout=10,
            )
        else:
            try:
                pgid = os.getpgid(pid)
                if pgid == pid and pgid != os.getpgrp():
                    os.killpg(pgid, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, OSError, subprocess.SubprocessError):
        pass
    if not isinstance(proc, int):
        try:
            proc.wait(timeout=wait_s)
        except subprocess.TimeoutExpired:
            log.warning("process %s did not exit after kill", pid)
        except Exception:  # noqa: BLE001 - best effort (proc already reaped elsewhere)
            pass


def new_group_kwargs() -> dict[str, Any]:
    """Popen kwargs: own process group/session so ``kill_process_tree`` reaches the children."""
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)}
    return {"start_new_session": True}


def on_cancel_kill(proc: subprocess.Popen[Any]) -> None:
    """Register ``kill_process_tree(proc)`` on the current task (no-op outside a task).

    If the cancel already arrived (between the spawn and this call) the process is killed now."""
    task = current_task()
    if task is None:
        return
    task.on_cancel.append(lambda: kill_process_tree(proc))
    if task.cancel_event.is_set():
        kill_process_tree(proc)


def _eta(
    progress: float,
    started: float | None,
    now: float,
    done: int | None,
    total: int | None,
    first_item_at: float | None,
    cached: int | None = None,
) -> float | None:
    """Mirror of estimateEtaS (packages/shared/src/job-progress.ts): ``cached`` items of ``done``
    took no time and are left out of the rate (no ETA until one real item finished)."""
    if started is None:
        return None
    if done is not None and total:
        if done >= total:
            return 0.0
        real = done - min(done, max(0, cached or 0))
        if real > 0:
            elapsed = max(0.0, now - (first_item_at or started))
            return round(elapsed / real * (total - done), 1) if elapsed > 0 else None
        return None
    elapsed = max(0.0, now - started)
    if progress >= 1:
        return 0.0
    if elapsed < ETA_MIN_ELAPSED_S or progress < ETA_MIN_PROGRESS:
        return None
    return round(elapsed * (1 - progress) / progress, 1)


@dataclass
class Task:
    id: str
    kind: str
    target: str
    status: str = "queued"  # queued | running | done | error | canceled
    progress: float = 0.0
    bytes_done: int = 0
    bytes_total: int = 0
    current_file: str | None = None
    error: str | None = None
    code: str | None = None
    message: str | None = None
    log: list[str] = field(default_factory=list)
    result: Any = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    # Sprint 5
    done: int | None = None
    total: int | None = None
    stage_es: str | None = None
    cancellable: bool = True
    started: float | None = None
    first_item_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    on_cancel: list[Callable[[], None]] = field(default_factory=list, repr=False)
    runner: int | None = field(default=None, repr=False)

    def __setattr__(self, name: str, value: Any) -> None:
        if (
            name in _PROGRESS_FIELDS
            and getattr(self, "runner", None) == threading.get_ident()
            and self.cancel_event.is_set()
        ):
            raise TaskCanceled(self.id)
        object.__setattr__(self, name, value)

    @property
    def canceled(self) -> bool:
        return self.cancel_event.is_set()

    def check_canceled(self) -> None:
        """Raise TaskCanceled when a cancel was requested (call between items/blocks)."""
        if self.cancel_event.is_set():
            raise TaskCanceled(self.id)

    def set_progress(self, done: int, total: int | None = None) -> None:
        self.bytes_done = max(0, int(done))
        if total:
            self.bytes_total = int(total)
        if self.bytes_total:
            self.progress = max(0.0, min(0.99, self.bytes_done / self.bytes_total))

    def set_items(self, done: int, total: int, stage_es: str | None = None) -> None:
        """Item counts (also ``progress = done/total``, at most 0.99) and the stage text."""
        total = max(1, int(total))
        done = max(0, min(int(done), total))
        if self.first_item_at is None:
            self.first_item_at = time.time() if done == 0 else (self.started or time.time())
        self.done = done
        self.total = total
        if stage_es is not None:
            self.stage_es = stage_es[:120]
            self.current_file = stage_es
        self.progress = max(0.0, min(0.99, done / total))

    def add_log(self, line: str) -> None:
        line = line.rstrip()
        if line:
            self.log.append(line)
            del self.log[:-30]
            self.message = line

    def eta_s(self, now: float | None = None) -> float | None:
        if self.status in ("done",):
            return 0.0
        if self.status != "running":
            return None
        return _eta(
            self.progress,
            self.started,
            time.time() if now is None else now,
            self.done,
            self.total,
            self.first_item_at,
        )

    def public_model(self) -> TaskPublic:
        return TaskPublic(
            task_id=self.id,
            kind=self.kind,
            target=self.target,
            status=self.status,  # type: ignore[arg-type]
            progress=round(max(0.0, min(1.0, self.progress)), 4),
            bytes_done=self.bytes_done,
            bytes_total=self.bytes_total,
            current_file=self.current_file,
            done=self.done,
            total=self.total,
            stage_es=self.stage_es,
            eta_s=self.eta_s(),
            cancellable=self.cancellable,
            error=self.error,
            code=self.code,
            message=self.message,
            result=self.result,
        )

    def public(self) -> dict[str, Any]:
        """TaskPublic as a dict (routers may add ``details``/``warnings``); None fields dropped."""
        return {k: v for k, v in self.public_model().model_dump().items() if v is not None}


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
                    if (
                        t.kind == kind
                        and t.target == target
                        and t.status in ("queued", "running")
                        and not t.cancel_event.is_set()
                    ):
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

    def cancel(self, task_id: str) -> TaskCancelResponse | None:
        """Cancel a task: queued -> canceled (never runs); running -> cancel_event + on_cancel
        hooks (the task ends ``canceled``); finished -> ``was: finished``. None = unknown id."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            if task.status in TERMINAL:
                return TaskCancelResponse(task_id=task_id, canceled=False, was="finished")
            was = "queued" if task.status == "queued" else "running"
            task.cancel_event.set()
            if was == "queued":
                task.status = "canceled"
                task.message = "Cancelado"
                task.finished = time.time()
            hooks = list(task.on_cancel)
        for hook in hooks:
            try:
                hook()
            except Exception as exc:  # a failing hook must not break the cancel
                log.warning("cancel hook of task %s failed: %s", task_id, exc)
        log.info("task %s (%s) cancel requested (%s)", task_id, task.kind, was)
        return TaskCancelResponse(task_id=task_id, canceled=True, was=was)  # type: ignore[arg-type]

    def wait(self, task_id: str, timeout: float = 30.0) -> Task | None:
        """Test helper: poll until the task finishes."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            task = self.get(task_id)
            if task is None or task.status in TERMINAL:
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
            if task.status == "canceled":  # canceled while queued
                self._q.task_done()
                continue
            task.started = time.time()
            task.status = "running"
            task.runner = threading.get_ident()
            _local.task = task
            try:
                result = fn(task)
                if task.cancel_event.is_set():
                    raise TaskCanceled(task.id)
                task.result = result
                object.__setattr__(task, "progress", 1.0)
                if task.total:
                    object.__setattr__(task, "done", task.total)
                task.status = "done"
            except TaskCanceled:
                task.status = "canceled"
                object.__setattr__(task, "message", "Cancelado")
            except Exception as exc:
                if task.cancel_event.is_set():
                    # The cancel hook broke the work (closed stream, killed process): canceled.
                    task.status = "canceled"
                    object.__setattr__(task, "message", "Cancelado")
                else:
                    log.warning("task %s (%s %s) failed: %s", task.id, task.kind, task.target, exc)
                    task.error = str(exc) or exc.__class__.__name__
                    code = getattr(exc, "code", None)
                    if code is None and exc.__class__.__name__ == "PackRequiredError":
                        code = "PACK_REQUIRED"
                    task.code = code if isinstance(code, str) else None
                    task.status = "error"
            finally:
                task.runner = None
                _local.task = None
                task.finished = time.time()
                self._q.task_done()


def cancel_or_404(q: TaskQueue, task_id: str) -> dict[str, Any]:
    """Body of ``POST /<area>/tasks/{id}/cancel``: TaskCancelResponse, or 404 TASK_NOT_FOUND."""
    res = q.cancel(task_id)
    if res is None:
        raise task_not_found(task_id)
    return res.model_dump()


def task_not_found(task_id: str) -> Exception:
    from .errors import TASK_NOT_FOUND_ES, CodedError  # lazy: errors imports heavy modules

    return CodedError("TASK_NOT_FOUND", TASK_NOT_FOUND_ES.format(id=task_id))
