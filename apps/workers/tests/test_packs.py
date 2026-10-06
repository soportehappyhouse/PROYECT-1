"""Model packs: registry/contract, installed/partial detection, sequential tasks, CLI, 409."""

import dataclasses
import hashlib
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from studio_workers import models_cli, packs
from studio_workers.errors import CodedError
from studio_workers.main import create_app
from studio_workers.models_manifest import Manifest
from studio_workers.routers import packs as packs_router
from studio_workers.tts.piper_catalog import CATALOG

PACK_KEYS = {
    "id",
    "name_es",
    "description_es",
    "size_bytes",
    "installed",
    "partial",
    "files",
    "required_by",
    "license",
    "group",
    "licence_gate",  # sprint 4
    "tool",  # sprint 4
}


def test_registry_matches_contract() -> None:
    assert list(packs.PACKS) == [
        "core",
        "whisper-turbo",
        "voces-es",
        "rvc-base",
        "scenes",
        "voz-limpia",
        "matting",
        "matting-image",
        "sam2",
        "reframe",
        "agent-llm",  # sprint 3: models pulled through Ollama
        "stems",  # sprint 3b: Demucs htdemucs (registered after the tuple)
        "ocr",  # sprint 3b: perfil de estilo (RapidOCR)
        "vision-llm",  # sprint 3b: perfil de estilo (Ollama qwen2.5vl:3b)
        "matting-hq",  # sprint 3b: recorte de calidad alta (RVM resnet50)
        "tts-chatterbox",  # sprint 4 (M2 block): Chatterbox + tools/chatterbox/.venv
        "faceswap",  # sprint 4 (M1 block): FaceFusion + tools/facefusion/.venv, licence-gated
        "faceswap-extra",  # sprint 4 (M1 block): extra swapper models, licence-gated
    ]
    gated = {p.id: p.licence_gate for p in packs.PACKS.values() if p.licence_gate}
    assert gated == {"faceswap": "faceswap", "faceswap-extra": "faceswap"}  # sprint 4 (M3 gate)
    assert packs.FEATURE_PACKS["analyze.scenes"] == "scenes"
    assert packs.FEATURE_PACKS["audio.denoise"] == "voz-limpia"
    voices = [i for i in packs.PACKS["voces-es"].build_items(Path("/m"), None)]
    assert len(voices) == 14  # 7 voices x (.onnx + .onnx.json)
    turbo = packs.PACKS["whisper-turbo"].build_items(Path("/m"), None)[0]
    assert turbo.repo == "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    scenes = {r.spec: r for r in packs.PACKS["scenes"].pip}
    assert scenes["scenedetect==0.7.1"].no_deps  # keeps opencv-python (GUI) out of the venv
    # sizes in the contract table: core ~0.3 GB, turbo ~1.6 GB, voices ~0.5 GB, rvc ~0.4 GB
    approx = {p.id: p.approx_size / 1e9 for p in packs.PACKS.values()}
    assert 0.2 < approx["core"] < 0.4 and 1.4 < approx["whisper-turbo"] < 1.8
    assert 0.3 < approx["voces-es"] < 0.6 and 0.3 < approx["rvc-base"] < 0.5


def test_get_packs_contract_and_registry_file(client: TestClient, dirs) -> None:
    _, models = dirs
    body = client.get("/packs").json()
    assert [p["id"] for p in body] == list(packs.PACKS)
    for p in body:
        assert set(p) >= PACK_KEYS
        assert p["size_bytes"] > 0
        assert all(set(f) == {"name", "size", "present"} for f in p["files"])
    core = next(p for p in body if p["id"] == "core")
    assert core["installed"] is False and core["partial"] is False
    registry = json.loads((models / "packs.json").read_text("utf-8"))
    assert [p["id"] for p in registry["packs"]] == list(packs.PACKS)


def _install_core_files(models: Path) -> None:
    (models / "piper").mkdir(exist_ok=True)
    (models / "piper" / "es_AR-daniela-high.onnx").write_bytes(b"x" * 1_000_001)
    (models / "piper" / "es_AR-daniela-high.onnx.json").write_text("{" + " " * 300 + "}")
    snap = models / "whisper" / "models--Systran--faster-whisper-base" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"x")
    (snap / "config.json").write_text("{}")


def test_installed_and_partial_detection(dirs) -> None:
    _, models = dirs
    assert packs.summary(models)["core"] == "missing"
    (models / "piper").mkdir(exist_ok=True)
    (models / "piper" / "es_AR-daniela-high.onnx.part").write_bytes(b"x" * 10)
    assert packs.summary(models)["core"] == "partial"
    _install_core_files(models)
    assert packs.summary(models)["core"] == "installed"
    assert packs.is_installed("core", models)


def test_pack_required_payload() -> None:
    err = packs.PackRequiredError("scenes")
    payload = err.payload()
    assert payload["error"] == "PACK_REQUIRED" and payload["packId"] == "scenes"
    assert payload["size_bytes"] > 0 and payload["name_es"]


def test_pack_status_sprint4_keys(dirs) -> None:
    _, models = dirs
    row = packs.pack_status(packs.PACKS["core"], models)
    assert row["licence_gate"] is None and row["tool"] is None
    gated = dataclasses.replace(
        packs.PACKS["scenes"],
        licence_gate="faceswap",
        tool_status=lambda: {"id": "facefusion", "state": "missing"},
    )
    row = packs.pack_status(gated, models)
    assert row["licence_gate"] == "faceswap"
    assert row["tool"] == {"id": "facefusion", "state": "missing"}


def test_coded_error_answers_detail_and_code(dirs) -> None:
    app = create_app()

    def blocked() -> None:
        raise CodedError("CONTENT_BLOCKED", "Bloqueado por el analizador.")

    def failed() -> None:
        raise CodedError("TOOL_FAILED", "FaceFusion terminó con error.", details={"logTail": ["x"]})

    app.add_api_route("/_test/blocked", blocked)
    app.add_api_route("/_test/failed", failed)
    with TestClient(app) as c:
        r = c.get("/_test/blocked")
        assert r.status_code == 422
        assert r.json() == {"detail": "Bloqueado por el analizador.", "code": "CONTENT_BLOCKED"}
        r = c.get("/_test/failed")
        assert r.status_code == 502 and r.json()["details"] == {"logTail": ["x"]}
    assert CodedError("X", "y").status == 400 and CodedError("NO_FACE", "y", 418).status == 418


def _catalog_and_transport(voice: str, onnx: bytes, cfg: bytes):
    v = CATALOG[voice]
    remote_onnx, remote_json = v.remote_paths()
    catalog = {
        voice: {
            "files": {
                remote_onnx: {"size_bytes": len(onnx), "md5_digest": hashlib.md5(onnx).hexdigest()},
                remote_json: {"size_bytes": len(cfg), "md5_digest": hashlib.md5(cfg).hexdigest()},
            }
        }
    }
    hits: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(req.url.path)
        body = onnx if req.url.path.endswith(".onnx") else cfg
        return httpx.Response(200, content=body, headers={"content-length": str(len(body))})

    return catalog, httpx.Client(transport=httpx.MockTransport(handler)), hits


def test_install_core_downloads_records_manifest_and_skips_second_time(tmp_path: Path) -> None:
    onnx, cfg = b"o" * 2_000_000, b"{" + b" " * 400 + b"}"
    catalog, client, hits = _catalog_and_transport("es_AR-daniela-high", onnx, cfg)
    whisper_calls: list[str] = []

    def fake_whisper(root: Path, name: str) -> Path:
        whisper_calls.append(name)
        snap = root / "whisper" / f"models--Systran--faster-whisper-{name}" / "snapshots" / "s1"
        snap.mkdir(parents=True, exist_ok=True)
        (snap / "model.bin").write_bytes(b"w" * 100)
        (snap / "config.json").write_text("{}")
        return snap

    progress: list[tuple[int, int]] = []
    rep = packs.install_pack(
        "core",
        tmp_path,
        client=client,
        catalog=catalog,
        whisper_downloader=fake_whisper,
        on_progress=lambda d, t, _f: progress.append((d, t)),
    )
    assert sorted(rep.downloaded) == sorted(
        ["es_AR-daniela-high.onnx", "es_AR-daniela-high.onnx.json", "whisper base"]
    )
    assert whisper_calls == ["base"] and len(hits) == 2
    assert progress and progress[-1][0] >= progress[0][0]
    manifest = Manifest.load(tmp_path)
    assert "core" in manifest.packs
    assert "piper/es_AR-daniela-high.onnx" in manifest.files
    assert packs.is_installed("core", tmp_path)
    again = packs.install_pack(
        "core", tmp_path, client=client, catalog=catalog, whisper_downloader=fake_whisper
    )
    assert again.downloaded == [] and len(again.skipped) == 3 and len(hits) == 2


def test_pip_pack_runs_pip_with_no_deps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    installed: set[str] = set()
    calls: list[list[str]] = []
    monkeypatch.setattr(packs, "module_present", lambda m: m in installed)
    by_spec = {r.spec: r.module for r in packs.PACKS["scenes"].pip}

    def runner(args: list[str], on_line) -> int:
        calls.append(args)
        on_line("Successfully installed")
        installed.add(by_spec[args[-1]])
        return 0

    lines: list[str] = []
    rep = packs.install_pack("scenes", tmp_path, pip_runner=runner, on_line=lines.append)
    assert ["--no-deps", "scenedetect==0.7.1"] in calls
    assert calls[-1] == ["--no-deps", "scenedetect==0.7.1"]  # after its dependencies
    assert "scenedetect==0.7.1" in rep.pip and "Successfully installed" in lines
    assert Manifest.load(tmp_path).packs["scenes"]["pip"]


def test_pip_failure_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(packs, "module_present", lambda m: False)
    with pytest.raises(RuntimeError, match="pip install"):
        packs.install_pack("scenes", tmp_path, pip_runner=lambda a, o: 1)


def test_download_task_queue(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []

    def fake_install(pack_id, root, *, on_progress, on_line, catalog=None):
        order.append(pack_id)
        on_line(f"bajando {pack_id}")
        on_progress(50, 100, f"{pack_id}.bin")
        on_progress(100, 100, f"{pack_id}.bin")
        return packs.InstallReport(pack_id, downloaded=[f"{pack_id}.bin"], bytes=100)

    monkeypatch.setattr(packs_router, "install_pack", fake_install)
    monkeypatch.setattr("studio_workers.tts.piper_catalog.load_voices_json", lambda root: None)
    first = client.post("/packs/whisper-turbo/download").json()
    second = client.post("/packs/rvc-base/download").json()
    assert first["task_id"] != second["task_id"]
    from studio_workers.services import pack_queue

    for tid in (first["task_id"], second["task_id"]):
        pack_queue().wait(tid, 10)
        st = client.get(f"/packs/tasks/{tid}").json()
        assert st["status"] == "done" and st["progress"] == 1.0
        assert st["bytes_done"] == 100 and st["bytes_total"] == 100
        assert st["current_file"].endswith(".bin")
    assert order == ["whisper-turbo", "rvc-base"]  # sequential, in submission order
    assert client.get("/packs/tasks/nope").status_code == 404
    assert client.post("/packs/nope/download").status_code == 404


def test_download_task_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("sin red")

    monkeypatch.setattr(packs_router, "install_pack", boom)
    tid = client.post("/packs/scenes/download").json()["task_id"]
    from studio_workers.services import pack_queue

    pack_queue().wait(tid, 10)
    st = client.get(f"/packs/tasks/{tid}").json()
    assert st["status"] == "error" and "sin red" in st["error"]


def test_cli_packs(dirs, monkeypatch: pytest.MonkeyPatch, capsys, tmp_path: Path) -> None:
    assert models_cli.main(["--packs", "list", "--json"]) == 0
    out = capsys.readouterr().out
    summary = json.loads(out.strip().splitlines()[-1])
    assert [p["id"] for p in summary["packs"]] == list(packs.PACKS)
    assert models_cli.main(["--packs", "download", "nope"]) == 2
    assert models_cli.main(["--packs", "bogus"]) == 2

    done: list[str] = []

    def fake_install(pid, root, **kw):
        done.append(pid)
        if pid == "rvc-base":
            raise RuntimeError("falla")
        return packs.InstallReport(pid, downloaded=["x"])

    monkeypatch.setattr(packs, "install_pack", fake_install)
    monkeypatch.setattr(models_cli, "_catalog", lambda *a, **k: None)
    # independent of a real Ollama: "up, no models" → the Ollama packs are installed too
    monkeypatch.setattr(packs, "ollama_installed_models", lambda *a, **k: [])
    report = tmp_path / "r.json"
    assert models_cli.main(["--packs", "all", "--report", str(report)]) == 1
    # sprint 4 (M3): licence-gated packs (faceswap) are skipped until the licence is accepted
    gated = [p for p, pk in packs.PACKS.items() if pk.licence_gate]
    assert done == [p for p in packs.PACKS if p not in gated]  # a failure does not stop the rest
    data = json.loads(report.read_text("utf-8"))
    assert data["failed"] == 1 and data["installed"] == len(packs.PACKS) - 1 - len(gated)

    # Ollama down (-SkipOllama): `all` skips the Ollama packs without failing
    ollama_packs = [p for p, pk in packs.PACKS.items() if pk.ollama_models is not None]
    assert {"agent-llm", "vision-llm"} <= set(ollama_packs)
    done.clear()
    monkeypatch.setattr(packs, "ollama_installed_models", lambda *a, **k: None)
    assert models_cli.main(["--packs", "all", "--report", str(report)]) == 1
    assert done == [p for p in packs.PACKS if p not in ollama_packs and p not in gated]


def test_extract_deepfilter_zip(tmp_path: Path) -> None:
    import zipfile

    folder = tmp_path / "deepfilter"
    folder.mkdir()
    with zipfile.ZipFile(folder / "DeepFilterNet3.zip", "w") as zf:
        zf.writestr("DeepFilterNet3/config.ini", "[df]\n")
        zf.writestr("DeepFilterNet3/checkpoints/model_120.ckpt.best", "x")
    packs.extract_deepfilter(tmp_path)
    assert (packs.deepfilter_dir(tmp_path) / "config.ini").is_file()
