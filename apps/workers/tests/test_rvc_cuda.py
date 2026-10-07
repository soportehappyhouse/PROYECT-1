"""Sprint 4 (M3): RVC on CUDA — device selection, GPU budget + idle release, RVC_MODEL_INCOMPATIBLE,
CPU fallback and the hubert download source (mirror fallback). No torch, no network."""

from __future__ import annotations

import pickle
import shutil
import sys
import time
import types
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from studio_workers import rvc_engine as rvc_mod
from studio_workers import services
from studio_workers.config import get_settings
from studio_workers.gpu import GpuBudget, VramInfo
from studio_workers.models_manifest import Manifest
from studio_workers.routers import rvc as rvc_router
from studio_workers.rvc_engine import RvcEngine


def _models(models: Path) -> None:
    voice = models / "rvc" / "mi_voz"
    voice.mkdir(parents=True)
    (voice / "mi_voz.pth").write_bytes(b"pth")
    base = models / "rvc" / "_base"
    (base / "hubert_base").mkdir(parents=True)
    (base / "hubert_base" / "config.json").write_text("{}")
    (base / "hubert_base" / "pytorch_model.bin").write_bytes(b"w")
    (base / "rmvpe.pt").write_bytes(b"r")


class Loader:
    instances: list[Loader] = []
    fail_with: BaseException | None = None
    fail_devices: tuple[str, ...] = ()

    def __init__(self, only_cpu: bool, hubert: str | None, rmvpe: str | None) -> None:
        self.only_cpu = only_cpu
        self.conf: dict = {}
        self.calls = 0
        Loader.instances.append(self)

    def apply_conf(self, **kwargs) -> None:  # type: ignore[no-untyped-def]
        self.conf = kwargs

    def generate_from_cache(self, path: str, tag: str):  # type: ignore[no-untyped-def]
        self.calls += 1
        device = "cpu" if self.only_cpu else "cuda"
        if Loader.fail_with is not None and device in Loader.fail_devices:
            raise Loader.fail_with
        return [0.0] * 16000, 16000


@pytest.fixture
def cuda_env(dirs, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    storage, models = dirs
    monkeypatch.setenv("USE_CUDA", "true")
    services.reset()
    _models(models)
    (storage / "media" / "voz.wav").write_bytes(b"wav")
    Loader.instances.clear()
    Loader.fail_with = None
    Loader.fail_devices = ()
    monkeypatch.setattr(rvc_router, "require_module", lambda *_: None)
    monkeypatch.setattr(rvc_mod, "to_wav", lambda src, dst, **_: shutil.copy(src, dst))
    sf = types.ModuleType("soundfile")
    sf.write = lambda path, data, rate: Path(path).write_bytes(b"w")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "soundfile", sf)
    return storage, models


def _budget(free_mb: int = 6000) -> GpuBudget:
    return GpuBudget(use_cuda=True, probe=lambda: VramInfo("RTX 4050", 6141, free_mb, "test"))


def _engine(monkeypatch: pytest.MonkeyPatch, *, cuda: bool, budget: GpuBudget | None, idle=300.0):  # type: ignore[no-untyped-def]
    engine = RvcEngine(
        get_settings(), loader_factory=Loader, budget=budget, cuda_probe=lambda: cuda, idle_s=idle
    )
    monkeypatch.setattr(rvc_router, "rvc_engine", lambda: engine)
    return engine


BODY = {"inputPath": "media/voz.wav", "modelId": "mi_voz", "outputPath": "renders/o.wav"}


def test_torch_cpu_build_with_use_cuda(client: TestClient, cuda_env, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    budget = _budget()
    _engine(monkeypatch, cuda=False, budget=budget)
    res = client.post("/rvc/convert", json=BODY)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["device"] == "cpu" and body["warnings"] == ["torch_cpu_build"]
    assert Loader.instances[0].only_cpu is True
    assert budget.resident is None  # never asked the GPU budget


def test_cuda_takes_the_budget_and_idle_releases_it(
    client: TestClient, cuda_env, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    budget = _budget()
    engine = _engine(monkeypatch, cuda=True, budget=budget, idle=0.2)
    res = client.post("/rvc/convert", json=BODY)
    assert res.status_code == 200, res.text
    assert res.json()["device"] == "cuda" and "warnings" not in res.json()
    assert Loader.instances[0].only_cpu is False  # BaseLoader(only_cpu=False): cuda:0 + fp16
    assert budget.resident == "rvc" and "cuda" in engine._loaders
    deadline = time.monotonic() + 3
    while budget.resident is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert budget.resident is None  # RVC_IDLE_S without use -> VRAM back
    assert "cuda" not in engine._loaders


def test_short_vram_runs_on_cpu(client: TestClient, cuda_env, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _engine(monkeypatch, cuda=True, budget=_budget(free_mb=900))
    body = client.post("/rvc/convert", json=BODY).json()
    assert body["device"] == "cpu" and body["warnings"] == ["gpu_fallback_cpu"]


def test_cuda_failure_falls_back_to_cpu(client: TestClient, cuda_env, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    budget = _budget()
    _engine(monkeypatch, cuda=True, budget=budget)
    Loader.fail_with = RuntimeError("CUDA error: out of memory")
    Loader.fail_devices = ("cuda",)
    res = client.post("/rvc/convert", json=BODY)
    assert res.status_code == 200, res.text
    assert res.json()["device"] == "cpu" and res.json()["warnings"] == ["gpu_fallback_cpu"]
    assert budget.resident is None


@pytest.mark.parametrize("wrapped", [False, True])
def test_unpickling_error_is_model_incompatible(
    client: TestClient, cuda_env, monkeypatch, wrapped: bool
) -> None:  # type: ignore[no-untyped-def]
    _engine(monkeypatch, cuda=True, budget=_budget())
    err = pickle.UnpicklingError("Weights only load failed. ... numpy.core.multiarray._reconstruct")
    if wrapped:
        try:
            raise ValueError("could not load model") from err
        except ValueError as exc:
            Loader.fail_with = exc
    else:
        Loader.fail_with = err
    Loader.fail_devices = ("cuda", "cpu")
    res = client.post("/rvc/convert", json=BODY)
    assert res.status_code == 422, res.text
    body = res.json()
    assert body["code"] == "RVC_MODEL_INCOMPATIBLE"
    assert body["detail"] == (
        "El modelo RVC «mi_voz» no se puede cargar de forma segura (formato incompatible)."
    )
    assert body["details"] == {"modelId": "mi_voz"}
    assert len(Loader.instances) == 1  # no CPU retry: the same pickle would be refused again


def test_is_unpickling_error() -> None:
    assert rvc_mod.is_unpickling_error(pickle.UnpicklingError("x"))
    assert rvc_mod.is_unpickling_error(RuntimeError("Weights only load failed because ..."))
    assert not rvc_mod.is_unpickling_error(RuntimeError("CUDA out of memory"))


# ------------------------------------------------------------------------------- hubert source


def test_base_assets_sources_and_sizes(dirs) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    items = {i.name: i for i in rvc_mod.base_items(models, legacy=False)}
    assert set(items) == {"rmvpe.pt", "hubert_base/config.json", "hubert_base/pytorch_model.bin"}
    lj = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main"
    assert items["hubert_base/pytorch_model.bin"].url == f"{lj}/hubert_base/pytorch_model.bin"
    assert items["hubert_base/pytorch_model.bin"].fallbacks == (
        "https://huggingface.co/r3gm/hubert_base/resolve/main/pytorch_model.bin",
    )
    assert items["hubert_base/config.json"].fallbacks == (
        "https://huggingface.co/r3gm/hubert_base/resolve/main/config.json",
    )
    # Not an exact size (the [S] 181 189 687 B did not match the real file: upgrade from 3b broke)
    assert items["rmvpe.pt"].expected.size_bytes is None
    assert items["rmvpe.pt"].expected.min_bytes == rvc_mod.RMVPE_MIN_BYTES
    assert items["rmvpe.pt"].fallbacks == (
        "https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/rmvpe.pt",
    )
    from studio_workers import packs

    names = [f["name"] for f in packs.pack_status(packs.PACKS["rvc-base"], models)["files"]]
    assert "rvc/_base/hubert_base/pytorch_model.bin" in names
    assert not any("preprocessor" in n for n in names)


def test_hubert_mirror_fallback_records_source(dirs) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    payload = b"x" * 1024
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if "lj1995" in str(request.url):
            return httpx.Response(404)
        return httpx.Response(200, content=payload)

    item = next(i for i in rvc_mod.base_items(models, legacy=False) if i.name.endswith(".bin"))
    small = rvc_mod.MirroredFileItem(
        item.group, item.name, item.rel, item.url, rvc_mod.Expected(min_bytes=10),
        fallbacks=item.fallbacks,
    )  # fmt: skip
    manifest = Manifest.load(models)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert small.fetch(models, manifest, client, lambda _d, _t: None) == 1024
    assert [u.split("/")[3] for u in seen] == ["lj1995", "r3gm"]
    manifest.save()
    src = rvc_mod.hubert_source(models)
    assert src["present"] is True and src["repo"] == "r3gm/hubert_base"
    assert Manifest.load(models).get(item.rel)["mirror"] is True


def test_server_error_does_not_jump_to_the_mirror(dirs) -> None:  # type: ignore[no-untyped-def]
    _, models = dirs
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(500)

    item = next(i for i in rvc_mod.base_items(models, legacy=False) if i.name.endswith(".json"))
    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(rvc_mod.DownloadError),
    ):
        item.fetch(models, Manifest.load(models), client, lambda _d, _t: None)
    assert len(seen) == 1
