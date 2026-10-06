"""Sprint 2 packs (matting, matting-image, sam2, reframe), .venv-gpl in the pack flow, /health,
/perf vision keys and models_cli --gpl-venv."""

import dataclasses
import hashlib
import json
import os
import types
from importlib import metadata
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
    assert all(i.url.startswith(packs.RVM_RELEASE) for i in rvm)
    assert [(i.expected.size_bytes, len(i.expected.sha256 or "")) for i in rvm] == [
        (7_952_067, 64),
        (15_501_891, 64),
    ]  # [V] github release v1.0.0
    assert 0.015e9 < m.approx_size < 0.06e9  # ~7 MB model (+ fp32 for CPU) + small venv
    ort = next(r for r in mi.pip if r.module == "onnxruntime")
    assert ort.spec == "onnxruntime==1.24.4" and ort.cuda_spec == "onnxruntime-gpu==1.24.4"
    assert (ort.cpu_dist, ort.cuda_dist) == ("onnxruntime", "onnxruntime-gpu")
    assert 0.2e9 < mi.approx_size < 0.3e9
    bi = mi.build_items(Path("/m"), None)[0]
    assert bi.expected.size_bytes == 224_005_088 and bi.expected.sha256 == packs.BIREFNET_SHA256
    git = sam.pip[-1]
    assert git.module == "sam2" and "github.com/facebookresearch/sam2" in git.spec
    assert git.spec.endswith("@" + packs.SAM2_COMMIT) and len(packs.SAM2_COMMIT) == 40
    assert git.no_deps and "--no-build-isolation" in git.extra_args and git.needs_git
    assert dict(git.env) == {"SAM2_BUILD_CUDA": "0"}
    assert [r.module for r in sam.pip[-3:-1]] == ["setuptools", "wheel"]  # built in the venv
    assert [i.name for i in sam.build_items(Path("/m"), None)] == list(packs.SAM2_FILES)
    sam_files = sam.build_items(Path("/m"), None)
    assert all(i.expected.min_bytes and not i.expected.sha256 for i in sam_files)
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
    bodies = {n: n.encode() * 1000 for n in packs.RVM_FILES}
    monkeypatch.setattr(packs, "RVM_FILES", {n: len(b) for n, b in bodies.items()})
    monkeypatch.setattr(
        packs, "RVM_SHA256", {n: hashlib.sha256(b).hexdigest() for n, b in bodies.items()}
    )

    def handler(req: httpx.Request) -> httpx.Response:
        body = bodies[req.url.path.rsplit("/", 1)[-1]]
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
    dists = _fake_dists(monkeypatch, set())
    monkeypatch.setattr(packs, "git_available", lambda: True)
    seen: list[tuple[list[str], str | None]] = []
    by_spec = {r.spec: r.module for p in VISION for r in packs.PACKS[p].pip}
    by_spec["onnxruntime-gpu==1.24.4"] = "onnxruntime"

    def runner(args: list[str], on_line) -> int:
        seen.append((args, os.environ.get("SAM2_BUILD_CUDA")))
        installed.add(by_spec[args[-1]])
        dists.add(args[-1].split("==")[0])
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


# ----------------------------------------------- sprint 2 audit: onnxruntime-gpu, git, integrity


class _FakeDist:
    def __init__(self, version: str) -> None:
        self.version = version


def _fake_dists(monkeypatch: pytest.MonkeyPatch, names: set[str]) -> set[str]:
    """importlib.metadata as seen by packs / system_probe: only `names` are installed (mutable)."""

    def distribution(name: str) -> _FakeDist:
        if name not in names:
            raise metadata.PackageNotFoundError(name)
        return _FakeDist("1.24.4")

    def version(name: str) -> str:
        return distribution(name).version

    from studio_workers import system_probe

    for mod in (packs.metadata, system_probe.metadata):
        monkeypatch.setattr(mod, "distribution", distribution)
        monkeypatch.setattr(mod, "version", version)
    return names


def _ort_only(monkeypatch: pytest.MonkeyPatch, installed: set[str]) -> list[list[str]]:
    """matting-image reduced to its pip part; a runner that edits the fake metadata."""
    monkeypatch.setattr(packs, "module_present", lambda m: m in installed)
    monkeypatch.setitem(
        packs.PACKS,
        "matting-image",
        dataclasses.replace(packs.PACKS["matting-image"], items=None),
    )
    return []


def test_cuda_replaces_cpu_onnxruntime_by_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed = {"numpy", "cv2", "onnxruntime"}  # importable: piper pulled the CPU build
    dists = _fake_dists(monkeypatch, {"onnxruntime"})
    seen = _ort_only(monkeypatch, installed)

    def runner(args: list[str], _on_line) -> int:
        seen.append(args)
        if args[0] == "uninstall":
            dists.difference_update(args[1:])
        else:
            dists.add(args[-1].split("==")[0])
        return 0

    # CPU machine: onnxruntime importable -> nothing to do
    packs.install_pack("matting-image", tmp_path, pip_runner=runner, use_cuda=False)
    assert seen == []
    row = packs.pack_status(packs.PACKS["matting-image"], tmp_path, use_cuda=True)["files"]
    assert {"name": "pip:onnxruntime-gpu==1.24.4", "size": 12_594_863, "present": False} in row
    # CUDA machine: importable is not enough, the -gpu distribution must be the installed one
    lines: list[str] = []
    packs.install_pack("matting-image", tmp_path, pip_runner=runner, use_cuda=True,
                       on_line=lines.append)  # fmt: skip
    assert seen == [["uninstall", "onnxruntime"], ["onnxruntime-gpu==1.24.4"]]
    assert dists == {"onnxruntime-gpu"} and any("se reemplaza" in line for line in lines)
    st = packs.pack_status(packs.PACKS["matting-image"], tmp_path, use_cuda=True)
    assert all(f["present"] for f in st["files"])
    seen.clear()
    packs.install_pack("matting-image", tmp_path, pip_runner=runner, use_cuda=True)
    assert seen == []  # already the CUDA build
    # both builds installed (the CPU one shadows the files): both out, -gpu back in
    dists.add("onnxruntime")
    packs.install_pack("matting-image", tmp_path, pip_runner=runner, use_cuda=True)
    assert seen == [["uninstall", "onnxruntime", "onnxruntime-gpu"], ["onnxruntime-gpu==1.24.4"]]


def test_cuda_swap_failure_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_dists(monkeypatch, {"onnxruntime"})
    _ort_only(monkeypatch, {"numpy", "cv2", "onnxruntime"})
    with pytest.raises(RuntimeError, match="uninstall onnxruntime"):
        packs.install_pack("matting-image", tmp_path, pip_runner=lambda a, _l: 1, use_cuda=True)


def test_pip_uninstall_command(monkeypatch: pytest.MonkeyPatch) -> None:
    # Both branches, independent of whether the test venv has pip (CI) or only uv (local).
    monkeypatch.setattr(packs, "module_present", lambda m: m == "pip")
    cmd = packs.pip_command(["uninstall", "onnxruntime"])
    assert cmd[1:] == ["-m", "pip", "uninstall", "-y", "onnxruntime"]
    monkeypatch.setattr(packs, "module_present", lambda _m: False)
    monkeypatch.setattr(packs.shutil, "which", lambda name: "/bin/uv" if name == "uv" else None)
    cmd = packs.pip_command(["uninstall", "onnxruntime"])
    assert cmd[:3] == ["/bin/uv", "pip", "uninstall"] and cmd[-1] == "onnxruntime"
    assert "install" not in cmd
    monkeypatch.setattr(packs.shutil, "which", lambda _name: None)
    with pytest.raises(RuntimeError, match="pip no esta disponible"):
        packs.pip_command(["uninstall", "onnxruntime"])


def test_onnxruntime_provider_in_health_and_gpu_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from studio_workers import system_probe

    _fake_dists(monkeypatch, {"onnxruntime"})
    monkeypatch.delitem(__import__("sys").modules, "onnxruntime", raising=False)
    info = system_probe.onnxruntime_info(use_cuda=True, cuda_seen=True)
    assert info["dist"] == "onnxruntime" and info["provider"] == "CPUExecutionProvider"
    assert info["cpu_on_cuda"] is True  # CUDA machine, CPU onnxruntime -> pre-warning
    assert system_probe.onnxruntime_info(use_cuda=False, cuda_seen=False)["cpu_on_cuda"] is False
    _fake_dists(monkeypatch, {"onnxruntime-gpu"})
    gpu = system_probe.onnxruntime_info(use_cuda=True, cuda_seen=True)
    assert gpu["provider"] == "CUDAExecutionProvider" and gpu["cpu_on_cuda"] is False
    # a loaded BiRefNet session that fell back to CPU wins over the metadata guess
    real = system_probe.onnxruntime_info(use_cuda=True, cuda_seen=True, session_device="cpu")
    assert real["provider"] == "CPUExecutionProvider" and real["source"] == "session"
    assert system_probe.onnxruntime_info(True, True)["version"] == "1.24.4"
    _fake_dists(monkeypatch, set())
    assert system_probe.onnxruntime_info(True, True)["provider"] is None
    # endpoints (USE_CUDA=false in the fixture): CPU provider reported, no pre-warning
    _fake_dists(monkeypatch, {"onnxruntime"})
    ort = client.get("/health").json()["vision"]["onnxruntime"]
    assert ort["provider"] == "CPUExecutionProvider" and ort["cpu_on_cuda"] is False
    assert client.get("/gpu/status").json()["onnx_provider"] == "cpu"
    _fake_dists(monkeypatch, set())
    assert client.get("/gpu/status").json()["onnx_provider"] is None


def test_sam2_pack_fails_without_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    installed = {"torch", "torchvision", "numpy"}
    monkeypatch.setattr(packs, "module_present", lambda m: m in installed)
    monkeypatch.setattr(packs, "git_available", lambda: False)
    calls: list[list[str]] = []
    monkeypatch.setitem(packs.PACKS, "sam2", dataclasses.replace(packs.PACKS["sam2"]))
    with pytest.raises(RuntimeError) as err:
        packs.install_pack(
            "sam2", tmp_path, pip_runner=lambda a, _l: calls.append(a) or 0, use_cuda=False
        )
    assert "Instalá Git (winget install Git.Git) y reintentá" in str(err.value)
    assert calls == [] and not list(tmp_path.rglob("*.pt*"))  # nothing downloaded or installed
    # with git (and sam2 already importable) the check does not get in the way
    installed |= {"hydra", "iopath", "PIL", "tqdm", "setuptools", "wheel", "sam2"}
    monkeypatch.setitem(packs.PACKS, "sam2", dataclasses.replace(packs.PACKS["sam2"], items=None))
    packs.install_pack("sam2", tmp_path, pip_runner=lambda a, _l: 1, use_cuda=False)


def test_integrity_first_download_recorded(dirs) -> None:
    from studio_workers.downloads import Expected
    from studio_workers.models_manifest import FileItem

    _, models = dirs
    rows = {p["id"]: p for p in packs.list_packs(models)}
    assert rows["matting"]["integrity"] == "pinned"
    assert rows["matting-image"]["integrity"] == "pinned"
    assert rows["reframe"]["integrity"] == "pinned"
    assert rows["sam2"]["integrity"] == "pending"  # no published sha256 (fbaipublicfiles)
    body = b"s" * 5000
    transport = httpx.MockTransport(lambda _r: httpx.Response(200, content=body))
    client = httpx.Client(transport=transport)
    manifest = Manifest.load(models)
    for item in packs.PACKS["sam2"].build_items(models, None):
        small = FileItem(item.group, item.name, item.rel, item.url, Expected(min_bytes=100))
        small.fetch(models, manifest, client, lambda _d, _t: None)
    manifest.save()
    entry = Manifest.load(models).get("sam2/sam2.1_hiera_tiny.pt")
    assert entry["verified"] == "first-download"
    assert entry["sha256"] == hashlib.sha256(body).hexdigest() and entry["size"] == 5000
    rows = {p["id"]: p for p in packs.list_packs(models)}
    assert rows["sam2"]["integrity"] == "first-download"


def test_perf_rvm_measures_1080p_5s_through_gpl(dirs, monkeypatch: pytest.MonkeyPatch) -> None:
    from studio_workers import services
    from studio_workers.vision import bench

    clips: list[tuple[str, float]] = []

    def fake_clip(dst: Path, size: str, seconds: float, rate: int = 25) -> Path:
        clips.append((size, seconds))
        dst.write_bytes(b"x")
        return dst

    class Engine:
        calls: list[str] = []

        def rvm_available(self) -> bool:
            return True

        def gpl_status(self) -> dict:
            return {"state": "ready"}

        def matte_video(self, src: Path, out: Path, *, model: str, chunk: int) -> dict:
            self.calls.append(model)  # the real engine runs vision_gpl.rvm in .venv-gpl
            return {"frames": 125, "device": "cuda", "proc_fps": 31.5, "precision": "fp16",
                    "downsample": 0.2667, "warnings": [], "alpha_codec": "vp9",
                    "timings": {"startup_s": 3.0, "first_batch_s": 0.5, "process_s": 3.0,
                                "preview_s": 0.2, "bottleneck": "encode",
                                "ms_per_frame": {"encode": 20.0}}}  # fmt: skip

    engine = Engine()
    monkeypatch.setattr(bench, "_clip", fake_clip)
    fake = types.SimpleNamespace(matte_engine=lambda: engine, sam_manager=services.sam_manager)
    monkeypatch.setattr(bench, "services", fake)
    result: dict = {"skipped": {}, "errors": {}, "warnings": []}
    bench.run_vision_bench(get_settings(), dirs[0], result)
    assert ("1920x1080", 5.0) in clips and engine.calls == ["rvm"]
    assert result["rvm_fps"] > 0 and result["rvm_proc_fps"] == 31.5
    assert result["rvm_precision"] == "fp16" and result["rvm_downsample"] == 0.2667
    assert result["rvm_device"] == "cuda" and result["rvm_target_fps"] == 15
    assert "rvm" not in result["skipped"] and "rvm" not in result["errors"]
    # sustained rate without the first batch (4 frames on CUDA) + fixed startup (perf-rvm.md)
    assert result["rvm_steady_fps"] == round(121 / 2.5, 1)
    assert result["rvm_startup_s"] == 3.7 and result["rvm_bottleneck"] == "encode"
    assert result["rvm_stage_ms"] == {"encode": 20.0} and result["rvm_alpha_codec"] == "vp9"
