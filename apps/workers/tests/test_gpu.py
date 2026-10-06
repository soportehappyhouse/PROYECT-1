"""GPU budget: one resident model, unload-before-load, CPU fallback with warnings."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo, whisper_vram_mb
from studio_workers.routers import transcribe as transcribe_router
from studio_workers.stt.engine import WhisperEngine

CONTRACT_KEYS = {
    "cuda",
    "gpu_name",
    "vram_total_mb",
    "vram_free_mb",
    "resident_model",
    "mode",
    "sysmem_fallback",
}


def _probe(free: int, total: int = 6144):
    return lambda: VramInfo("NVIDIA GeForce RTX 4050 Laptop GPU", total, free, "nvidia-smi")


def test_unload_before_loading_another() -> None:
    budget = GpuBudget(use_cuda=True, probe=_probe(5000))
    unloaded: list[str] = []
    assert budget.acquire("whisper", 1800, lambda: unloaded.append("whisper")).device == "cuda"
    assert budget.resident == "whisper"
    # same model again: no unload
    assert budget.acquire("whisper", 1800, lambda: unloaded.append("x")).device == "cuda"
    assert unloaded == []
    assert budget.acquire("rvc", 1500, lambda: unloaded.append("rvc")).device == "cuda"
    assert unloaded == ["whisper"] and budget.resident == "rvc"
    assert budget.release() == "rvc" and unloaded == ["whisper", "rvc"]
    assert budget.resident is None and budget.release() is None


def test_cpu_fallback_when_vram_is_short() -> None:
    budget = GpuBudget(use_cuda=True, probe=_probe(1500), reserve_mb=800)
    decision = budget.acquire("whisper", 1800, lambda: None)
    assert decision.device == "cpu" and decision.warnings == [GPU_FALLBACK_CPU]
    assert budget.resident is None and budget.status()["last_fallback"] == "whisper"
    assert budget.status()["warnings"] == ["gpu_fallback_cpu"]


def test_acquire_releases_external_models_only_when_short() -> None:
    """Two-way with Ollama: a short GPU first asks the external_release hook, probes again."""
    state = {"free": 1500}
    calls: list[str] = []

    def release() -> list[str]:
        calls.append("ollama")
        state["free"] = 5500
        return ["qwen3:8b"]

    probe = lambda: VramInfo("RTX 4050", 6144, state["free"], "nvidia-smi")  # noqa: E731
    budget = GpuBudget(use_cuda=True, probe=probe, external_release=release)
    assert budget.acquire("whisper", 1800, lambda: None).device == "cuda"
    assert calls == ["ollama"] and budget.last_external_release == ["qwen3:8b"]
    # enough VRAM: the hook is not called
    assert budget.acquire("rvc", 1500, lambda: None).device == "cuda" and calls == ["ollama"]


def test_acquire_falls_back_to_cpu_when_release_does_not_help() -> None:
    budget = GpuBudget(
        use_cuda=True, probe=_probe(1000), external_release=lambda: []
    )  # Ollama had nothing loaded
    d = budget.acquire("whisper", 1800, lambda: None)
    assert d.device == "cpu" and d.warnings == [GPU_FALLBACK_CPU]

    def boom() -> list[str]:
        raise RuntimeError("ollama down")

    budget = GpuBudget(use_cuda=True, probe=_probe(1000), external_release=boom)
    assert budget.acquire("whisper", 1800, lambda: None).device == "cpu"


def test_make_room_never_evicts_ollama() -> None:
    calls: list[str] = []
    budget = GpuBudget(
        use_cuda=True, probe=_probe(1000), external_release=lambda: calls.append("x") or []
    )
    budget.acquire("tiny", 100, lambda: None)
    assert budget.make_room(5500) == "tiny" and calls == []


def test_unknown_vram_still_tries_cuda_and_cpu_without_use_cuda() -> None:
    assert GpuBudget(use_cuda=True, probe=lambda: None).acquire("m", 9999, lambda: None).device == (
        "cuda"
    )
    assert GpuBudget(use_cuda=False, probe=_probe(6000)).acquire("m", 1, lambda: None).device == (
        "cpu"
    )


def test_status_contract_and_sysmem_heuristic() -> None:
    budget = GpuBudget(use_cuda=True, probe=_probe(5000))
    st = budget.status()
    assert set(st) >= CONTRACT_KEYS
    assert st["cuda"] is True and st["mode"] == "gpu" and st["vram_total_mb"] == 6144
    assert st["sysmem_fallback"] is False
    budget.acquire("whisper", 100, lambda: None)
    budget._probe = _probe(20)  # VRAM full while a model is resident -> driver spills to RAM
    budget._cache = None
    assert budget.status()["sysmem_fallback"] is True


def test_whisper_vram_estimates() -> None:
    assert whisper_vram_mb("large-v3-turbo", "float16") == 1800
    assert whisper_vram_mb("large-v3-turbo", "int8_float16") < 1800


def test_gpu_endpoints_cpu_only(client: TestClient) -> None:
    st = client.get("/gpu/status").json()
    assert set(st) >= CONTRACT_KEYS
    assert st["mode"] == "cpu" and st["resident_model"] is None
    rel = client.post("/gpu/release").json()
    assert rel["released"] is None and rel["mode"] == "cpu"
    health = client.get("/health").json()
    assert set(health["gpu"]) >= CONTRACT_KEYS
    assert set(health["packs"]) >= {"core", "whisper-turbo", "scenes", "voz-limpia"}


class _FakeModel:
    def transcribe(self, path: str, **kwargs):
        seg = SimpleNamespace(start=0.0, end=1.0, text=" hola", words=[])
        return iter([seg]), SimpleNamespace(language="es", duration=1.0)


def _turbo_snapshot(models: Path) -> None:
    snap = (
        models
        / "whisper"
        / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
        / "snapshots"
        / "abc"
    )
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"x")
    (snap / "config.json").write_text("{}")


def test_whisper_defaults_to_turbo_fp16_on_cuda(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, models = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    services.reset()
    _turbo_snapshot(models)
    created: list[tuple[str, str, str]] = []

    def factory(name, device, compute, root):
        created.append((name, device, compute))
        return _FakeModel()

    budget = GpuBudget(use_cuda=True, probe=_probe(5000))
    engine = WhisperEngine(get_settings(), factory=factory, budget=budget)
    audio = storage / "tmp" / "a.wav"
    audio.write_bytes(b"x")
    result = engine.transcribe(audio)
    assert created == [("large-v3-turbo", "cuda", "float16")]
    assert result.model_used == "large-v3-turbo" and result.device == "cuda"
    assert result.warnings is None
    assert budget.resident == "whisper:large-v3-turbo:float16"
    budget.release()
    assert engine._models == {}  # the unload callback dropped the CUDA model


def test_whisper_falls_back_to_cpu_and_whisper_model_when_vram_short(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, models = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    monkeypatch.setenv("WHISPER_MODEL", "base")
    services.reset()
    _turbo_snapshot(models)
    created: list[tuple[str, str, str]] = []

    def factory(name, device, compute, root):
        created.append((name, device, compute))
        return _FakeModel()

    budget = GpuBudget(use_cuda=True, probe=_probe(1000))
    engine = WhisperEngine(get_settings(), factory=factory, budget=budget)
    monkeypatch.setattr(transcribe_router, "whisper_engine", lambda: engine)
    monkeypatch.setattr(transcribe_router, "require_module", lambda *_: None)
    (storage / "tmp" / "a.wav").write_bytes(b"x")
    body = client.post("/transcribe", json={"inputPath": "tmp/a.wav"}).json()
    # turbo does not fit -> CPU, and on CPU the lighter WHISPER_MODEL is used instead of turbo
    assert created == [("base", "cpu", "int8")]
    assert body["model_used"] == "base" and body["device"] == "cpu"
    assert body["warnings"] == [GPU_FALLBACK_CPU]
