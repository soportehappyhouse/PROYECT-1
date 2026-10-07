"""Sprint 4 (M3): new perf.json fields (RVC device, Chatterbox RTF, FaceFusion fps, tool venv
states) and the Spanish reasons when a component cannot be measured. The tool processes are fakes
speaking the real protocols (Chatterbox JSON lines, FaceFusion headless-run argv) on this
interpreter."""

from __future__ import annotations

import dataclasses
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import needs_ffmpeg
from fastapi.testclient import TestClient

from studio_workers import perf, toolvenv
from studio_workers.config import get_settings

NEW_KEYS = (
    "rvc_device",
    "chatterbox_rtf",
    "chatterbox_load_s",
    "chatterbox_device",
    "chatterbox_model",
    "facefusion_fps",
    "facefusion_enh_fps",
    "facefusion_startup_s",
    "facefusion_device",
    "facefusion_model",
    "tools",
)

FAKE_SERVER = """\
import json, sys, wave
args = sys.argv[1:]
assert "--models-dir" in args and "--device" in args and "--t3" in args
print(json.dumps({"event": "ready", "device": args[args.index("--device") + 1],
                  "load_s": 1.5, "model": "mtl-" + args[args.index("--t3") + 1]}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "shutdown":
        break
    with wave.open(req["out"], "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(b"\\0\\0" * 24000 * 9)
    print(json.dumps({"event": "progress", "id": req["id"], "chunk": 1, "chunks": 1}), flush=True)
    print(json.dumps({"event": "done", "id": req["id"], "out": req["out"], "duration_s": 9.0,
                      "sample_rate": 24000, "rtf": 0.5}), flush=True)
"""

FAKE_FACEFUSION = """\
import shutil, sys
args = sys.argv[1:]
assert args[0] == "headless-run"
assert "--temp-path" in args and "--jobs-path" in args
target = args[args.index("--target-path") + 1]
output = args[args.index("--output-path") + 1]
print("[FACEFUSION.CORE] processing 100%", flush=True)
shutil.copy(target, output)
"""


def test_new_fields_and_reasons_without_packs(dirs) -> None:  # type: ignore[no-untyped-def]
    data = perf.run_perf(get_settings())
    for key in NEW_KEYS:
        assert key in data, key
    assert data["chatterbox_rtf"] is None and data["facefusion_fps"] is None
    assert data["skipped"]["chatterbox"] == "paquete tts-chatterbox no instalado"
    assert data["skipped"]["facefusion"] == "paquete faceswap no instalado"
    assert set(data["tools"]) == {"facefusion", "chatterbox"}
    assert all("state" in row for row in data["tools"].values())
    assert data["rvc_device"] is None and "rvc" in data["skipped"]


@pytest.fixture
def installed(dirs, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(perf, "_pack_installed", lambda pack_id, root: True)
    return dirs


def accept(storage: Path) -> None:
    mirror = storage / "consent" / "licences.json"
    mirror.parent.mkdir(parents=True, exist_ok=True)
    mirror.write_text(json.dumps({"accepted": {"faceswap": {"text_version": "2026-10-06"}}}))


def test_facefusion_reasons(installed, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    storage, _ = installed
    monkeypatch.setenv("FACEFUSION_PYTHON", "")
    settings = get_settings()
    work = storage / "tmp" / "w"
    work.mkdir(parents=True)

    def reason(**kw: Any) -> str:
        result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
        perf.bench_facefusion(settings, work, result, kw.get("face"), kw.get("licences"))
        return result["skipped"]["facefusion"]

    assert reason(face="consent/p/photo.jpg") == "licencia no aceptada"
    accept(storage)
    assert reason(face="consent/p/photo.jpg", licences=[]) == "licencia no aceptada"
    assert reason() == "registrá una Persona con consentimiento para medir"
    monkeypatch.setattr(toolvenv, "find_base_python", lambda tool, fresh=False: None)
    assert reason(face="consent/p/photo.jpg") == "entorno aislado de FaceFusion: falta Python 3.12"


def test_chatterbox_reason_when_venv_missing(installed, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    storage, _ = installed
    monkeypatch.setenv("CHATTERBOX_PYTHON", "")
    monkeypatch.setattr(toolvenv, "TOOLS", {
        **toolvenv.TOOLS,
        "chatterbox": dataclasses.replace(
            toolvenv.TOOLS["chatterbox"], lock=storage / "nowhere" / "chatterbox.lock.json"
        ),
    })  # fmt: skip
    result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
    perf.bench_chatterbox(get_settings(), storage / "tmp", result)
    assert result["skipped"]["chatterbox"] == "entorno aislado de Chatterbox: falta"


def test_chatterbox_bench_uses_the_workers_client(installed, monkeypatch, tmp_path) -> None:  # type: ignore[no-untyped-def]
    """M2's ChatterboxClient when it exists: stopped first (cold load measured), one model."""
    from types import SimpleNamespace

    from studio_workers import services

    storage, _ = installed
    monkeypatch.setenv("CHATTERBOX_PYTHON", sys.executable)  # venv "ready"
    calls: list[str] = []

    class Client:
        def stop(self) -> None:
            calls.append("stop")

        def synthesize(self, *, job_id, text, out):  # type: ignore[no-untyped-def]
            calls.append(f"synthesize:{len(text)}")
            return SimpleNamespace(rtf=0.8, load_s=12.0, device="cuda", model="mtl-v3",
                                   warnings=["x"])  # fmt: skip

    monkeypatch.setattr(services, "chatterbox_client", lambda: Client(), raising=False)
    result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
    perf.bench_chatterbox(get_settings(), storage / "tmp", result)
    assert calls == ["stop", "synthesize:150"]
    assert result["chatterbox_rtf"] == 0.8 and result["chatterbox_load_s"] == 12.0
    assert result["chatterbox_device"] == "cuda" and result["chatterbox_model"] == "mtl-v3"


def test_chatterbox_bench_speaks_the_protocol(installed, monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    """Fallback without the workers client: the bridge protocol straight through launch.py."""

    monkeypatch.setattr(perf, "USE_WORKER_ENGINES", False)
    storage, _ = installed
    tool = tmp_path / "chatterbox"
    tool.mkdir()
    (tool / "studio_tts_server.py").write_text(FAKE_SERVER, "utf-8")
    monkeypatch.setattr(toolvenv, "TOOLS", {
        **toolvenv.TOOLS,
        "chatterbox": dataclasses.replace(
            toolvenv.TOOLS["chatterbox"], lock=tool / "chatterbox.lock.json"
        ),
    })  # fmt: skip
    monkeypatch.setenv("CHATTERBOX_PYTHON", sys.executable)
    work = storage / "tmp" / "cb"
    work.mkdir(parents=True)
    result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
    perf.bench_chatterbox(get_settings(), work, result)
    assert result["skipped"] == {}
    assert result["chatterbox_rtf"] == 0.5 and result["chatterbox_load_s"] == 1.5
    assert result["chatterbox_device"] == "cpu" and result["chatterbox_model"] == "mtl-v3"
    assert (work / "chatterbox.wav").is_file()
    assert len(perf.CHATTERBOX_TEXT) == 150


@needs_ffmpeg
def test_facefusion_bench_uses_the_face_engine(installed, monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    """M1's FaceEngine when it exists (same model checks, budget and finalize as face.swap)."""
    import subprocess

    from studio_workers import services

    storage, _ = installed
    accept(storage)
    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    photo = storage / "consent" / "persons" / "p1" / "photos" / "a.png"
    photo.parent.mkdir(parents=True)
    subprocess.run(  # noqa: S603
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64", "-frames:v", "1",
         str(photo)],
        check=True, timeout=60,
    )  # fmt: skip
    seen: list[Any] = []

    class Engine:
        def run(self, req, task_id):  # type: ignore[no-untyped-def]
            seen.append(req)
            (storage / req.output_base).mkdir(parents=True, exist_ok=True)
            timings = {"facefusion_s": 10.0, "startup_s": 5.0}
            return {"frames": 75, "proc_fps": 5.0, "device": "cuda", "model": req.model,
                    "timings": timings, "warnings": []}  # fmt: skip

    monkeypatch.setattr(services, "face_engine", lambda: Engine(), raising=False)
    work = storage / "tmp" / "ffe"
    work.mkdir(parents=True)
    result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
    rel = photo.relative_to(storage).as_posix()
    # audit fix 4: without a valid face consent of the mirror listing the photo, nothing runs
    perf.bench_facefusion(get_settings(), work, result, rel, ["faceswap"], "con1")
    assert seen == [] and "consentimiento" in result["skipped"]["facefusion"]
    result = {"skipped": {}, "errors": {}, "warnings": []}
    mirror(storage, "con1", rel)
    perf.bench_facefusion(get_settings(), work, result, rel, ["faceswap"], "con1")
    assert [r.enhancer for r in seen] == [False, True]
    assert seen[0].consent_id == "con1" and seen[0].licence_ids == ["faceswap"]
    assert seen[0].output_base.startswith("renders/perf/")
    assert result["facefusion_fps"] == 15.0 and result["facefusion_enh_fps"] == 15.0
    assert result["facefusion_startup_s"] == 5.0 and result["facefusion_device"] == "cuda"
    assert not list((storage / "renders" / "perf").glob("*"))  # outputs cleaned up


@needs_ffmpeg
def test_facefusion_bench_with_fake_tool(installed, monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    """Fallback without the workers FaceEngine: headless-run argv through launch.py."""
    import subprocess

    monkeypatch.setattr(perf, "USE_WORKER_ENGINES", False)
    storage, _ = installed
    accept(storage)
    app = tmp_path / "fake ff"
    app.mkdir()
    (app / "facefusion.py").write_text(FAKE_FACEFUSION, "utf-8")
    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    monkeypatch.setenv("FACEFUSION_APP_DIR", str(app))
    photo = storage / "consent" / "persons" / "p1" / "photos" / "a.png"
    photo.parent.mkdir(parents=True)
    subprocess.run(  # noqa: S603
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64", "-frames:v", "1",
         str(photo)],
        check=True, timeout=60,
    )  # fmt: skip
    work = storage / "tmp" / "ff"
    work.mkdir(parents=True)
    result: dict[str, Any] = {"skipped": {}, "errors": {}, "warnings": []}
    rel = photo.relative_to(storage).as_posix()
    mirror(storage, "con2", rel)
    perf.bench_facefusion(get_settings(), work, result, rel, ["faceswap"], "con2")
    assert result["skipped"] == {} and result["errors"] == {}, result
    assert result["facefusion_fps"] > 0 and result["facefusion_enh_fps"] > 0
    assert result["facefusion_startup_s"] is not None
    assert result["facefusion_device"] == "cpu" and result["facefusion_model"] == "hyperswap_1a_256"
    assert (work / "facefusion" / "swap-plain.mp4").is_file()


def mirror(storage: Path, consent_id: str, rel: str) -> None:
    """storage/consent/active.json with one valid face consent covering `rel`."""
    path = storage / "consent" / "active.json"
    path.write_text(
        json.dumps({"consents": [{"personId": "p1", "consentId": consent_id, "scope": "face",
                                  "expires_at": None, "photo_paths": [rel],
                                  "sample_paths": []}]}),
        "utf-8",
    )  # fmt: skip


def test_facefusion_args_snapshot(tmp_path: Path) -> None:
    args = perf.facefusion_args(
        [tmp_path / "a b.jpg"], tmp_path / "t.mp4", tmp_path / "o.mp4", tmp_path / "tmp", "cuda",
        enhancer=True,
    )  # fmt: skip
    assert args[:2] == ["headless-run", "--source-paths"]
    assert args[args.index("--processors") + 1 : args.index("--processors") + 3] == [
        "face_swapper",
        "face_enhancer",
    ]
    assert args[args.index("--execution-providers") + 1] == "cuda"
    assert args[args.index("--jobs-path") + 1] == str(tmp_path / "tmp" / "jobs")
    assert "--download-providers" in args and all(isinstance(a, str) for a in args)


def test_perf_route_accepts_face_source(client: TestClient, dirs, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    seen: list[dict[str, Any]] = []

    def fake_run(settings, step=None, **kw):  # type: ignore[no-untyped-def]
        seen.append(kw)
        return {}

    from studio_workers.routers import perf as perf_router

    monkeypatch.setattr(perf_router, "run_perf", fake_run)
    body = {"face_source_path": "consent/persons/p1/photos/a.jpg", "licences": ["faceswap"]}
    tid = client.post("/perf/run", json=body).json()["task_id"]
    from studio_workers.services import perf_queue

    perf_queue().wait(tid, 30)
    want = {"face_source_path": body["face_source_path"], "licences": ["faceswap"]}
    assert seen == [{**want, "face_consent_id": None}]
    bad = client.post("/perf/run", json={"face_source_path": "../etc/passwd"})
    assert bad.status_code == 400
    assert client.post("/perf/run").status_code == 200  # the api of older builds sends nothing
    shutil.rmtree(dirs[0] / "run", ignore_errors=True)
