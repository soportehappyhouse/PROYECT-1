"""Voice cleanup (DeepFilterNet mocked) and the AI performance test."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers.config import get_settings
from studio_workers.denoise import DenoiseEngine
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo
from studio_workers.routers import audio as audio_router

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")


def _noisy(dst: Path) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
            "-i", "anoisesrc=d=1:c=pink:a=0.2", "-ar", "22050", str(dst),
        ],
        check=True,
        timeout=60,
    )  # fmt: skip
    return dst


def test_denoise_requires_pack(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "a.wav").write_bytes(b"x")
    res = client.post("/audio/denoise", json={"path": "media/a.wav", "output_base": "renders/a"})
    assert res.status_code == 409
    assert res.json()["packId"] == "voz-limpia"


@needs_ffmpeg
def test_denoise_with_mocked_backend(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _ = dirs
    _noisy(storage / "media" / "voz.wav")
    calls: list[tuple[str, str]] = []

    def backend(src: Path, dst: Path, device: str) -> None:
        import wave

        with wave.open(str(src), "rb") as wf:
            calls.append((str(wf.getframerate()), device))
        shutil.copyfile(src, dst)

    engine = DenoiseEngine(get_settings(), backend=backend)
    monkeypatch.setattr(audio_router, "denoise_engine", lambda: engine)
    res = client.post(
        "/audio/denoise", json={"path": "media/voz.wav", "output_base": "renders/voz-limpia"}
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"path": "renders/voz-limpia.wav", "device": "cpu"}
    assert calls == [("48000", "cpu")]  # resampled to DeepFilterNet's 48 kHz mono
    mp3 = client.post(
        "/audio/denoise",
        json={"path": "media/voz.wav", "output_base": "renders/voz-limpia", "format": "mp3"},
    ).json()
    assert mp3["path"] == "renders/voz-limpia.mp3"
    assert (storage / "renders" / "voz-limpia.mp3").stat().st_size > 0


@needs_ffmpeg
def test_denoise_cuda_failure_falls_back_to_cpu(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    from studio_workers import services

    services.reset()
    src = _noisy(storage / "media" / "voz.wav")
    devices: list[str] = []

    def backend(s: Path, d: Path, device: str) -> None:
        devices.append(device)
        if device == "cuda":
            raise RuntimeError("CUDA out of memory")
        shutil.copyfile(s, d)

    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 6144, 5000, "test"))
    engine = DenoiseEngine(get_settings(), budget=budget, backend=backend)
    engine._backend = None  # use the budget path ...
    engine._df_backend = backend  # ... with the fake as the "real" backend
    monkeypatch.setattr(engine, "available", lambda: True)
    out, device, warnings = engine.denoise(src, storage / "renders" / "x.wav")
    assert devices == ["cuda", "cpu"] and device == "cpu"
    assert warnings == [GPU_FALLBACK_CPU] and out.is_file()


def test_perf_run_writes_json_and_reports_skips(client: TestClient, dirs) -> None:
    storage, _ = dirs
    tid = client.post("/perf/run").json()["task_id"]
    from studio_workers.services import perf_queue

    task = perf_queue().wait(tid, 120)
    assert task is not None and task.status == "done", task and task.error
    status = client.get(f"/perf/tasks/{tid}").json()
    assert status["status"] == "done"
    data = json.loads((storage / "run" / "perf.json").read_text("utf-8"))
    for key in (
        "gpu",
        "whisper_turbo_s_per_min",
        "piper_s_per_100chars",
        "rvc_s_per_min",
        "scenes_fps",
        "cpu_fallback_ok",
        "ran_at",
    ):
        assert key in data
    assert data["gpu"] == "cpu" and data["gpu_status"]["mode"] == "cpu"
    assert isinstance(data["cpu_fallback_ok"], bool)
    # no whisper/piper models in the temp MODELS_DIR: skipped with a reason, not an error
    assert "piper" in data["skipped"] and "rvc" in data["skipped"]
    assert "whisper" in data["skipped"] or "whisper_turbo" in data["skipped"]
    if data["scenes_fps"] is None:
        assert "scenes" in data["skipped"] or "scenes" in data["errors"]
    assert client.get("/perf/last").json()["ran_at"] == data["ran_at"]


@needs_ffmpeg
def test_perf_measures_whisper_turbo_and_cpu_fallback(
    dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from studio_workers import perf, services
    from studio_workers.stt.engine import WhisperEngine

    _, models = dirs
    for repo in ("mobiuslabsgmbh--faster-whisper-large-v3-turbo", "Systran--faster-whisper-base"):
        snap = models / "whisper" / f"models--{repo}" / "snapshots" / "s"
        snap.mkdir(parents=True)
        (snap / "model.bin").write_bytes(b"x")
        (snap / "config.json").write_text("{}")
    runs: list[tuple[str, str]] = []

    class Fake:
        def transcribe(self, path, **kw):
            return iter([]), SimpleNamespace(language="es", duration=60.0)

    def factory(name, device, compute, root):
        runs.append((name, device))
        return Fake()

    engine = WhisperEngine(get_settings(), factory=factory)
    fake_services = SimpleNamespace(
        gpu_budget=services.gpu_budget,
        whisper_engine=lambda: engine,
        tts_providers=services.tts_providers,
        rvc_engine=services.rvc_engine,
    )
    monkeypatch.setattr(perf, "services", fake_services)
    real_present = perf.module_present
    monkeypatch.setattr(
        perf, "module_present", lambda m: True if m == "faster_whisper" else real_present(m)
    )
    data = perf.run_perf(get_settings())
    assert data["whisper_turbo_s_per_min"] is not None and data["whisper_model"] == "base"
    assert data["cpu_fallback_ok"] is True
    assert ("large-v3-turbo", "cpu") in runs and ("base", "cpu") in runs
