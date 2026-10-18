"""Sprint 6 M3: TaskQueue is a priority queue (user 0 before background 5, FIFO within)."""

from __future__ import annotations

import threading

from studio_workers.task_schema import TASK_PRIORITY_BACKGROUND, TASK_PRIORITY_USER
from studio_workers.tasks import Task, TaskQueue


def _blocker(q: TaskQueue) -> tuple[Task, threading.Event, threading.Event]:
    started, release = threading.Event(), threading.Event()

    def fn(task: Task) -> str:
        started.set()
        assert release.wait(10)
        return "blocker"

    task = q.submit("block", "b", fn)
    assert started.wait(5)
    return task, started, release


def test_user_task_runs_before_earlier_background_tasks() -> None:
    q = TaskQueue("prio-test")
    order: list[str] = []
    blocker, _, release = _blocker(q)

    def make(name: str):
        def fn(task: Task) -> str:
            order.append(name)
            return name

        return fn

    bg = [
        q.submit("bg", f"bg{i}", make(f"bg{i}"), priority=TASK_PRIORITY_BACKGROUND)
        for i in range(3)
    ]
    user = q.submit("user", "u", make("user"), priority=TASK_PRIORITY_USER)
    release.set()
    for t in [blocker, *bg, user]:
        assert q.wait(t.id, 10).status == "done"
    assert order == ["user", "bg0", "bg1", "bg2"]
    assert user.priority == 0 and bg[0].priority == 5


def test_fifo_within_same_priority_and_old_signature() -> None:
    q = TaskQueue("fifo-test")
    order: list[int] = []
    blocker, _, release = _blocker(q)
    tasks = []
    for i in range(5):

        def fn(task: Task, i: int = i) -> int:
            order.append(i)
            return i

        # old signature: no priority keyword (defaults to the user priority)
        tasks.append(q.submit("same", f"t{i}", fn))
    release.set()
    for t in [blocker, *tasks]:
        assert q.wait(t.id, 10).status == "done"
    assert order == [0, 1, 2, 3, 4]
    assert all(t.priority == TASK_PRIORITY_USER for t in tasks)


def test_canceled_background_task_never_runs_and_dedupe_still_works() -> None:
    q = TaskQueue("cancel-prio")
    ran: list[str] = []
    blocker, _, release = _blocker(q)
    bg = q.submit("bg", "x", lambda t: ran.append("bg"), priority=TASK_PRIORITY_BACKGROUND)
    same = q.submit("bg", "x", lambda t: ran.append("dup"), priority=TASK_PRIORITY_BACKGROUND)
    assert same.id == bg.id
    assert q.cancel(bg.id).was == "queued"
    user = q.submit("user", "u", lambda t: ran.append("user"))
    release.set()
    assert q.wait(user.id, 10).status == "done"
    assert q.wait(blocker.id, 10).status == "done"
    assert q.get(bg.id).status == "canceled"
    assert ran == ["user"]


def test_priority_ties_do_not_compare_tasks() -> None:
    """Same priority + seq never ties, so Task objects (not orderable) are never compared."""
    q = TaskQueue("tie")
    tasks = [q.submit("k", str(i), lambda t: None, priority=5, dedupe=False) for i in range(20)]
    for t in tasks:
        assert q.wait(t.id, 10).status == "done"
