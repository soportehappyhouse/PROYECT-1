"""Sprint 5 audit D1: cancelling a task kills its subprocess tree (GPL RVM, SAM/ffmpeg)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from studio_workers.config import get_settings
from studio_workers.tasks import (
    Task,
    TaskQueue,
    kill_process_tree,
    new_group_kwargs,
    on_cancel_kill,
)
from studio_workers.vision import gpl
from studio_workers.vision.matte import MatteEngine

# Long-running child that spawns a grandchild and prints RVM-like progress lines forever.
_FAKE_CHILD = r"""
import json, subprocess, sys, time
g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(json.dumps({"event": "start", "grandchild": g.pid}), flush=True)
i = 0
while True:
    i += 1
    print(json.dumps({"event": "progress", "progress": 0.001, "frame": i, "frames": 10**6,
                      "fps": 1}), flush=True)
    time.sleep(0.05)
"""


def _gone(pid: int) -> bool:
    """The process no longer runs (missing, or a zombie waiting for an init that never reaps)."""
    if sys.platform == "win32":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, check=False
        ).stdout
        return str(pid) not in out
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return True
    status = Path(f"/proc/{pid}/status")
    return status.is_file() and "State:\tZ" in status.read_text()


def _wait_gone(pid: int, timeout: float = 10) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if _gone(pid):
            return True
        time.sleep(0.05)
    return False


def _spawn_fake(**kw: Any) -> subprocess.Popen[str]:
    return subprocess.Popen(  # noqa: S603 - fixed argv
        [sys.executable, "-c", _FAKE_CHILD],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **{**new_group_kwargs(), **kw},
    )


def _grandchild(proc: subprocess.Popen[str]) -> int:
    assert proc.stdout is not None
    return int(json.loads(proc.stdout.readline())["grandchild"])


def test_kill_process_tree_kills_child_and_grandchild() -> None:
    proc = _spawn_fake()
    grandchild = _grandchild(proc)
    kill_process_tree(proc)
    assert proc.poll() is not None  # waited
    assert _wait_gone(grandchild)
    kill_process_tree(proc)  # already dead: no error
    for pipe in (proc.stdout, proc.stderr):
        assert pipe is not None
        pipe.close()


def test_kill_process_tree_without_own_group_does_not_kill_us() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])  # noqa: S603
    kill_process_tree(proc)
    assert proc.poll() is not None  # the pytest process (same group) is still alive


def test_on_cancel_kill_registers_hook_and_cancel_kills_the_child() -> None:
    q = TaskQueue("kill")
    seen: dict[str, Any] = {}
    ready = threading.Event()

    def fn(task: Task) -> None:
        proc = _spawn_fake()
        seen["proc"] = proc
        seen["grandchild"] = _grandchild(proc)
        on_cancel_kill(proc)
        seen["hooks"] = len(task.on_cancel)
        ready.set()
        assert proc.stdout is not None
        for _ in proc.stdout:  # ends when the cancel hook kills the child
            pass
        proc.wait()
        task.check_canceled()

    task = q.submit("k", "a", fn)
    assert ready.wait(10)
    assert seen["hooks"] == 1
    q.cancel(task.id)
    done = q.wait(task.id, 10)
    assert done is not None and done.status == "canceled"
    assert seen["proc"].poll() is not None
    assert _wait_gone(seen["grandchild"])


def test_on_cancel_kill_outside_a_task_is_a_noop() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])  # noqa: S603
    on_cancel_kill(proc)
    assert proc.wait(10) == 0


def _engine_with_fake_gpl(monkeypatch: pytest.MonkeyPatch, spawned: list[Any]) -> MatteEngine:
    engine = MatteEngine(get_settings(), budget=None)
    monkeypatch.setattr(engine, "gpl_status", lambda: {"state": "ready", "python": "py"})
    real_popen = subprocess.Popen

    def fake_popen(cmd: list[str], **kw: Any) -> subprocess.Popen[str]:
        # gpl.subprocess is the shared module: other Popen users (e.g. subprocess.run of
        # ``taskkill /T /F`` in kill_process_tree on Windows) must reach the real one.
        if cmd[1:3] != ["-m", "vision_gpl.rvm"]:
            return real_popen(cmd, **kw)  # noqa: S603
        proc = real_popen([sys.executable, "-c", _FAKE_CHILD], **kw)  # noqa: S603
        spawned.append(proc)
        return proc

    monkeypatch.setattr(gpl.subprocess, "Popen", fake_popen)
    return engine


@pytest.mark.parametrize("how", ["cancel_hook", "progress_raises"])
def test_rvm_cancel_terminates_the_gpl_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, how: str
) -> None:
    spawned: list[subprocess.Popen[str]] = []
    engine = _engine_with_fake_gpl(monkeypatch, spawned)
    q = TaskQueue("rvm")
    progressed = threading.Event()

    def notify_progress(task: Task):
        def notify(p: float, msg: str) -> None:
            task.progress = p  # raises TaskCanceled once a cancel was requested
            progressed.set()

        return notify

    def fn(task: Task) -> Any:
        if how == "progress_raises":
            # No kill hook: only the TaskCanceled raised inside on_event stops the loop, and
            # the finally of run_rvm must still kill the subprocess.
            monkeypatch.setattr(gpl, "on_cancel_kill", lambda proc: None)
        return engine._rvm(
            tmp_path / "in.mp4",
            tmp_path / "out.webm",
            tmp_path,
            None,
            50,
            notify_progress(task),
        )

    task = q.submit("vision.matte", "a", fn)
    assert progressed.wait(15)
    q.cancel(task.id)
    done = q.wait(task.id, 15)
    assert done is not None and done.status == "canceled", done and done.error
    assert len(spawned) == 1
    proc = spawned[0]
    assert proc.poll() is not None  # the GPL child is dead, not holding VRAM
    assert proc.stdout is not None and proc.stdout.closed
    assert engine._rvm_proc is None
