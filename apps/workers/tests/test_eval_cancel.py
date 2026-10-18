"""Sprint 5: «Evaluar modelos» quick mode, progress per command and real cancellation (the
request to Ollama is closed, so Ollama stops generating)."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.agent import eval as ev
from studio_workers.agent.ollama_client import OllamaClient
from studio_workers.agent.planner import load_examples

MODEL = "qwen3:8b"


class SlowOllama:
    """Ollama fake whose /api/chat takes ``delay`` seconds; records closed (canceled) chats."""

    def __init__(self, delay: float = 30.0, models: list[str] | None = None) -> None:
        self.delay = delay
        self.models = [MODEL] if models is None else models
        self.chats_started = threading.Event()
        self.closed: list[float] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.35.1"})
        if path == "/api/tags":
            return httpx.Response(
                200, json={"models": [{"name": m, "model": m, "size": 1} for m in self.models]}
            )
        if path == "/api/ps":
            return httpx.Response(200, json={"models": []})
        if path == "/api/chat":
            self.chats_started.set()
            try:
                await asyncio.sleep(self.delay)
            except asyncio.CancelledError:
                self.closed.append(time.monotonic())
                raise
            plan = {"version": 1, "summary_es": "x", "ops": [{"op": "transcribe"}]}
            return httpx.Response(
                200,
                json={
                    "model": MODEL,
                    "message": {"role": "assistant", "content": json.dumps(plan)},
                },
            )
        return httpx.Response(404, json={"error": "not found"})

    def client(self, **_: Any) -> OllamaClient:
        return OllamaClient("http://127.0.0.1:11434", transport=httpx.MockTransport(self.handle))


@pytest.fixture
def slow(monkeypatch: pytest.MonkeyPatch, dirs) -> SlowOllama:
    fake = SlowOllama()
    monkeypatch.setattr(services, "ollama_client", fake.client)
    return fake


def test_select_quick_is_deterministic_and_diverse() -> None:
    examples = load_examples("golden")
    ids = ev.dataset_ids("golden")
    a = ev.select_quick(examples, 20, ids)
    b = ev.select_quick(list(reversed(examples)), 20, ids)
    assert len(a) == 20
    assert [e.command for e in a] == [e.command for e in b]
    first_ops = {(ev.ops_of(e.plan) or [{"op": "?"}])[0].get("op") for e in a}
    assert len(first_ops) >= 8
    assert [e.command for e in a] != [e.command for e in examples[:20]]


def test_cancel_closes_the_ollama_request_quickly(client: TestClient, slow: SlowOllama) -> None:
    r = client.post("/agent/eval", json={"models": [MODEL], "use_router": False})
    assert r.status_code == 200, r.text
    task_id = r.json()["task_id"]
    assert slow.chats_started.wait(10)
    state = client.get(f"/agent/tasks/{task_id}").json()
    assert state["status"] == "running"
    assert state["total"] == 20 and state["done"] == 0
    assert state["stage_es"] == f"{MODEL} · 0/20"
    t0 = time.monotonic()
    res = client.post(f"/agent/tasks/{task_id}/cancel").json()
    assert res == {"task_id": task_id, "canceled": True, "was": "running"}
    task = services.agent_queue().wait(task_id, 5)
    assert task is not None and task.status == "canceled"
    assert time.monotonic() - t0 < 2.0
    assert slow.closed, "the transport must see the chat request closed"
    assert slow.closed[0] - t0 < 2.0


def test_quick_mode_reports_items_and_writes_mode(
    client: TestClient, slow: SlowOllama, dirs
) -> None:
    slow.delay = 0.0
    r = client.post("/agent/eval", json={"models": [MODEL], "use_router": False})
    task = services.agent_queue().wait(r.json()["task_id"], 30)
    assert task is not None and task.status == "done", task and task.error
    pub = task.public()
    assert pub["done"] == pub["total"] == 20
    assert pub["stage_es"] == f"{MODEL} · 20/20"
    storage, _ = dirs
    data = json.loads((storage / "run" / "agent-eval.json").read_text("utf-8"))
    assert data["mode"] == "quick" and data["n"] == 20 and data["canceled"] is False


def test_no_model_fails_with_pack_required(client: TestClient, slow: SlowOllama, dirs) -> None:
    slow.models = []
    r = client.post("/agent/eval", json={"models": [MODEL], "use_router": False, "mode": "full"})
    task = services.agent_queue().wait(r.json()["task_id"], 10)
    assert task is not None and task.status == "error"
    assert task.code == "PACK_REQUIRED"
    assert "ollama pull" in (task.error or "") or "Ollama" in (task.error or "")
    storage, _ = dirs
    assert not (storage / "run" / "agent-eval.json").exists()
