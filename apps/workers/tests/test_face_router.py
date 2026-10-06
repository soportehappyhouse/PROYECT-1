"""Sprint 4 M1: /face routes (licence mirror, consent_id, paths, detect, task codes) and packs."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from conftest import lavfi_video, needs_ffmpeg
from fastapi.testclient import TestClient

from studio_workers import packs
from studio_workers.config import get_settings
from studio_workers.face import tool
from studio_workers.face.engine import FaceEngine
from studio_workers.gpu import GpuBudget


def swap_body(**kw):  # type: ignore[no-untyped-def]
    body = {
        "source_paths": ["consent/persons/p1/photos/a.png"],
        "target_path": "media/clip.mp4",
        "output_base": "renders/face/j1/",
        "consent_id": "c1",
        "licence_ids": ["faceswap"],
    }
    body.update(kw)
    return body


def accept_licence(storage: Path) -> None:
    mirror = storage / "consent" / "licences.json"
    mirror.parent.mkdir(parents=True, exist_ok=True)
    mirror.write_text(
        json.dumps({"accepted": {"faceswap": {"text_version": "2026-10-06", "accepted_at": "x"}}}),
        "utf-8",
    )


@pytest.fixture
def media(dirs: tuple[Path, Path]) -> Path:
    storage, _ = dirs
    photos = storage / "consent" / "persons" / "p1" / "photos"
    photos.mkdir(parents=True)
    (photos / "a.png").write_bytes(b"\x89PNG")
    (storage / "media" / "clip.mp4").write_bytes(b"x")
    return storage


def fake_engine(**kw) -> FaceEngine:  # type: ignore[no-untyped-def]
    defaults = dict(
        require_models=lambda _m, _e: None,
        tool_state=lambda: "ready",
        detector_factory=lambda _root: (
            lambda img: [(120.0, 10.0, 20.0, 20.0, 0.7), (10.0, 12.0, 30.0, 30.0, 0.95)]
        ),
    )
    return FaceEngine(get_settings(), GpuBudget(use_cuda=False), **{**defaults, **kw})


def test_licence_mirror_consent_id_and_paths(client: TestClient, media: Path) -> None:
    r = client.post("/face/swap", json=swap_body())
    assert r.status_code == 403 and r.json()["code"] == "LICENCE_REQUIRED"
    accept_licence(media)
    assert tool.mirror_accepted("faceswap") is True
    no_consent = client.post(
        "/face/swap", json={k: v for k, v in swap_body().items() if k != "consent_id"}
    )
    assert no_consent.status_code == 422
    empty = client.post("/face/swap", json=swap_body(consent_id=""))
    assert empty.status_code == 422
    dots = client.post("/face/swap", json=swap_body(source_paths=["../outside.png"]))
    assert dots.status_code == 400 and dots.json()["code"] == "BAD_REQUEST"
    absolute = client.post("/face/swap", json=swap_body(target_path="/etc/passwd"))
    assert absolute.status_code == 400
    out = client.post("/face/swap", json=swap_body(output_base="../x/"))
    assert out.status_code == 400
    bad_licence = client.post("/face/swap", json=swap_body(licence_ids=["otra"]))
    assert bad_licence.status_code == 422


def test_task_error_code_and_details(
    client: TestClient, media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    accept_licence(media)
    engine = fake_engine(tool_state=lambda: "stale")
    from studio_workers.routers import face as face_router

    monkeypatch.setattr(face_router, "face_engine", lambda: engine)
    r = client.post("/face/swap", json=swap_body())
    assert r.status_code == 200
    task_id = r.json()["task_id"]
    for _ in range(100):
        st = client.get(f"/face/tasks/{task_id}").json()
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert st["status"] == "error" and st["code"] == "TOOL_MISSING"
    assert st["details"] == {"tool": "facefusion", "state": "stale", "packId": "faceswap"}
    assert "desactualizado" in st["error"]
    assert client.post(f"/face/tasks/{task_id}/cancel").json()["canceled"] is True
    assert client.get("/face/tasks/nope").status_code == 404


@needs_ffmpeg
def test_detect_image_and_video_frame(
    client: TestClient, media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import cv2
    import numpy as np

    engine = fake_engine()
    from studio_workers.routers import face as face_router

    monkeypatch.setattr(face_router, "face_engine", lambda: engine)
    img = media / "consent" / "persons" / "p1" / "photos" / "b.png"
    cv2.imwrite(str(img), np.zeros((90, 160, 3), dtype=np.uint8))
    r = client.post("/face/detect", json={"path": "consent/persons/p1/photos/b.png", "t": 3})
    assert r.status_code == 200
    data = r.json()
    assert data["width"] == 160 and data["height"] == 90 and data["t"] == 0
    assert [f["index"] for f in data["faces"]] == [0, 1]
    assert data["faces"][0]["box"]["x"] == pytest.approx(10 / 160, abs=1e-4)  # left to right
    assert data["faces"][1]["score"] == pytest.approx(0.7)
    lavfi_video(media / "media" / "v.mp4", "testsrc2=s=160x90:r=25:d=2")
    v = client.post("/face/detect", json={"path": "media/v.mp4", "t": 1.0}).json()
    assert v["frame_path"].startswith("renders/face/detect/") and v["frame_path"].endswith(".png")
    assert (media / v["frame_path"]).is_file()


def test_detect_without_yunet_is_pack_required(client: TestClient, media: Path) -> None:
    r = client.post("/face/detect", json={"path": "consent/persons/p1/photos/a.png", "t": 0})
    assert r.status_code == 409
    assert r.json()["packId"] == "faceswap"


def test_faceswap_packs_registry(dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    _, models = dirs
    fs = packs.PACKS["faceswap"]
    extra = packs.PACKS["faceswap-extra"]
    assert fs.licence_gate == extra.licence_gate == "faceswap"
    files = [i.rel for i in fs.build_items(models)]
    assert "yunet/face_detection_yunet_2023mar.onnx" in files
    for name in packs.FACEFUSION_BASE_MODELS + ("hyperswap_1a_256", "gfpgan_1.4"):
        assert f"facefusion/{name}.onnx" in files and f"facefusion/{name}.hash" in files
    urls = [i.url for i in fs.build_items(models)]
    assert all(
        u.startswith("https://github.com/facefusion/facefusion-assets/releases/download/models-3.")
        for u in urls
        if "facefusion/" in u
    )
    assert any("models-3.3.0/hyperswap_1a_256.onnx" in u for u in urls)
    assert {i.rel for i in extra.build_items(models)} == {
        f"facefusion/{n}.{e}"
        for n in ("ghost_1_256", "crossface_ghost", "inswapper_128_fp16")
        for e in ("onnx", "hash")
    }
    assert (
        1_790e6
        < sum(m.size_mb for m in packs.FACEFUSION_MODELS.values() if m.pack == "faceswap") * 1e6
        < 1_820e6
    )
    monkeypatch.delenv("FACEFUSION_PYTHON", raising=False)
    monkeypatch.setattr(tool, "_toolvenv", lambda: None)
    row = packs.pack_status(fs, models)
    assert row["licence_gate"] == "faceswap" and row["installed"] is False
    assert row["tool"] == {"id": "facefusion", "state": "missing"}
    assert any(f["name"].startswith("venv:tools/facefusion") for f in row["files"])
    assert packs.FEATURE_PACKS["face.swap"] == "faceswap"


def test_tool_bridge_fallback_and_m3_delegation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(tool, "_toolvenv", lambda: None)
    app = tmp_path / "app"
    app.mkdir()
    (app / "facefusion.py").write_text("print('x')", "utf-8")
    monkeypatch.setenv("FACEFUSION_APP_DIR", str(app))
    monkeypatch.setenv("FACEFUSION_PYTHON", "python-that-does-not-exist-xyz")
    assert tool.tool_state() == "broken"
    import sys

    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    assert tool.tool_state() == "ready"
    argv, env, cwd = tool.command("facefusion.py", ["headless-run", "--x"])
    assert argv == [sys.executable, str(app / "facefusion.py"), "headless-run", "--x"]
    assert cwd == app and env["PYTHONUTF8"] == "1" and "HF_TOKEN" not in env

    class FakeToolvenv:
        @staticmethod
        def command(tool_id, script, args):  # type: ignore[no-untyped-def]
            return (
                ["py", "launch.py", "--tool", tool_id, "--", script, *args],
                {"A": "1"},
                Path("/w"),
            )

        @staticmethod
        def status_summary(tool_id):  # type: ignore[no-untyped-def]
            return {"id": tool_id, "state": "stale"}

        @staticmethod
        def licence_accepted(licence_id):  # type: ignore[no-untyped-def]
            return licence_id == "faceswap"

    monkeypatch.setattr(tool, "_toolvenv", lambda: FakeToolvenv)
    assert tool.command("facefusion.py", ["a"])[0][:4] == [
        "py",
        "launch.py",
        "--tool",
        "facefusion",
    ]
    assert tool.tool_summary() == {"id": "facefusion", "state": "stale"}
    assert tool.licence_accepted("faceswap") is True
    env2 = tool.with_ffmpeg_path({"PATH": "/usr/bin"}, "/opt/ffmpeg/bin/ffmpeg")
    assert env2["PATH"].split(":" if ":" in env2["PATH"] else ";")[0].endswith("bin")
