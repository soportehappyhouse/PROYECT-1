"""Sprint 3b stems: overlap-add separation with a mocked htdemucs, /audio/stems task, pack."""

import math
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studio_workers import packs
from studio_workers.audio import stems as stems_mod
from studio_workers.audio.stems import (
    HTDEMUCS_SOURCES,
    SAMPLE_RATE,
    Separator,
    StemsEngine,
    _StemWriters,
    chunk_offsets,
    segment_for,
    separate_array,
)
from studio_workers.config import get_settings
from studio_workers.gpu import GPU_FALLBACK_CPU, GpuBudget, VramInfo
from studio_workers.routers import audio as audio_router

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")

# Deterministic "model": every source is a fixed fraction of the (normalized) mix.
GAINS = {"drums": 0.2, "bass": 0.1, "other": 0.1, "vocals": 0.6}


def fake_separator(calls: list[int] | None = None) -> Separator:
    def run(chunk: np.ndarray, segment_s: float) -> np.ndarray:
        assert chunk.dtype == np.float32 and chunk.ndim == 2
        assert chunk.shape[-1] <= int(SAMPLE_RATE * segment_s)
        if calls is not None:
            calls.append(chunk.shape[-1])
        return np.stack([GAINS[s] * chunk for s in HTDEMUCS_SOURCES])

    return Separator(sources=HTDEMUCS_SOURCES, run=run)


def _read(path: Path) -> tuple[np.ndarray, int, int]:
    with wave.open(str(path), "rb") as wf:
        rate, ch = wf.getframerate(), wf.getnchannels()
        pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2").astype(np.float32)
    return pcm.reshape(-1, ch).T / 32768.0, rate, ch


def test_chunking_and_segment_choice() -> None:
    seg = int(SAMPLE_RATE * 7.0)
    offs = chunk_offsets(SAMPLE_RATE * 20, seg)
    assert offs[0] == 0 and offs[1] == int(0.75 * seg) and offs[-1] < SAMPLE_RATE * 20
    assert segment_for(6141) == 7.0  # RTX 4050 6 GB
    assert segment_for(None) == 7.0
    assert segment_for(12_288) == 7.8


@pytest.mark.parametrize("mode", ["two", "four"])
def test_overlap_add_reconstructs_linear_model(tmp_path: Path, mode: str) -> None:
    n = int(SAMPLE_RATE * 16.3)  # 3 chunks of 7 s (stride 5.25 s) + a short tail
    t = np.arange(n) / SAMPLE_RATE
    mix = np.stack(
        [0.5 * np.sin(2 * math.pi * 220 * t), 0.3 * np.sin(2 * math.pi * 330 * t + 1)]
    ).astype(np.float32)
    names = stems_mod.STEMS[mode]
    writers = _StemWriters({k: tmp_path / f"x-{k}.wav" for k in names})
    calls: list[int] = []
    seen: list[float] = []
    chunks = separate_array(
        mix,
        fake_separator(calls),
        names,
        writers,
        segment_s=7.0,
        progress=lambda f, _m: seen.append(f),
    )
    writers.close()
    assert chunks == len(calls) == 4
    assert seen == sorted(seen) and seen[-1] == 1.0
    mean = float(mix.mean(axis=0).mean())
    for name in names:
        data, rate, ch = _read(tmp_path / f"x-{name}.wav")
        assert (rate, ch) == (SAMPLE_RATE, 2) and data.shape == mix.shape
        if name == "no_vocals":
            expected = 0.4 * (mix - mean) + 3 * mean
        else:
            expected = GAINS[name] * (mix - mean) + mean
        assert np.abs(data - expected).max() < 2e-4, name


def test_stems_requires_pack(client: TestClient, dirs) -> None:
    storage, _ = dirs
    (storage / "media" / "a.wav").write_bytes(b"x")
    res = client.post(
        "/audio/stems", json={"path": "media/a.wav", "mode": "two", "output_base": "renders/s"}
    )
    assert res.status_code == 409
    assert res.json()["packId"] == "stems"


def _tone_noise(dst: Path, seconds: int = 9) -> Path:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}:sample_rate=22050",
         "-f", "lavfi", "-i", f"anoisesrc=d={seconds}:c=pink:a=0.1:r=22050",
         "-filter_complex", "amix=inputs=2:normalize=0", str(dst)],
        check=True, timeout=60,
    )  # fmt: skip
    return dst


@needs_ffmpeg
@pytest.mark.parametrize(
    ("mode", "names"),
    [("two", ["vocals", "no_vocals"]), ("four", ["vocals", "drums", "bass", "other"])],
)
def test_stems_task_with_mocked_model(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch, mode: str, names: list[str]
) -> None:
    storage, _ = dirs
    _tone_noise(storage / "media" / "mix.wav")
    devices: list[str] = []

    def loader(device: str) -> Separator:
        devices.append(device)
        return fake_separator()

    engine = StemsEngine(get_settings(), loader=loader)
    monkeypatch.setattr(audio_router, "stems_engine", lambda: engine)
    res = client.post(
        "/audio/stems",
        json={"path": "media/mix.wav", "mode": mode, "output_base": "renders/job1"},
    )
    assert res.status_code == 200, res.text
    tid = res.json()["task_id"]
    from studio_workers.services import audio_queue

    task = audio_queue().wait(tid, 60)
    assert task is not None and task.status == "done", task and task.error
    body = client.get(f"/audio/tasks/{tid}").json()
    assert body["status"] == "done" and body["progress"] == 1.0
    result = body["result"]
    assert result["sample_rate"] == 44_100 and result["device"] == "cpu"
    assert result["segment"] == 7.0 and result["chunks"] == 2
    assert list(result["stems"]) == names
    for name in names:
        rel = result["stems"][name]
        assert rel == f"renders/job1-{name}.wav"
        data, rate, ch = _read(storage / rel)
        assert (rate, ch) == (44_100, 2)
        assert abs(data.shape[-1] / rate - 9.0) < 0.05
    assert devices == ["cpu"]
    assert client.get("/audio/tasks/nope").status_code == 404


@needs_ffmpeg
def test_stems_cuda_failure_falls_back_to_cpu(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    from studio_workers import services

    services.reset()
    src = _tone_noise(storage / "media" / "mix.wav", seconds=3)
    devices: list[str] = []

    def loader(device: str) -> Separator:
        devices.append(device)
        if device == "cuda":

            def boom(_c: np.ndarray, _s: float) -> np.ndarray:
                raise RuntimeError("CUDA out of memory")

            return Separator(sources=HTDEMUCS_SOURCES, run=boom)
        return fake_separator()

    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("RTX 4050", 6141, 5000, "test"))
    engine = StemsEngine(get_settings(), budget=budget, loader=loader)
    res = engine.separate(src, storage / "renders" / "s", "two")
    assert devices == ["cuda", "cpu"] and res["device"] == "cpu"
    assert res["warnings"] == [GPU_FALLBACK_CPU] and res["segment"] == 7.0
    assert all(p.is_file() for p in res["paths"].values())


@needs_ffmpeg
def test_stems_low_vram_runs_on_cpu_with_warning(dirs) -> None:
    storage, _ = dirs
    src = _tone_noise(storage / "media" / "mix.wav", seconds=2)
    settings = get_settings().model_copy(update={"use_cuda": True})
    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("GPU", 4096, 1500, "test"))
    devices: list[str] = []
    engine = StemsEngine(
        settings, budget=budget, loader=lambda d: devices.append(d) or fake_separator()
    )
    res = engine.separate(src, storage / "renders" / "s", "four")
    assert devices == ["cpu"] and res["warnings"] == [GPU_FALLBACK_CPU]


def test_stems_pack_detection(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    _, models = dirs
    pack = packs.PACKS["stems"]
    assert packs.FEATURE_PACKS["audio.stems"] == "stems"
    assert "MIT" in pack.license and pack.approx_size > 80_000_000
    mods = {r.module for r in pack.pip}
    assert {"demucs", "dora", "openunmix", "julius", "einops"} <= mods
    assert all(r.no_deps for r in pack.pip if r.module in {"demucs", "openunmix", "julius"})
    (item,) = pack.build_items(models)
    assert item.url.startswith("https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/")
    assert item.rel == "demucs/955717e8-8726e21a.th"

    monkeypatch.setattr(packs, "module_present", lambda m: True)
    monkeypatch.setattr(stems_mod, "module_present", lambda m: True)
    st = packs.pack_status(pack, models, use_cuda=False)
    assert st["installed"] is False  # no weights yet
    assert StemsEngine(get_settings()).available() is False
    weights = packs.stems_weights_path(models)
    weights.parent.mkdir(parents=True)
    with weights.open("wb") as fh:  # sparse file: passes min_bytes without writing 80 MB
        fh.truncate(80_000_000)
    st = packs.pack_status(pack, models, use_cuda=False)
    assert st["installed"] is True and st["id"] == "stems"
    assert StemsEngine(get_settings()).available() is True

    monkeypatch.setattr(packs, "module_present", lambda m: m != "demucs")
    st = packs.pack_status(pack, models, use_cuda=False)
    assert st["installed"] is False


# --------------------------------------------------------------- audit fixes (sprint 3b review)
def _write_wav(path: Path, mix: np.ndarray) -> None:
    pcm = (np.clip(mix, -1, 1) * 32767).round().astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(mix.shape[0])
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.T.copy().tobytes())


def test_wav_streaming_matches_in_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Long files are read chunk by chunk from disk; same output as the whole array in RAM."""
    n = int(SAMPLE_RATE * 12.4)
    t = np.arange(n) / SAMPLE_RATE
    mix = np.stack([0.4 * np.sin(2 * math.pi * 200 * t) + 0.05, 0.3 * np.cos(2 * math.pi * 90 * t)])
    _write_wav(tmp_path / "mix.wav", mix.astype(np.float32))
    monkeypatch.setattr(stems_mod, "STATS_BLOCK_FRAMES", 40_000)  # several stats blocks
    with stems_mod._WavMix(tmp_path / "mix.wav") as src:
        in_ram = src.read(0, src.length)  # what the old code loaded at once
        assert in_ram.shape == (2, n)
        mean, std = src.stats()
        ref = in_ram.mean(axis=0)
        assert abs(mean - float(ref.mean())) < 1e-6 and abs(std - float(ref.std())) < 1e-6
        names = stems_mod.STEMS["four"]
        w1 = _StemWriters({k: tmp_path / f"disk-{k}.wav" for k in names})
        chunks = separate_array(src, fake_separator(), names, w1, segment_s=7.0)
        w1.close()
    w2 = _StemWriters({k: tmp_path / f"ram-{k}.wav" for k in names})
    separate_array(in_ram, fake_separator(), names, w2, segment_s=7.0)
    w2.close()
    assert chunks == 3
    for k in names:
        a, _, _ = _read(tmp_path / f"disk-{k}.wav")
        b, _, _ = _read(tmp_path / f"ram-{k}.wav")
        assert a.shape == b.shape == (2, n) and np.abs(a - b).max() < 1e-4, k


def test_wav_mix_upmixes_mono(tmp_path: Path) -> None:
    _write_wav(tmp_path / "m.wav", np.full((1, 100), 0.25, dtype=np.float32))
    with stems_mod._WavMix(tmp_path / "m.wav") as src:
        assert (src.channels, src.length) == (2, 100)
        assert src.read(90, 50).shape == (2, 10)  # clipped at the end


def test_to_wav_downmixes_to_stereo(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from studio_workers import media

    calls: list[list[str]] = []
    monkeypatch.setattr(media, "run_ffmpeg", lambda args, **_k: calls.append(list(args)))
    media.to_wav(tmp_path / "in.mov", tmp_path / "o.wav", sample_rate=44_100, channels=2)
    media.to_wav(tmp_path / "in.mov", tmp_path / "o.wav", mono=True)
    media.to_wav(tmp_path / "in.mov", tmp_path / "o.wav")
    assert calls[0][calls[0].index("-ac") + 1] == "2" and "-ar" in calls[0]
    assert calls[1][calls[1].index("-ac") + 1] == "1"
    assert "-ac" not in calls[2]


def test_stems_decodes_51_as_stereo(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    storage, _ = dirs
    seen: list[dict] = []

    def fake_to_wav(src: Path, dst: Path, **kw) -> None:
        seen.append(kw)
        _write_wav(dst, np.zeros((2, SAMPLE_RATE), dtype=np.float32))

    monkeypatch.setattr(stems_mod, "to_wav", fake_to_wav)
    engine = StemsEngine(get_settings(), loader=lambda _d: fake_separator())
    monkeypatch.setattr(engine, "require", lambda: None)
    res = engine.separate(storage / "media" / "x.mov", storage / "renders" / "s", "two")
    assert seen == [{"sample_rate": SAMPLE_RATE, "channels": 2}]
    assert res["duration_s"] == 1.0 and all(p.is_file() for p in res["paths"].values())


def _weights(models: Path, payload: bytes) -> tuple[Path, str]:
    import hashlib

    path = packs.stems_weights_path(models)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path, hashlib.sha256(payload).hexdigest()


def test_verify_weights_prefix_manifest_and_pinned(
    dirs, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _, models = dirs
    path, sha = _weights(models, b"htdemucs weights")
    # wrong name prefix -> refused
    with pytest.raises(RuntimeError, match="Pesos htdemucs dañados"):
        stems_mod.verify_weights(path, models)
    # right prefix, no full hash pinned: accepted with a warning (TODO in packs.py)
    monkeypatch.setattr(stems_mod, "WEIGHTS_SHA_PREFIX", sha[:8])
    with caplog.at_level("WARNING", logger="studio_workers"):
        assert stems_mod.verify_weights(path, models) == sha
    assert "sin fijar" in caplog.text
    # first download recorded in models/manifest.json; a later change is refused
    from studio_workers.models_manifest import Manifest

    man = Manifest.load(models)
    man.record(
        "demucs/955717e8-8726e21a.th", name="w", group="stems:htdemucs", source="t", sha256=sha
    )
    man.save()
    assert stems_mod.verify_weights(path, models) == sha
    man.files["demucs/955717e8-8726e21a.th"]["sha256"] = "0" * 64
    man.save()
    with pytest.raises(RuntimeError, match="cambiaron"):
        stems_mod.verify_weights(path, models)
    # pinned exact size + full sha256 (like matting-hq)
    monkeypatch.setattr(stems_mod, "WEIGHTS_SHA256", sha)
    monkeypatch.setattr(stems_mod, "WEIGHTS_SIZE", path.stat().st_size)
    assert stems_mod.verify_weights(path, models) == sha
    monkeypatch.setattr(stems_mod, "WEIGHTS_SIZE", path.stat().st_size + 1)
    with pytest.raises(RuntimeError, match="bytes"):
        stems_mod.verify_weights(path, models)
    monkeypatch.setattr(stems_mod, "WEIGHTS_SIZE", path.stat().st_size)
    monkeypatch.setattr(stems_mod, "WEIGHTS_SHA256", sha[:8] + "f" * 56)
    with pytest.raises(RuntimeError, match="dañados"):
        stems_mod.verify_weights(path, models)


def test_demucs_loader_checks_before_torch_load(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    _, models = dirs
    _weights(models, b"tampered pickle")
    loads: list[str] = []
    fake_torch = types.ModuleType("torch")
    fake_torch.load = lambda *a, **k: loads.append(a[0])  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    for name in ("demucs", "demucs.apply", "demucs.states"):
        mod = types.ModuleType(name)
        mod.apply_model = mod.load_model = lambda *a, **k: None  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, name, mod)
    engine = StemsEngine(get_settings())
    with pytest.raises(RuntimeError, match="dañados"):
        engine._demucs_loader("cpu")
    assert loads == []  # never unpickled


def test_stems_pack_integrity_fields() -> None:
    (item,) = packs.PACKS["stems"].build_items(Path("/m"))
    if packs.STEMS_WEIGHTS_SHA256 is None:  # TODO(sha256) in packs.py
        assert item.expected.min_bytes == 70_000_000 and item.expected.sha256 is None
    else:
        assert item.expected.sha256 == packs.STEMS_WEIGHTS_SHA256
        assert item.expected.size_bytes == packs.STEMS_WEIGHTS_EXACT_SIZE


@needs_ffmpeg
def test_stems_cancel_on_cuda_keeps_gpu_state(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit D2: a cancel during the CUDA pass is not a CUDA failure (no CPU retry, no
    «usando CPU», the budget keeps its resident)."""
    from studio_workers.tasks import TaskCanceled

    storage, _ = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    from studio_workers import services

    services.reset()
    src = _tone_noise(storage / "media" / "mix.wav", seconds=3)
    devices: list[str] = []

    def loader(device: str) -> Separator:
        devices.append(device)

        def canceled(_c: np.ndarray, _s: float) -> np.ndarray:
            raise TaskCanceled("t")

        return Separator(sources=HTDEMUCS_SOURCES, run=canceled)

    budget = GpuBudget(use_cuda=True, probe=lambda: VramInfo("RTX 4050", 6141, 5000, "test"))
    engine = StemsEngine(get_settings(), budget=budget, loader=loader)
    with pytest.raises(TaskCanceled):
        engine.separate(src, storage / "renders" / "s", "two")
    assert devices == ["cuda"]
    assert budget.last_fallback is None and budget.resident is not None
