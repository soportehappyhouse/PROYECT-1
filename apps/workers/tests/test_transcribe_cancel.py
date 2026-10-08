"""Sprint 5: POST /transcribe/cancel stops a running transcription between segments."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from studio_workers.config import get_settings
from studio_workers.routers import transcribe as transcribe_router
from studio_workers.schemas import TranscribeRequest
from studio_workers.stt.engine import WhisperEngine
from studio_workers.tasks import TaskCanceled


class SlowModel:
    """50 segments of 1 s, 20 ms each to decode."""

    def __init__(self) -> None:
        self.yielded = 0

    def transcribe(self, path: str, **kwargs):
        def gen():
            for i in range(50):
                time.sleep(0.02)
                self.yielded += 1
                yield SimpleNamespace(start=float(i), end=i + 1.0, text=f" seg {i}", words=[])

        return gen(), SimpleNamespace(language="es", duration=50.0)


@pytest.fixture
def slow_engine(dirs, monkeypatch: pytest.MonkeyPatch) -> SlowModel:
    model = SlowModel()
    engine = WhisperEngine(get_settings(), factory=lambda *a, **k: model)
    monkeypatch.setattr(transcribe_router, "whisper_engine", lambda: engine)
    monkeypatch.setattr(transcribe_router, "require_module", lambda *_: None)
    return model


def test_cancel_stops_between_segments(dirs, slow_engine: SlowModel) -> None:
    storage, _ = dirs
    (storage / "tmp" / "a.wav").write_bytes(b"RIFF")
    req = TranscribeRequest(input_path="tmp/a.wav", job_id="j1", word_timestamps=False)
    outcome: dict[str, object] = {}

    def run() -> None:
        try:
            outcome["result"] = transcribe_router.transcribe(req)
        except TaskCanceled as exc:
            outcome["canceled"] = exc

    th = threading.Thread(target=run)
    th.start()
    deadline = time.monotonic() + 5
    while slow_engine.yielded < 5 and time.monotonic() < deadline:
        time.sleep(0.01)
    stopped = transcribe_router.transcribe_cancel(
        transcribe_router.TranscribeCancelRequest(job_id="j1")
    )
    assert stopped == {"stopped": True}
    th.join(5)
    assert "canceled" in outcome
    assert slow_engine.yielded < 50
    # Nothing left registered for the job.
    assert transcribe_router.transcribe_cancel(
        transcribe_router.TranscribeCancelRequest(job_id="j1")
    ) == {"stopped": False}


def test_cancel_route_unknown_job(client: TestClient) -> None:
    r = client.post("/transcribe/cancel", json={"job_id": "nope"})
    assert r.status_code == 200 and r.json() == {"stopped": False}
    # Audit D10: the unused progress route is gone.
    assert client.get("/transcribe/progress/nope").status_code == 404


def test_cancel_during_module_check_is_not_lost(
    client: TestClient, dirs, slow_engine: SlowModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit D10: the cancel event is registered before require_module; the canceled call
    answers 499 JSON (TaskCanceled handler), not a 500 with a traceback."""
    storage, _ = dirs
    (storage / "tmp" / "a.wav").write_bytes(b"RIFF")

    def slow_check(*_a: object) -> None:  # e.g. a cold import of faster_whisper
        assert transcribe_router.transcribe_cancel(
            transcribe_router.TranscribeCancelRequest(job_id="j2")
        ) == {"stopped": True}

    monkeypatch.setattr(transcribe_router, "require_module", slow_check)
    r = client.post(
        "/transcribe", json={"inputPath": "tmp/a.wav", "jobId": "j2", "wordTimestamps": False}
    )
    assert r.status_code == 499
    assert r.json() == {"detail": "Cancelado", "code": "TASK_CANCELED"}
    assert slow_engine.yielded == 0


def test_cancel_on_cuda_keeps_the_gpu_model(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit D2: TaskCanceled on CUDA must not unload the model nor mark the budget failed."""
    from studio_workers.gpu import GpuBudget, VramInfo

    loaded: list[str] = []

    class CancelingModel:
        def transcribe(self, path: str, **kwargs):
            def gen():
                raise TaskCanceled("j")
                yield  # pragma: no cover

            return gen(), SimpleNamespace(language="es", duration=5.0)

    def factory(name: str, device: str, ctype: str, root: str) -> CancelingModel:
        loaded.append(device)
        return CancelingModel()

    settings = get_settings().model_copy(update={"use_cuda": True})
    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 6144, 5000, "t"))
    engine = WhisperEngine(settings, budget=budget, factory=factory)
    storage, _ = dirs
    audio = storage / "tmp" / "a.wav"
    audio.write_bytes(b"RIFF")
    progress: list[str] = []
    with pytest.raises(TaskCanceled):
        engine.transcribe(audio, on_progress=lambda p, m: progress.append(m))
    assert loaded == ["cuda"]  # no CPU retry
    assert engine._models  # the CUDA model stays loaded (no cold reload next time)
    assert budget.last_fallback is None and budget.resident is not None
    assert not any("CPU" in m for m in progress)
