import shutil
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers import rvc_engine as rvc_mod
from studio_workers.config import get_settings
from studio_workers.routers import rvc as rvc_router
from studio_workers.rvc_engine import RvcEngine, base_status, discover_models


def _make_models(models: Path) -> None:
    voice = models / "rvc" / "mi_voz"
    voice.mkdir(parents=True)
    (voice / "mi_voz.pth").write_bytes(b"pth")
    (voice / "trained_IVF.index").write_bytes(b"idx")
    (voice / "added_IVF256.index").write_bytes(b"idx")
    other = models / "rvc" / "otra"
    other.mkdir()
    (other / "a.pth").write_bytes(b"pth")
    (models / "rvc" / "_base").mkdir()
    (models / "rvc" / "_base" / "x.pth").write_bytes(b"not a voice")
    (models / "rvc" / "vacia").mkdir()


def _make_base(models: Path) -> None:
    base = models / "rvc" / "_base"
    (base / "hubert_base").mkdir(parents=True, exist_ok=True)
    (base / "hubert_base" / "config.json").write_text("{}")
    (base / "hubert_base" / "pytorch_model.bin").write_bytes(b"w")
    (base / "rmvpe.pt").write_bytes(b"r")


def test_discover_models(dirs) -> None:
    _, models = dirs
    _make_models(models)
    found = discover_models(models)
    assert [m.id for m in found] == ["mi_voz", "otra"]
    assert found[0].model_path == "rvc/mi_voz/mi_voz.pth"
    assert found[0].index_path == "rvc/mi_voz/added_IVF256.index"  # "added" index preferred
    assert found[1].index_path is None


def test_models_endpoint(client: TestClient, dirs) -> None:
    _, models = dirs
    _make_models(models)
    body = client.get("/rvc/models").json()
    assert body[0] == {
        "id": "mi_voz",
        "name": "mi voz",
        "modelPath": "rvc/mi_voz/mi_voz.pth",
        "indexPath": "rvc/mi_voz/added_IVF256.index",
    }


class FakeLoader:
    instances: list["FakeLoader"] = []

    def __init__(self, only_cpu: bool, hubert: str | None, rmvpe: str | None) -> None:
        self.only_cpu, self.hubert, self.rmvpe = only_cpu, hubert, rmvpe
        self.conf: dict = {}
        FakeLoader.instances.append(self)

    def apply_conf(self, **kwargs) -> None:
        self.conf = kwargs

    def generate_from_cache(self, path: str, tag: str):
        assert Path(path).is_file() and tag == self.conf["tag"]
        return [0.0] * 40000, 40000


@pytest.fixture
def fake_rvc(dirs, monkeypatch: pytest.MonkeyPatch):
    FakeLoader.instances.clear()
    engine = RvcEngine(get_settings(), loader_factory=FakeLoader)
    monkeypatch.setattr(rvc_router, "rvc_engine", lambda: engine)
    monkeypatch.setattr(rvc_router, "require_module", lambda *_: None)
    monkeypatch.setattr(rvc_mod, "to_wav", lambda src, dst, **_: shutil.copy(src, dst))
    written: dict = {}
    sf = types.ModuleType("soundfile")

    def fake_write(path, data, rate) -> None:
        written.update(path=path, rate=rate)
        Path(path).write_bytes(b"w")

    sf.write = fake_write  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "soundfile", sf)
    return engine, written


def test_convert(client: TestClient, dirs, fake_rvc) -> None:
    storage, models = dirs
    _make_models(models)
    _make_base(models)
    (storage / "media" / "voz.mp3").write_bytes(b"mp3")
    res = client.post(
        "/rvc/convert",
        json={
            "inputPath": "media/voz.mp3",
            "modelId": "mi_voz",
            "pitchShift": 12,
            "indexRate": 0.5,
            "f0Method": "pm",
            "outputPath": "renders/r1.mp3",
            "jobId": "r1",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json() == {
        "path": "renders/r1.wav",
        "sampleRate": 40000,
        "durationSec": 1.0,
        "device": "cpu",
    }
    loader = FakeLoader.instances[0]
    assert loader.only_cpu is True
    assert loader.hubert and loader.hubert.endswith("hubert_base")
    assert loader.conf["pitch_algo"] == "pm" and loader.conf["pitch_lvl"] == 12
    assert loader.conf["index_influence"] == 0.5
    assert loader.conf["file_index"].endswith("added_IVF256.index")
    assert (storage / "renders" / "r1.wav").is_file()
    assert client.get("/jobs/r1").json()["status"] == "succeeded"


def test_convert_missing_base_assets_is_pack_required(
    client: TestClient, dirs, fake_rvc, monkeypatch
) -> None:
    storage, models = dirs
    _make_models(models)
    (storage / "media" / "voz.wav").write_bytes(b"wav")
    calls: list[Path] = []
    monkeypatch.setattr(rvc_mod, "download_base_assets", lambda root, **_: calls.append(root))
    res = client.post(
        "/rvc/convert",
        json={"inputPath": "media/voz.wav", "modelId": "mi_voz", "outputPath": "renders/r2.wav"},
    )
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["error"] == "PACK_REQUIRED" and body["packId"] == "rvc-base"
    assert body["size_bytes"] > 0
    assert calls == []  # no silent download: the web opens «Paquete requerido»
    # hubert alone is enough for a non-rmvpe pitch method
    _make_base(models)
    (models / "rvc" / "_base" / "rmvpe.pt").unlink()
    assert base_status(models)["rmvpe"] is False
    res = client.post(
        "/rvc/convert",
        json={
            "inputPath": "media/voz.wav",
            "modelId": "mi_voz",
            "f0Method": "pm",
            "outputPath": "renders/r3.wav",
        },
    )
    assert res.status_code == 200, res.text


def test_convert_unknown_model_404(client: TestClient, dirs) -> None:
    res = client.post(
        "/rvc/convert",
        json={"inputPath": "media/x.wav", "modelId": "nada", "outputPath": "renders/x.wav"},
    )
    assert res.status_code == 404


def test_download_base_assets_skips_legacy(dirs, monkeypatch) -> None:
    _, models = dirs
    fetched: list[str] = []

    def fake_download(url, dest, expected, **_):
        fetched.append(url.rsplit("/resolve/main/", 1)[1])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")
        return 1

    monkeypatch.setattr(rvc_mod, "download", fake_download)
    rvc_mod.download_base_assets(models)
    # sprint 4: preprocessor_config.json is not read by transformers' HubertModel: not fetched
    assert fetched == ["rmvpe.pt", "hubert_base/config.json", "hubert_base/pytorch_model.bin"]
    fetched.clear()
    rvc_mod.download_base_assets(models, include_legacy=True, force=True)
    assert "hubert_base.pt" in fetched
