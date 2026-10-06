"""/agent endpoints (mocked Ollama), bug report fallback and the agent-llm pack."""

from pathlib import Path

import pytest
from ollama_fake import FakeOllama

from studio_workers import packs, services
from studio_workers.agent.bugreport import H_ACTUAL, H_EXPECTED, H_STEPS, render_markdown
from studio_workers.agent.ollama_client import OllamaClient, PullProgress

MODEL = "qwen3:8b"
TITLE_PLAN = {
    "version": 1,
    "summary_es": "Título",
    "ops": [{"op": "add_text", "text": "Hola", "t": 3}],
}


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeOllama:
    f = FakeOllama([MODEL])
    monkeypatch.setattr(services, "ollama_client", f.client)
    monkeypatch.setattr(packs, "ollama_installed_models", lambda: list(f.models) if f.up else None)
    return f


# ------------------------------------------------------------------------------ status / plan


def test_status_ready(client, fake: FakeOllama) -> None:
    r = client.get("/agent/status").json()
    assert r["ollama"] is True and r["ready"] is True
    assert r["model"] == MODEL and r["models_installed"] == [MODEL]
    assert r["gpu_mode"] == "cpu" and r["ollama_version"] == "0.35.1" and r["hint_es"] is None


def test_status_without_ollama(client, fake: FakeOllama) -> None:
    fake.up = False
    r = client.get("/agent/status").json()
    assert r == {
        **r,
        "ollama": False,
        "ready": False,
        "models_installed": [],
        "model": MODEL,
    }
    assert r["hint_es"].startswith("Ollama no está corriendo")


def test_status_model_missing(client, fake: FakeOllama, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_MODEL", "hermes3:8b")
    services.reset()
    monkeypatch.setattr(services, "ollama_client", fake.client)
    r = client.get("/agent/status").json()
    assert r["ollama"] is True and r["ready"] is False and r["model"] == "hermes3:8b"
    assert "agent-llm" in r["hint_es"]


def test_plan_deterministic_needs_no_ollama(client, fake: FakeOllama) -> None:
    fake.up = False
    r = client.post("/agent/plan", json={"command": "cortá los silencios", "project_summary": ""})
    assert r.status_code == 200
    body = r.json()
    assert body["route"] == "deterministic" and body["model"] is None and body["attempts"] == 0
    assert body["plan"]["ops"] == [{"op": "cut_silences"}]


def test_plan_llm(client, fake: FakeOllama) -> None:
    fake.reply(TITLE_PLAN)
    r = client.post(
        "/agent/plan",
        json={
            "command": "poné un título que diga Hola en el 3",
            "project_summary": 'PISTAS:\n- V1 video "V": 0 clips',
            "settings": {"temperature": 0.5},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["route"] == "llm" and body["model"] == MODEL and body["attempts"] == 1
    assert body["plan"] == TITLE_PLAN and isinstance(body["latency_ms"], int)
    assert fake.chats[0]["options"]["temperature"] == 0.5


API_SUMMARY = {  # the api's JSON shape (apps/api services/agent/summary.ts) = dataset rows
    "canvas": {"w": 1920, "h": 1080, "fps": 30},
    "cursor_s": 3,
    "tracks": [
        {"kind": "video", "clips": [{"id": "c1", "name": "playa.mp4", "start": 0, "end": 12.5}]},
        {"kind": "audio", "clips": [{"id": "m1", "name": "musica.mp3", "start": 0, "end": 12.5}]},
    ],
}


def test_plan_with_api_json_summary_uses_fewshot_and_env_temperature(
    client, fake: FakeOllama, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The api sends the JSON summary; it reaches the prompt as compact JSON after the fixed
    few-shot pairs of prompts/fewshot_es.jsonl; AGENT_TEMPERATURE is the default temperature."""
    from studio_workers.agent.planner import fixed_examples

    monkeypatch.setenv("AGENT_TEMPERATURE", "0.35")
    services.reset()
    monkeypatch.setattr(services, "ollama_client", fake.client)
    fake.reply(TITLE_PLAN)
    r = client.post(
        "/agent/plan",
        json={"command": "poné un título que diga Hola en el 3", "project_summary": API_SUMMARY},
    )
    assert r.status_code == 200, r.text
    body = fake.chats[0]
    assert body["options"]["temperature"] == 0.35
    msgs = body["messages"]
    fixed = fixed_examples()
    assert len(fixed) == 8  # prompts/fewshot_es.jsonl is really used
    for i, ex in enumerate(fixed):
        assert msgs[1 + 2 * i]["content"].endswith(f"Pedido: {ex.command}")
    last = msgs[-1]["content"]
    assert '"tracks":[{"kind":"video","clips":[{"id":"c1","name":"playa.mp4"' in last
    assert last.endswith("Pedido: poné un título que diga Hola en el 3")
    # deterministic route with the same JSON: one audio clip -> set_volume by name
    r = client.post(
        "/agent/plan", json={"command": "bajá la música", "project_summary": API_SUMMARY}
    )
    assert r.json()["route"] == "deterministic"
    assert r.json()["plan"]["ops"] == [
        {"op": "set_volume", "clip": {"name": "musica"}, "volume_db": -12}
    ]


def test_plan_llm_unavailable_is_pack_required(client, fake: FakeOllama) -> None:
    fake.up = False
    r = client.post("/agent/plan", json={"command": "poné un título", "project_summary": ""})
    assert r.status_code == 409
    body = r.json()
    assert body["code"] == "PACK_REQUIRED" and body["packId"] == "agent-llm"
    assert "Ollama no está corriendo" in body["detail"]
    fake.up = True
    r = client.post(
        "/agent/plan",
        json={"command": "poné un título", "settings": {"model": "hermes3:8b"}},
    )
    assert r.status_code == 409 and "ollama pull hermes3:8b" in r.json()["detail"]


def test_plan_validates_request(client, fake: FakeOllama) -> None:
    assert client.post("/agent/plan", json={"command": ""}).status_code == 422


# ------------------------------------------------------------------------------ bug report


REQ = {
    "title": None,
    "steps_text": "Abrí el proyecto.\nExporté para reels.\nSe colgó en 80 %.",
    "breadcrumbs": [{"t": "12:00:01", "type": "nav", "message": "abrió editor"}, "click export"],
    "errors": [{"code": "EXPORT_FAILED", "message": "ffmpeg exited with code 1"}],
    "env": {"os": "Windows 11", "gpu": "RTX 4050", "version": "0.3.0"},
}


def test_bugreport_template_when_no_model(client, fake: FakeOllama) -> None:
    fake.models = []
    r = client.post("/agent/bugreport", json=REQ).json()
    md = r["markdown_es"]
    assert r["source"] == "template"
    assert md.startswith("# Error: EXPORT_FAILED ffmpeg exited with code 1")
    assert f"{H_STEPS}\n1. Abrí el proyecto.\n2. Exporté para reels.\n3. Se colgó en 80 %." in md
    assert f"{H_EXPECTED}\n(completá" in md
    assert f"{H_ACTUAL}\nApareció el error: EXPORT_FAILED ffmpeg exited with code 1" in md
    assert "- 12:00:01 nav abrió editor" in md and "- click export" in md
    assert "- gpu: RTX 4050" in md and "Plantilla automática" in md


def test_bugreport_requested_model_missing_is_template(client, fake: FakeOllama) -> None:
    r = client.post("/agent/bugreport", json={**REQ, "model": "no-existe:1b"}).json()
    assert r["source"] == "template" and r["warning"] == "model_missing:no-existe:1b"
    assert fake.chats == []


def test_bugreport_template_when_ollama_down(client, fake: FakeOllama) -> None:
    fake.up = False
    r = client.post("/agent/bugreport", json={"steps_text": "No anda el botón"}).json()
    assert r["source"] == "template" and r["markdown_es"].startswith("# No anda el botón")
    assert "Ollama no está corriendo" in r["warning"]


def test_bugreport_llm(client, fake: FakeOllama) -> None:
    fake.reply(
        {
            "title": "La exportación para Reels se cuelga",
            "steps": ["Abrir un proyecto", "Exportar con el preset Reels / TikTok"],
            "expected": "Que termine la exportación",
            "actual": "Se queda en 80 % y aparece «ffmpeg exited with code 1»",
            "notes": "",
        }
    )
    r = client.post("/agent/bugreport", json=REQ).json()
    assert r["source"] == "llm" and r["model"] == MODEL
    md = r["markdown_es"]
    assert md.startswith("# La exportación para Reels se cuelga\n")
    assert "1. Abrir un proyecto\n2. Exportar con el preset Reels / TikTok" in md
    assert "## Errores registrados\n- `EXPORT_FAILED ffmpeg exited with code 1`" in md
    assert "Redactado localmente con qwen3:8b" in md
    assert fake.chats[0]["format"]["required"] == ["title", "steps", "expected", "actual"]


def test_bugreport_llm_garbage_falls_back(client, fake: FakeOllama) -> None:
    fake.reply("no json")
    r = client.post("/agent/bugreport", json=REQ).json()
    assert r["source"] == "template" and r["warning"].startswith("llm_failed")


def test_render_markdown_single_paragraph() -> None:
    md = render_markdown({"steps_text": "Abrí el video. Toqué quitar fondo. Se cerró."})
    assert "1. Abrí el video.\n2. Toqué quitar fondo.\n3. Se cerró." in md


# ------------------------------------------------------------------------------ pack


def test_pack_detection_via_tags(client, fake: FakeOllama) -> None:
    row = next(p for p in client.get("/packs").json() if p["id"] == "agent-llm")
    assert row["installed"] is True and row["group"] == "agent"
    assert row["files"] == [
        {"name": "servicio Ollama", "size": 0, "present": True},
        {"name": "ollama:qwen3:8b", "size": 5_225_000_000, "present": True},
    ]
    fake.models = []
    row = next(p for p in client.get("/packs").json() if p["id"] == "agent-llm")
    assert row["installed"] is False and row["files"][1]["present"] is False
    fake.up = False
    row = next(p for p in client.get("/packs").json() if p["id"] == "agent-llm")
    assert row["installed"] is False and row["files"][0]["present"] is False


def test_pack_model_follows_agent_model_env(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_MODEL", "qwen3:0.6b")
    services.reset()
    monkeypatch.setattr(packs, "ollama_installed_models", lambda: ["qwen3:0.6b"])
    _storage, models = dirs
    row = packs.pack_status(packs.PACKS["agent-llm"], models)
    assert row["installed"] is True
    assert row["files"][1] == {"name": "ollama:qwen3:0.6b", "size": 523_000_000, "present": True}


def test_pack_download_pulls_through_ollama(client, dirs, fake: FakeOllama, monkeypatch) -> None:
    _storage, models = dirs
    fake.models = []

    async def pull(self: OllamaClient, model: str, on_progress=None) -> None:
        for done in (0, 2_000_000_000, 5_225_000_000):
            on_progress(PullProgress("pulling", done, 5_225_000_000))
        fake.models.append(model)

    monkeypatch.setattr(OllamaClient, "pull", pull)
    r = client.post("/packs/agent-llm/download")
    task = services.pack_queue().wait(r.json()["task_id"], timeout=30)
    assert task is not None and task.status == "done", task and task.error
    assert task.result["downloaded"] == ["ollama:qwen3:8b"]
    assert task.bytes_total == 5_225_000_000
    manifest = (models / "manifest.json").read_text("utf-8")
    assert '"agent-llm"' in manifest and '"qwen3:8b"' in manifest
    # second run: already in Ollama -> skipped
    task2 = services.pack_queue().wait(
        client.post("/packs/agent-llm/download").json()["task_id"], timeout=30
    )
    assert task2.status == "done" and task2.result["skipped"] == ["ollama:qwen3:8b"]


def test_pack_download_without_ollama_explains(client, fake: FakeOllama) -> None:
    fake.up = False
    task = services.pack_queue().wait(
        client.post("/packs/agent-llm/download").json()["task_id"], timeout=30
    )
    assert task.status == "error" and "Ollama no está corriendo" in task.error
    assert "winget install Ollama.Ollama" in task.error


def test_registry_lists_the_ollama_model(dirs) -> None:
    _storage, models = dirs
    import json

    data = json.loads(packs.write_registry(models).read_text("utf-8"))
    agent = next(p for p in data["packs"] if p["id"] == "agent-llm")
    assert agent["files"][0]["name"] == "ollama qwen3:8b"
    assert agent["files"][0]["source"].startswith("ollama pull qwen3:8b")


def test_real_pull_progress_mapping_from_fake_stream(tmp_path: Path) -> None:
    import asyncio

    fake = FakeOllama([])
    seen: list[int] = []
    asyncio.run(fake.client().pull("qwen3:0.6b", lambda p: seen.append(p.completed)))
    assert seen[-1] == 1000 and "qwen3:0.6b" in fake.models
