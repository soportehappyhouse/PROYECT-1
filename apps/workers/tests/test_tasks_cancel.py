"""Sprint 5: TaskQueue cancellation, item counts, ETA and the cancel routes."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.task_schema import TaskPublic
from studio_workers.tasks import Task, TaskCanceled, TaskQueue, _eta


def _blocking(started: threading.Event, release: threading.Event):
    def fn(task: Task) -> str:
        started.set()
        for i in range(1000):
            task.check_canceled()
            task.set_items(i % 10, 10, f"Bloque {i % 10} de 10")
            if release.wait(0.01):
                return "ok"
        return "ok"

    return fn


def test_cancel_running_task_calls_hooks_and_ends_canceled() -> None:
    q = TaskQueue("t")
    started, release = threading.Event(), threading.Event()
    task = q.submit("k", "a", _blocking(started, release))
    assert started.wait(2)
    hooked: list[str] = []
    task.on_cancel.append(lambda: hooked.append("killed"))
    res = q.cancel(task.id)
    assert res is not None and res.canceled and res.was == "running"
    done = q.wait(task.id, 3)
    assert done is not None and done.status == "canceled"
    assert hooked == ["killed"]
    assert done.error is None
    # Finished: nothing to cancel.
    again = q.cancel(task.id)
    assert again is not None and not again.canceled and again.was == "finished"
    assert q.cancel("nope") is None


def test_cancel_queued_task_never_runs() -> None:
    q = TaskQueue("t")
    started, release = threading.Event(), threading.Event()
    first = q.submit("k", "a", _blocking(started, release))
    ran: list[str] = []
    second = q.submit("k", "b", lambda t: ran.append("ran"))
    assert started.wait(2)
    res = q.cancel(second.id)
    assert res is not None and res.was == "queued" and res.canceled
    release.set()
    assert q.wait(first.id, 3).status == "done"  # type: ignore[union-attr]
    time.sleep(0.1)
    assert q.get(second.id).status == "canceled"  # type: ignore[union-attr]
    assert ran == []


def test_progress_update_after_cancel_raises_in_the_task_thread() -> None:
    q = TaskQueue("t")
    started = threading.Event()
    go = threading.Event()

    def fn(task: Task) -> None:
        started.set()
        go.wait(2)
        task.progress = 0.5  # cancel requested -> TaskCanceled here
        raise AssertionError("not reached")

    task = q.submit("k", "x", fn)
    assert started.wait(2)
    q.cancel(task.id)
    # Setting progress from another thread (the router) never raises.
    task.message = "hola"
    go.set()
    assert q.wait(task.id, 3).status == "canceled"  # type: ignore[union-attr]


def test_public_is_a_valid_task_public_with_eta() -> None:
    q = TaskQueue("t")
    started, release = threading.Event(), threading.Event()
    task = q.submit("agent.eval", "qwen3:8b", _blocking(started, release))
    assert started.wait(2)
    time.sleep(0.05)
    pub = task.public()
    model = TaskPublic(**pub)
    assert model.status == "running" and model.total == 10 and model.stage_es
    assert model.cancellable is True
    release.set()
    done = q.wait(task.id, 3)
    assert done is not None and done.status == "done"
    assert TaskPublic(**done.public()).eta_s == 0.0
    assert done.public()["done"] == 10


def test_eta_mirrors_estimate_eta_s() -> None:
    # 4 of 20 in 40 s since the first item -> 160 s left.
    assert _eta(0.2, 0.0, 45.0, 4, 20, 5.0) == 160
    assert _eta(0.0, 0.0, 60.0, 0, 20, 0.0) is None
    assert _eta(0.5, 0.0, 9.0, None, None, None) is None
    assert _eta(0.25, 0.0, 20.0, None, None, None) == 60
    # Audit D3: cached items are left out of the rate (same cases as job-progress.test.ts).
    assert _eta(0.5, 0.0, 20.0, 10, 20, 0.0, cached=8) == 100
    assert _eta(0.5, 0.0, 0.5, 8, 20, 0.0, cached=8) is None


def test_errors_keep_their_code() -> None:
    from studio_workers.errors import CodedError

    q = TaskQueue("t")

    def fn(task: Task) -> None:
        raise CodedError("TOOL_FAILED", "falló")

    task = q.submit("k", "x", fn)
    done = q.wait(task.id, 3)
    assert done is not None and done.status == "error" and done.code == "TOOL_FAILED"
    assert TaskPublic(**done.public()).code == "TOOL_FAILED"


@pytest.mark.parametrize(
    ("area", "queue_fn"),
    [
        ("vision", lambda: services.vision_queue()),
        ("audio", lambda: services.audio_queue()),
        ("perf", lambda: services.perf_queue()),
        ("packs", lambda: services.pack_queue()),
        ("agent", lambda: services.agent_queue()),
        ("style", None),
    ],
)
def test_cancel_routes(client: TestClient, area: str, queue_fn) -> None:
    if queue_fn is None:
        from studio_workers.routers.style import style_queue

        queue_fn = style_queue
    started, release = threading.Event(), threading.Event()
    task = queue_fn().submit(f"{area}.test", "x", _blocking(started, release))
    assert started.wait(2)
    r = client.post(f"/{area}/tasks/{task.id}/cancel")
    assert r.status_code == 200, r.text
    assert r.json() == {"task_id": task.id, "canceled": True, "was": "running"}
    assert queue_fn().wait(task.id, 3).status == "canceled"
    r = client.get(f"/{area}/tasks/{task.id}")
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    missing = client.post(f"/{area}/tasks/nope/cancel")
    assert missing.status_code == 404
    assert missing.json()["code"] == "TASK_NOT_FOUND"
    assert "ya no existe en la IA local" in missing.json()["detail"]


def test_agent_task_not_found(client: TestClient) -> None:
    r = client.get("/agent/tasks/nope")
    assert r.status_code == 404 and r.json()["code"] == "TASK_NOT_FOUND"


def test_task_canceled_is_an_exception() -> None:
    assert issubclass(TaskCanceled, Exception)
