"""Sprint 2 packs (matting, matting-image, sam2, reframe), .venv-gpl in the pack flow, /health,
/perf vision keys and models_cli --gpl-venv."""

import dataclasses
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from studio_workers import models_cli, packs
from studio_workers.config import get_settings
from studio_workers.models_manifest import Manifest
from studio_workers.vision import gpl

VISION = ("matting", "matting-image", "sam2", "reframe")


def test_vision_registry() -> None:
    m, mi, sam, rf = (packs.PACKS[p] for p in VISION)
    assert "GPL-3.0" in m.license and m.pip == ()  # nothing GPL-related in the main venv
    rvm = m.build_items(Path("/m"), None)
    assert [i.rel for i in rvm] == [
        "matting/rvm_mobilenetv3_fp16.torchscript",
        "matting/rvm_mobilenetv3_fp32.torchscript",
    ]
    assert all(i.url.startswith(packs.RVM_RELEASE) and i.expected.min_bytes for i in rvm)
    assert 0.015e9 < m.approx_size < 0.06e9  # ~7 MB model (+ fp32 for CPU) + small venv
    ort = next(r for r in mi.pip if r.module == "onnxruntime")
    assert ort.spec == "onnxruntime==1.24.4" and ort.cuda_spec == "onnxruntime-gpu==1.24.4"
    assert 0.2e9 < mi.approx_size < 0.3e9
    git = sam.pip[-1]
    assert git.module == "sam2" and "github.com/facebookresearch/sam2" in git.spec
    assert git.no_deps and "--no-build-isolation" in git.extra_args
    assert dict(git.env) == {"SAM2_BUILD_CUDA": "0"}
    assert [i.name for i in sam.build_items(Path("/m"), None)] == list(packs.SAM2_FILES)
    yunet = rf.build_items(Path("/m"), None)[0]
    assert yunet.expected.size_bytes == 232_589 and yunet.expected.sha256 == packs.YUNET_SHA256
    assert {"cv2", "numpy"} <= {r.module for r in rf.pip}
    for feat, pid in {
        "vision.matte.rvm": "matting",
        "vision.matte-image": "matting-image",
        "vision.sam": "sam2",
        "vision.track.sam2": "sam2",
        "vision.reframe": "reframe",
        "vision.track.csrt": "reframe",
    }.items():
        assert packs.FEATURE_PACKS[feat] == pid


def test_get_packs_lists_vision_with_gpl_venv_row(
    client: TestClient, dirs, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GPL_VENV_DIR", str(tmp_path / "venv-gpl"))
    from studio_workers import services

    services.reset()
    body = {p["id"]: p for p in client.get("/packs").json()}
    assert set(VISION) <= set(body)
    rows = {f["name"]: f for f in body["matting"]["files"]}
    assert rows["venv:.venv-gpl (torch, numpy)"]["present"] is False
    assert body["matting"]["installed"] is False and body["matting"]["group"] == "vision"
    health = client.get("/health").json()
    assert health["vision"]["gpl_venv"] == "missing"
    assert set(health["vision"]["packs"]) == set(VISION)
    assert set(VISION) <= set(health["packs"])


def test_install_matting_downloads_and_creates_gpl_venv(
    dirs, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, models = dirs
    venv = tmp_path / "venv-gpl"
    monkeypatch.setenv("GPL_VENV_DIR", str(venv))
    get_settings.cache_clear()
    calls: list[tuple[Path, bool]] = []

    def fake_ensure(path: Path, *, use_cuda: bool, on_line=None, **_k) -> str:
        calls.append((path, use_cuda))
        py = gpl.venv_python(path)
        py.parent.mkdir(parents=True, exist_ok=True)
        py.write_text("")
        (path / gpl.STAMP).write_text(gpl.requirements_hash() + " cpu\n", "utf-8")
        on_line("venv listo")
        return "ejecutado"

    monkeypatch.setattr(gpl, "ensure_venv", fake_ensure)

    def handler(req: httpx.Request) -> httpx.Response:
        body = b"t" * 9_000_000 if "fp16" in req.url.path else b"t" * 16_000_000
        return httpx.Response(200, content=body, headers={"content-length": str(len(body))})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert packs.pack_status(packs.PACKS["matting"], models)["installed"] is False
    lines: list[str] = []
    rep = packs.install_pack("matting", models, client=client, on_line=lines.append)
    assert len(rep.downloaded) == 2 and calls == [(venv, False)] and "venv listo" in lines
    st = packs.pack_status(packs.PACKS["matting"], models)
    assert st["installed"] is True and st["partial"] is False
    assert "matting" in Manifest.load(models).packs


def test_pip_extras_env_and_cuda_spec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    installed: set[str] = {"torch", "torchvision", "numpy"}
    monkeypatch.setattr(packs, "module_present", lambda m: m in installed)
    seen: list[tuple[list[str], str | None]] = []
    by_spec = {r.spec: r.module for p in VISION for r in packs.PACKS[p].pip}
    by_spec["onnxruntime-gpu==1.24.4"] = "onnxruntime"

    def runner(args: list[str], on_line) -> int:
        seen.append((args, os.environ.get("SAM2_BUILD_CUDA")))
        installed.add(by_spec[args[-1]])
        return 0

    for pid in ("sam2", "matting-image"):  # pip part only
        monkeypatch.setitem(packs.PACKS, pid, dataclasses.replace(packs.PACKS[pid], items=None))
    packs.install_pack("sam2", tmp_path, pip_runner=runner, use_cuda=False)
    git_args, env = seen[-1]
    assert git_args == ["--no-deps", "--no-build-isolation", packs.SAM2_GIT] and env == "0"
    assert all(e is None for _a, e in seen[:-1]) and os.environ.get("SAM2_BUILD_CUDA") is None
    assert not any("torch" in a[-1] for a, _e in seen)  # torch already in the venv: untouched
    seen.clear()
    installed.discard("onnxruntime")
    packs.install_pack("matting-image", tmp_path, pip_runner=runner, use_cuda=True)
    assert seen[-1][0] == ["onnxruntime-gpu==1.24.4"]


def test_perf_reports_vision_skips(dirs) -> None:
    from studio_workers import perf

    data = perf.run_perf(get_settings())
    for key in ("rvm_fps", "sam2_fps", "yunet_fps"):
        assert key in data and data[key] is None
    assert data["skipped"]["rvm"] == "paquete matting no instalado"
    assert data["skipped"]["sam2"] == "paquete sam2 no instalado"
    assert data["skipped"]["yunet"] == "paquete reframe no instalado"


def test_models_cli_gpl_venv_status(
    dirs, monkeypatch: pytest.MonkeyPatch, capsys, tmp_path: Path
) -> None:
    monkeypatch.setenv("GPL_VENV_DIR", str(tmp_path / "gv"))
    get_settings.cache_clear()
    report = tmp_path / "r.json"
    assert models_cli.main(["--gpl-venv", "status", "--json", "--report", str(report)]) == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["state"] == "missing" and summary["mode"] == "gpl-venv-status"
    monkeypatch.setattr(gpl, "ensure_venv", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))
    assert models_cli.main(["--gpl-venv", "ensure", "--report", str(report)]) == 1
    assert json.loads(report.read_text("utf-8"))["action"] == "failed"
