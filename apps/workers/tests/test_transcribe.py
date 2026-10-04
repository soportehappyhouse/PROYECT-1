from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.progress import registry
from studio_workers.routers import transcribe as transcribe_router
from studio_workers.stt.engine import WhisperEngine


class FakeModel:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[dict] = []

    def transcribe(self, path: str, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("Library cublas64_12.dll is not found")
        words = [
            SimpleNamespace(start=0.0, end=0.4, word=" Hola", probability=0.9),
            SimpleNamespace(start=0.5, end=1.0, word=" mundo", probability=1.2),
        ]
        segs = [SimpleNamespace(start=0.0, end=1.0, text=" Hola mundo", words=words)]
        return iter(segs), SimpleNamespace(language="es", duration=2.0)


@pytest.fixture
def fake_engine(dirs, monkeypatch: pytest.MonkeyPatch):
    created: list[tuple[str, str, str]] = []
    models: dict[str, FakeModel] = {}

    def factory(name: str, device: str, compute: str, root: str) -> FakeModel:
        created.append((name, device, compute))
        models[device] = FakeModel(fail=device == "cuda")
        return models[device]

    engine = WhisperEngine(get_settings(), factory=factory)
    monkeypatch.setattr(transcribe_router, "whisper_engine", lambda: engine)
    monkeypatch.setattr(transcribe_router, "require_module", lambda *_: None)
    return engine, created, models


def _audio(storage: Path) -> str:
    (storage / "tmp" / "a.wav").write_bytes(b"RIFF")
    return "tmp/a.wav"


def test_transcribe_writes_json_srt_ass(client: TestClient, dirs, fake_engine) -> None:
    storage, _ = dirs
    _, created, models = fake_engine
    res = client.post(
        "/transcribe",
        json={
            "inputPath": _audio(storage),
            "language": "es",
            "model": "base",
            "wordTimestamps": True,
            "jobId": "j1",
            "outputBase": "renders/j1",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["language"] == "es" and body["durationSec"] == 2.0
    assert body["segments"][0]["text"] == "Hola mundo"
    words = body["segments"][0]["words"]
    assert [w["word"] for w in words] == ["Hola", "mundo"]
    assert words[1]["probability"] == 1.0  # clamped to the shared schema range
    assert body["files"] == {
        "jsonPath": "renders/j1.json",
        "srt": "renders/j1.srt",
        "ass": "renders/j1.ass",
    }
    assert (storage / "renders" / "j1.ass").is_file()
    assert created == [("base", "cpu", "int8")]
    call = models["cpu"].calls[0]
    assert call["vad_filter"] is True and call["word_timestamps"] is True
    assert call["vad_parameters"] == {"min_silence_duration_ms": 500}
    progress = client.get("/jobs/j1").json()
    assert progress["status"] == "succeeded" and progress["progress"] == 1.0


def test_model_cache_and_auto_language(client: TestClient, dirs, fake_engine) -> None:
    storage, _ = dirs
    _, created, models = fake_engine
    path = _audio(storage)
    for _ in range(2):
        res = client.post("/transcribe", json={"inputPath": path, "language": "auto"})
        assert res.status_code == 200
    assert len(created) == 1  # lazy load once, then cached
    assert models["cpu"].calls[0]["language"] is None


def test_cuda_falls_back_to_cpu(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USE_CUDA", "true")
    services.reset()
    created: list[tuple[str, str, str]] = []

    def factory(name, device, compute, root):
        created.append((name, device, compute))
        return FakeModel(fail=device == "cuda")

    storage, _ = dirs
    audio = storage / "tmp" / "a.wav"
    audio.write_bytes(b"x")
    engine = WhisperEngine(get_settings(), factory=factory)
    result = engine.transcribe(audio, model="small")
    assert result.device == "cpu"
    assert created == [("small", "cuda", "float16"), ("small", "cpu", "int8")]


def test_rejects_traversal_and_missing_files(client: TestClient, fake_engine) -> None:
    assert client.post("/transcribe", json={"inputPath": "../x.wav"}).status_code == 400
    res = client.post("/transcribe", json={"inputPath": "tmp/none.wav"})
    assert res.status_code == 404
    assert res.json()["code"] == "NOT_FOUND"


def test_unknown_model_is_400(client: TestClient, dirs, fake_engine) -> None:
    storage, _ = dirs
    res = client.post("/transcribe", json={"inputPath": _audio(storage), "model": "gigante"})
    assert res.status_code == 400


def test_progress_registry_failure_state() -> None:
    with pytest.raises(RuntimeError), registry.track("bad", "x"):
        raise RuntimeError("boom")
    item = registry.get("bad")
    assert item is not None and item.status == "failed" and item.error == "boom"
