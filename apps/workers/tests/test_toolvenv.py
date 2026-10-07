"""Sprint 4 (M3): isolated tool venvs (studio_workers/toolvenv.py). No real venv, pip or download:
a fake runner simulates `python -m venv` / pip / the launch.py check and httpx.MockTransport serves
the FaceFusion zip."""

from __future__ import annotations

import dataclasses
import io
import json
import os
import re
import subprocess
import sys
import time
import types
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from studio_workers import toolvenv
from studio_workers.downloads import DownloadError
from studio_workers.errors import CodedError

REPO = Path(__file__).resolve().parents[3]
COMMIT = "72470819a0373be3388b3929c8f8f311f418fc3c"
FF_URL = f"https://github.com/facefusion/facefusion/archive/{COMMIT}.zip"
FF_REQ_CUDA = """gradio==5.50.0
numpy==2.4.6
onnx==1.23.1
opencv-python-headless==5.0.0.93
scipy==1.18.1
onnxruntime-gpu[cuda,cudnn]==1.24.4
"""
FF_REQ_CPU = FF_REQ_CUDA.replace("onnxruntime-gpu[cuda,cudnn]==1.24.4", "onnxruntime==1.30.0")
CB_LOCK = {
    "chatterbox_git": "https://github.com/resemble-ai/chatterbox.git",
    "chatterbox_sha": "5de7a54aa4e5e2baadb0182dde554908b48b85c2",
    "perth_git": "https://github.com/resemble-ai/Perth.git",
    "perth_sha": "ff1c8ac55a976971245cdd53c18d6131ca00d993",
    "fallback_pypi": "chatterbox-tts==0.1.7",
    "python": "3.11",
    "torch": "2.6.0",
    "torch_cuda_index": "https://download.pytorch.org/whl/cu124",
}


def ff_zip(extra: bytes = b"") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        top = f"facefusion-{COMMIT}/"
        zf.writestr(top + "facefusion.py", "print('facefusion')\n")
        zf.writestr(top + "facefusion/__init__.py", "")
        zf.writestr(top + "requirements.txt", FF_REQ_CPU)
        if extra:
            zf.writestr(top + "extra.bin", extra)
    return buf.getvalue()


@pytest.fixture
def tv(dirs: tuple[Path, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Tool recipes in a temporary tools/ folder; base Python 3.12 found."""
    tools = tmp_path / "tools"
    ff, cb = tools / "facefusion", tools / "chatterbox"
    ff.mkdir(parents=True)
    cb.mkdir(parents=True)
    (ff / "facefusion.lock.json").write_text(
        json.dumps(
            {
                "version": "3.9.1",
                "commit": COMMIT,
                "source_url": FF_URL,
                "source_sha256": None,
                "python": "3.12",
            }
        ),  # fmt: skip
        "utf-8",
    )
    (ff / "requirements-cuda.txt").write_text(FF_REQ_CUDA, "utf-8")
    (ff / "requirements-cpu.txt").write_text(FF_REQ_CPU, "utf-8")
    (cb / "chatterbox.lock.json").write_text(json.dumps(CB_LOCK), "utf-8")
    (cb / "requirements.txt").write_text("numpy>=1.24,<2\nlibrosa==0.11.0\n", "utf-8")
    specs = {
        "facefusion": dataclasses.replace(
            toolvenv.TOOLS["facefusion"],
            lock=ff / "facefusion.lock.json",
            requirements={"cuda": ff / "requirements-cuda.txt", "cpu": ff / "requirements-cpu.txt"},
        ),
        "chatterbox": dataclasses.replace(
            toolvenv.TOOLS["chatterbox"],
            lock=cb / "chatterbox.lock.json",
            requirements={"cuda": cb / "requirements.txt", "cpu": cb / "requirements.txt"},
        ),
    }
    monkeypatch.setattr(toolvenv, "TOOLS", specs)
    monkeypatch.setattr(toolvenv, "TOOLS_DIR", tools)
    monkeypatch.setattr(toolvenv, "RUNTIMES_JSON", tools / "runtimes.json")
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", False)
    for key in ("FACEFUSION_PYTHON", "CHATTERBOX_PYTHON", "FACEFUSION_APP_DIR",
                "FACEFUSION_BASE_PYTHON", "STUDIO_TOOL_PRELOAD_ORT"):  # fmt: skip
        monkeypatch.setenv(key, "")
    state: dict[str, Any] = {"py312": ("/opt/python3.12/bin/python3.12", "3.12.10")}
    real_find = toolvenv.find_base_python

    def fake_base(tool: str, *, fresh: bool = False) -> tuple[str, str] | None:
        if tool == "chatterbox":
            return sys.executable, "3.11.9"
        return state["py312"]

    monkeypatch.setattr(toolvenv, "find_base_python", fake_base)
    toolvenv.clear_caches()
    return {"tools": tools, "ff": ff, "cb": cb, "models": dirs[1], "storage": dirs[0],
            "state": state, "real_find": real_find, "py312": state["py312"]}  # fmt: skip


class FakeRunner:
    """Records every argv; `python -m venv <dir>` creates the interpreter file; the launch.py check
    prints `check` as a JSON line. `fail` = substrings that make a command exit 1."""

    def __init__(self, check: dict[str, Any] | None = None, fail: tuple[str, ...] = ()) -> None:
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self.check = check if check is not None else {"ok": True}
        self.fail = fail

    def __call__(self, cmd: list[str], on_line, *, env=None, cwd=None) -> int:  # type: ignore[no-untyped-def]
        self.calls.append(list(cmd))
        self.envs.append(dict(env or {}))
        joined = " ".join(cmd)
        if any(f in joined for f in self.fail):
            on_line("ERROR simulated")
            return 1
        if cmd[1:3] == ["-m", "venv"]:
            py = toolvenv.venv_python(Path(cmd[3]))
            py.parent.mkdir(parents=True, exist_ok=True)
            py.write_text("#!python\n")
        if str(toolvenv.LAUNCHER) in cmd:
            on_line("some log line")
            on_line(json.dumps(self.check))
        return 0

    def joined(self) -> list[str]:
        return [" ".join(c) for c in self.calls]


def mock_client(payload: bytes) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == FF_URL
        return httpx.Response(200, content=payload, headers={"content-length": str(len(payload))})

    return httpx.Client(transport=httpx.MockTransport(handler))


FF_CUDA_CHECK = {
    "onnxruntime": "1.24.4",
    "dists": ["onnxruntime-gpu"],
    "available": ["CUDAExecutionProvider", "CPUExecutionProvider"],
    "session": None,
}

# ------------------------------------------------------------------------------- status


def test_status_missing_and_python_state(tv: dict[str, Any]) -> None:
    assert toolvenv.status("facefusion")["state"] == "missing"
    assert toolvenv.status("chatterbox")["state"] == "missing"
    tv["state"]["py312"] = None
    st = toolvenv.status("facefusion")
    assert st["state"] == "python"
    assert st["version"] == "3.9.1"
    assert toolvenv.status_summary("facefusion") == {"id": "facefusion", "state": "python"}
    rows = toolvenv.status_rows("facefusion")
    assert rows[0] == {"name": "Python 3.12 (herramientas)", "size": 0, "present": False}
    assert rows[1]["present"] is False
    # chatterbox never needs Python 3.12
    assert toolvenv.status("chatterbox")["state"] == "missing"


def test_ensure_facefusion_cuda_sequence(tv: dict[str, Any]) -> None:
    runner = FakeRunner(check=FF_CUDA_CHECK)
    lines: list[str] = []
    with mock_client(ff_zip()) as client:
        action = toolvenv.ensure(
            "facefusion", use_cuda=True, runner=runner, on_line=lines.append, client=client
        )
    assert action == "ejecutado"
    calls = runner.joined()
    py312 = tv["py312"][0]
    venv = tv["ff"] / ".venv"
    assert calls[0] == f"{py312} -m venv {venv}"
    assert "-m pip install --disable-pip-version-check --progress-bar off -U pip" in calls[1]
    uninstall = next(i for i, c in enumerate(calls) if " pip uninstall -y onnxruntime " in c + " ")
    install_req = next(i for i, c in enumerate(calls) if "-r " in c and "requirements-cuda" in c)
    assert uninstall < install_req  # onnxruntime* removed BEFORE the requirements
    assert "onnxruntime-gpu" in calls[uninstall]
    assert not any("install.py" in c for c in calls)  # never FaceFusion's installer
    assert all(c.split()[0] in (py312, str(toolvenv.venv_python(venv))) for c in calls)
    check = calls[-1]
    assert str(toolvenv.LAUNCHER) in check and "--preload-ort" in check
    assert "--tool facefusion" in check
    # code extracted at the pinned commit, junction/symlink to models/facefusion
    app = tv["ff"] / "app"
    assert (app / "facefusion.py").is_file()
    assert (app / toolvenv.APP_COMMIT).read_text().strip() == COMMIT
    link = app / ".assets" / "models"
    assert link.is_symlink() and link.resolve() == (tv["models"] / "facefusion").resolve()
    record = json.loads((tv["ff"] / toolvenv.SOURCE_RECORD).read_text())
    assert record["verified"] == "first-download" and len(record["sha256"]) == 64
    stamp = toolvenv.read_stamp(venv)
    assert stamp is not None and stamp.profile == "cuda" and stamp.source == COMMIT
    assert stamp.hash == toolvenv.recipe_hash("facefusion", "cuda")
    assert stamp.python == "3.12.10"
    st = toolvenv.status("facefusion", use_cuda=True)
    assert st["state"] == "ready"
    assert st["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    # the check ran with the tool environment (no tokens, offline)
    env = runner.envs[-1]
    assert env["HF_HUB_OFFLINE"] == "1" and env["OMP_NUM_THREADS"] == "1"
    # second run: skipped by the stamp, nothing executed
    again = FakeRunner()
    assert toolvenv.ensure("facefusion", use_cuda=True, runner=again) == "omitido"
    assert again.calls == []


def test_stale_by_requirements_lock_or_profile(tv: dict[str, Any]) -> None:
    with mock_client(ff_zip()) as client:
        toolvenv.ensure(
            "facefusion", use_cuda=True, runner=FakeRunner(FF_CUDA_CHECK), client=client
        )
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "ready"
    # CPU <-> CUDA profile change
    assert toolvenv.status("facefusion", use_cuda=False)["state"] == "stale"
    # requirements changed
    req = tv["ff"] / "requirements-cuda.txt"
    req.write_text(FF_REQ_CUDA + "tqdm==4.70.1\n", "utf-8")
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "stale"
    req.write_text(FF_REQ_CUDA, "utf-8")
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "ready"
    # lock changed
    lock = tv["ff"] / "facefusion.lock.json"
    data = json.loads(lock.read_text())
    lock.write_text(json.dumps({**data, "version": "3.9.2"}), "utf-8")
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "stale"
    # stale -> ensure recreates the venv (marker file inside disappears)
    marker = tv["ff"] / ".venv" / "old-file"
    marker.write_text("x")
    runner = FakeRunner(FF_CUDA_CHECK)
    assert toolvenv.ensure("facefusion", use_cuda=True, runner=runner) == "ejecutado"
    assert not marker.exists()
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "ready"


def test_ensure_without_python312_is_tool_missing(tv: dict[str, Any]) -> None:
    tv["state"]["py312"] = None
    with pytest.raises(CodedError) as err:
        toolvenv.ensure("facefusion", use_cuda=False, runner=FakeRunner())
    assert err.value.code == "TOOL_MISSING" and err.value.status == 409
    assert err.value.details == {"tool": "facefusion", "state": "python", "packId": "faceswap"}
    assert "Python 3.12" in str(err.value)


def test_zip_sha_mismatch_is_an_error(tv: dict[str, Any]) -> None:
    with mock_client(ff_zip()) as client:
        toolvenv.ensure(
            "facefusion", use_cuda=False, runner=FakeRunner({"dists": []}), client=client
        )
    # the app folder disappears; a different zip for the same commit must be refused
    import shutil

    shutil.rmtree(tv["ff"] / "app")
    lock = toolvenv.read_lock("facefusion")
    with mock_client(ff_zip(extra=b"tampered")) as client, pytest.raises(DownloadError):
        toolvenv.fetch_facefusion_app(lock, client=client)
    # a pinned source_sha256 in the lock is enforced too
    pinned = {**lock, "source_sha256": "0" * 64}
    (tv["ff"] / toolvenv.SOURCE_RECORD).unlink()
    with mock_client(ff_zip()) as client, pytest.raises(DownloadError):
        toolvenv.fetch_facefusion_app(pinned, client=client)


def test_unsafe_zip_member_refused(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../evil.py", "x")
    z = tmp_path / "evil.zip"
    z.write_bytes(buf.getvalue())
    with pytest.raises(toolvenv.ToolError):
        toolvenv.extract_app(z, tmp_path / "app")


def test_never_two_onnxruntime(tv: dict[str, Any]) -> None:
    both = tv["ff"] / "requirements-cuda.txt"
    both.write_text(FF_REQ_CUDA + "onnxruntime==1.30.0  # CPU build too\n", "utf-8")
    with pytest.raises(toolvenv.ToolError, match="dos onnxruntime"):
        toolvenv.assert_single_ort(both)
    runner = FakeRunner()
    with pytest.raises(toolvenv.ToolError):
        toolvenv.ensure("facefusion", use_cuda=True, runner=runner)
    assert runner.calls == []  # refused before creating anything
    both.write_text(FF_REQ_CUDA, "utf-8")
    toolvenv.assert_single_ort(both)  # one line with extras is fine
    assert toolvenv.ort_requirements(both) == ["onnxruntime-gpu[cuda,cudnn]==1.24.4"]
    # the venv check reports two builds -> error
    bad = {**FF_CUDA_CHECK, "dists": ["onnxruntime", "onnxruntime-gpu"]}
    with mock_client(ff_zip()) as client, pytest.raises(toolvenv.ToolError, match="dos"):
        toolvenv.ensure("facefusion", use_cuda=True, runner=FakeRunner(bad), client=client)


def test_check_failure_marks_broken(tv: dict[str, Any]) -> None:
    runner = FakeRunner(fail=(str(toolvenv.LAUNCHER),))
    with mock_client(ff_zip()) as client, pytest.raises(toolvenv.ToolError, match="prueba"):
        toolvenv.ensure("facefusion", use_cuda=False, runner=runner, client=client)
    st = toolvenv.status("facefusion", use_cuda=False)
    assert st["state"] == "broken" and "simulated" in st["error"]
    # broken -> the next ensure recreates and clears the marker
    ok = FakeRunner({"dists": ["onnxruntime"], "available": ["CPUExecutionProvider"]})
    assert toolvenv.ensure("facefusion", use_cuda=False, runner=ok) == "ejecutado"
    assert toolvenv.status("facefusion", use_cuda=False)["state"] == "ready"


def test_cuda_not_loading_is_a_warning_not_broken(tv: dict[str, Any]) -> None:
    check = {"dists": ["onnxruntime-gpu"], "available": ["CPUExecutionProvider"], "session": None}
    lines: list[str] = []
    with mock_client(ff_zip()) as client:
        toolvenv.ensure("facefusion", use_cuda=True, runner=FakeRunner(check),
                        on_line=lines.append, client=client)  # fmt: skip
    assert any("onnx_cuda_unavailable" in ln for ln in lines)
    assert toolvenv.status("facefusion", use_cuda=True)["state"] == "ready"


def test_ensure_chatterbox_cuda_git(tv: dict[str, Any]) -> None:
    runner = FakeRunner(check={"torch": "2.6.0+cu124", "cuda": True, "cuda_version": "12.4"})
    assert toolvenv.ensure("chatterbox", use_cuda=True, runner=runner,
                           git_available=lambda: True) == "ejecutado"  # fmt: skip
    calls = runner.joined()
    assert calls[0] == f"{sys.executable} -m venv {tv['cb'] / '.venv'}"
    assert "-U pip wheel setuptools<82" in calls[1]
    torch = next(c for c in calls if "torch==2.6.0" in c)
    assert "torchaudio==2.6.0" in torch
    assert "--index-url https://download.pytorch.org/whl/cu124" in torch
    perth = next(i for i, c in enumerate(calls) if "resemble-perth @ git+" in c)
    req = next(i for i, c in enumerate(calls) if "-r " in c)
    cb = next(i for i, c in enumerate(calls) if "chatterbox-tts @ git+" in c)
    assert perth < req < cb
    assert "--no-deps" in calls[cb] and CB_LOCK["chatterbox_sha"] in calls[cb]
    assert CB_LOCK["perth_sha"] in calls[perth]
    assert not any("chatterbox-tts==0.1.7" in c for c in calls)
    st = toolvenv.status("chatterbox", use_cuda=True)
    assert st["state"] == "ready" and st["variant"] == "v3" and st["providers"] == ["cuda"]
    assert st["source"] == CB_LOCK["chatterbox_sha"]
    assert st["version"] == "git 5de7a54"
    stamp_text = (tv["cb"] / ".venv" / toolvenv.STAMP).read_text()
    assert re.match(r"^[0-9a-f]{16} cuda\n", stamp_text)
    assert "variant v3\n" in stamp_text and f"source {CB_LOCK['chatterbox_sha']}" in stamp_text


def test_chatterbox_cpu_has_no_cuda_index(tv: dict[str, Any]) -> None:
    runner = FakeRunner(check={"torch": "2.6.0", "cuda": False})
    toolvenv.ensure("chatterbox", use_cuda=False, runner=runner, git_available=lambda: True)
    torch = next(c for c in runner.joined() if "torch==2.6.0" in c)
    assert "--index-url" not in torch and "cu124" not in torch


@pytest.mark.parametrize("why", ["no-git", "git-fails"])
def test_chatterbox_falls_back_to_v2(tv: dict[str, Any], why: str) -> None:
    runner = FakeRunner(
        check={"torch": "2.6.0", "cuda": False},
        fail=("git+https://github.com/resemble-ai/chatterbox",) if why == "git-fails" else (),
    )
    lines: list[str] = []
    toolvenv.ensure("chatterbox", use_cuda=False, runner=runner, on_line=lines.append,
                    git_available=lambda: why != "no-git")  # fmt: skip
    calls = runner.joined()
    fallback = [c for c in calls if "chatterbox-tts==0.1.7" in c]
    assert fallback and "setuptools<82" in fallback[0]
    assert any("chatterbox_v2_fallback" in ln for ln in lines)
    if why == "no-git":
        assert not any("git+" in c for c in calls)
    st = toolvenv.status("chatterbox", use_cuda=False)
    assert st["variant"] == "v2" and st["version"] == "0.1.7"


# ------------------------------------------------------------------------ command / env


def _ready_facefusion(tv: dict[str, Any], profile: str = "cuda") -> None:
    venv = tv["ff"] / ".venv"
    py = toolvenv.venv_python(venv)
    py.parent.mkdir(parents=True, exist_ok=True)
    py.write_text("#!python\n")
    app = tv["ff"] / "app"
    app.mkdir(exist_ok=True)
    (app / "facefusion.py").write_text("")
    stamp = toolvenv.Stamp(hash=toolvenv.recipe_hash("facefusion", profile), profile=profile)
    (venv / toolvenv.STAMP).write_text(stamp.render())


def test_command_argv_env_cwd(tv: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    _ready_facefusion(tv, "cuda")
    monkeypatch.setenv("HF_TOKEN", "hf_secret")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "x")
    monkeypatch.setenv("PYTHONPATH", "/workers")
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    src = tv["storage"] / "media" / "foto con espacio ñ.jpg"
    argv, env, cwd = toolvenv.command("facefusion", "facefusion.py", ["headless-run", "-s", src])
    py = toolvenv.venv_python(tv["ff"] / ".venv")
    assert argv[:6] == [str(py), str(toolvenv.LAUNCHER), "--tool", "facefusion", "--chdir",
                        str(tv["ff"] / "app")]  # fmt: skip
    assert argv[6] == "--preload-ort"  # CUDA venv
    assert argv[7:] == ["--", "facefusion.py", "headless-run", "-s", str(src)]
    assert all(isinstance(a, str) for a in argv)
    assert cwd == tv["ff"] / "app"
    for secret in ("HF_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PYTHONPATH"):
        assert secret not in env
    assert env["HF_HUB_OFFLINE"] == "1" and env["PYTHONUTF8"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8" and env["OMP_NUM_THREADS"] == "1"
    assert env["HF_HOME"] == str(tv["models"] / "facefusion" / ".hf")
    # CPU venv: no DLL preload; chatterbox: cwd tools/chatterbox, no OMP pin
    _ready_facefusion(tv, "cpu")
    argv, _env, _cwd = toolvenv.command("facefusion", "facefusion.py", [])
    assert "--preload-ort" not in argv
    argv, env, cwd = toolvenv.command("chatterbox", "studio_tts_server.py", ["--device", "cpu"])
    assert cwd == tv["cb"] and "OMP_NUM_THREADS" not in env
    assert argv[-4:] == ["--", "studio_tts_server.py", "--device", "cpu"]


def test_interpreter_resolution_windows_and_posix(
    tv: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = Path("C:/Studio/tools/facefusion/.venv")
    assert toolvenv.venv_python(venv, windows=True) == venv / "Scripts" / "python.exe"
    assert toolvenv.venv_python(venv, windows=False) == venv / "bin" / "python"
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", True)
    argv, _env, _cwd = toolvenv.command("chatterbox", "studio_tts_server.py", [])
    assert argv[0].endswith(os.path.join("Scripts", "python.exe"))
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", False)
    argv, _env, _cwd = toolvenv.command("chatterbox", "studio_tts_server.py", [])
    assert argv[0].endswith(os.path.join("bin", "python"))


def test_python_overrides(tv: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    fake_app = tv["tools"] / "fake_ff"
    fake_app.mkdir()
    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    monkeypatch.setenv("FACEFUSION_APP_DIR", str(fake_app))
    monkeypatch.setenv("CHATTERBOX_PYTHON", sys.executable)
    st = toolvenv.status("facefusion")
    assert st["state"] == "ready" and st["override"] is True and st["python"] == sys.executable
    argv, _env, cwd = toolvenv.command("facefusion", "facefusion.py", ["x"])
    assert argv[0] == sys.executable and cwd == fake_app and "--preload-ort" not in argv
    runner = FakeRunner()
    assert toolvenv.ensure("facefusion", use_cuda=True, runner=runner) == "omitido"
    assert toolvenv.ensure("chatterbox", use_cuda=True, runner=runner) == "omitido"
    assert runner.calls == []
    assert toolvenv.status_rows("facefusion")[0]["present"] is True  # no Python 3.12 row


def test_find_base_python_order(tv: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(toolvenv, "find_base_python", tv["real_find"])
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", True)
    toolvenv.clear_caches()
    # Real (empty) files: absolute candidates that do not exist are skipped, and on a Windows
    # runner "C:/Py312/python.exe" is absolute.
    root = tv["tools"].parent
    py312, py311, explicit = (root / d / "python.exe" for d in ("Py312", "Py311", "explicit"))
    for exe in (py312, py311, explicit):
        exe.parent.mkdir(parents=True, exist_ok=True)
        exe.write_bytes(b"")
    versions = {str(py312): "3.12.10", str(py311): "3.11.9", str(explicit): "3.12.4"}
    monkeypatch.setattr(toolvenv, "probe_python", lambda exe: versions.get(exe))
    monkeypatch.setattr(toolvenv, "_py_launcher", lambda v: str(py312))
    monkeypatch.setattr(toolvenv.shutil, "which", lambda name: None)
    monkeypatch.setenv("FACEFUSION_BASE_PYTHON", "")
    assert toolvenv.find_base_python("facefusion", fresh=True) == (str(py312), "3.12.10")
    # tools/runtimes.json (written by setup.ps1) goes first
    (tv["tools"] / "runtimes.json").write_text(
        json.dumps({"python312": {"path": str(py311)}}), "utf-8"
    )
    # ... but a wrong version is skipped
    assert toolvenv.find_base_python("facefusion", fresh=True)[0] == str(py312)
    # an absolute candidate that does not exist is never probed
    monkeypatch.setattr(toolvenv, "_py_launcher", lambda v: str(root / "missing" / "python.exe"))
    (tv["tools"] / "runtimes.json").write_text(
        json.dumps({"python312": {"path": str(py312)}}), "utf-8"
    )
    assert toolvenv.find_base_python("facefusion", fresh=True) == (str(py312), "3.12.10")
    # FACEFUSION_BASE_PYTHON is the only candidate when set
    monkeypatch.setenv("FACEFUSION_BASE_PYTHON", str(explicit))
    assert toolvenv.find_base_python("facefusion", fresh=True) == (str(explicit), "3.12.4")
    monkeypatch.setattr(toolvenv, "_py_launcher", lambda v: None)
    monkeypatch.setenv("FACEFUSION_BASE_PYTHON", "")
    (tv["tools"] / "runtimes.json").unlink()
    monkeypatch.setattr(toolvenv, "_windows_locations", lambda v: [])
    assert toolvenv.find_base_python("facefusion", fresh=True) is None
    assert toolvenv.find_base_python("chatterbox")[0] == sys.executable
    toolvenv.clear_caches()


def test_kill_tree_command_and_posix_group(monkeypatch: pytest.MonkeyPatch) -> None:
    assert toolvenv.kill_tree_command(4321) == ["taskkill", "/T", "/F", "/PID", "4321"]
    seen: list[list[str]] = []
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", True)
    monkeypatch.setattr(toolvenv.subprocess, "run", lambda argv, **kw: seen.append(argv) or None)
    toolvenv.kill_tree(4321)
    assert seen == [["taskkill", "/T", "/F", "/PID", "4321"]]
    assert "creationflags" in toolvenv.popen_kwargs()
    monkeypatch.undo()
    if os.name == "nt":
        return
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", False)
    assert toolvenv.popen_kwargs() == {"start_new_session": True}
    # a parent with a child in its own session: killpg takes both
    proc = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c",
         "import subprocess, sys, time; c = subprocess.Popen([sys.executable, '-c', "
         "'import time; time.sleep(60)']); print(c.pid, flush=True); time.sleep(60)"],
        stdout=subprocess.PIPE, text=True, **toolvenv.popen_kwargs(),
    )  # fmt: skip
    assert proc.stdout is not None
    child = int(proc.stdout.readline().strip())
    toolvenv.kill_tree(proc)
    assert proc.returncode is not None
    deadline = time.monotonic() + 5
    while _alive(child) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(child)


def _alive(pid: int) -> bool:
    """Running (not a zombie waiting for a reaper, which containers may lack)."""
    stat = Path(f"/proc/{pid}/stat")
    if stat.parent.parent.is_dir() and Path("/proc/self").exists():
        try:
            state = stat.read_text().rsplit(")", 1)[1].split()[0]
        except (OSError, IndexError):
            return False
        return state not in ("Z", "X")
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_junction_on_windows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[tuple[str, str]] = []

    def create_junction(target: str, link: str) -> None:
        made.append((target, link))
        Path(link).mkdir()

    monkeypatch.setitem(
        sys.modules, "_winapi", types.SimpleNamespace(CreateJunction=create_junction)
    )
    monkeypatch.setattr(toolvenv, "IS_WINDOWS", True)
    link = tmp_path / "app" / ".assets" / "models"
    link.mkdir(parents=True)
    (link / "yoloface_8n.onnx").write_bytes(b"1")  # downloaded by FaceFusion itself: kept
    target = tmp_path / "models" / "facefusion"
    toolvenv.link_dir(link, target)
    assert made == [(str(target), str(link))]
    assert (target / "yoloface_8n.onnx").read_bytes() == b"1"


def test_symlink_relinked_when_target_changes(tmp_path: Path) -> None:
    link = tmp_path / "app" / ".assets" / "models"
    toolvenv.link_dir(link, tmp_path / "a")
    toolvenv.link_dir(link, tmp_path / "a")  # idempotent
    toolvenv.link_dir(link, tmp_path / "b")
    assert link.resolve() == (tmp_path / "b").resolve()
    assert (tmp_path / "a").is_dir()  # the old target is untouched


def test_junction_detected_without_isjunction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Python 3.11 (the workers) has no os.path.isjunction: lstat's reparse tag is used."""
    folder = tmp_path / "j"
    folder.mkdir()
    monkeypatch.delattr(toolvenv.os.path, "isjunction", raising=False)
    assert toolvenv._is_dir_link(folder) is False

    class _St:
        st_file_attributes = 0x10 | 0x400  # DIRECTORY | REPARSE_POINT
        st_reparse_tag = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT

    real_lstat = toolvenv.os.lstat
    monkeypatch.setattr(
        toolvenv.os, "lstat", lambda p: _St() if Path(p) == folder else real_lstat(p)
    )
    assert toolvenv._is_dir_link(folder) is True
    _St.st_reparse_tag = 0x8000001B  # another reparse point (AppExecLink): not a junction
    assert toolvenv._is_dir_link(folder) is False


# ------------------------------------------------------------------------------ licences


def test_licence_mirror(tv: dict[str, Any]) -> None:
    mirror = tv["storage"] / "consent" / "licences.json"
    assert toolvenv.licence_accepted("faceswap") is False
    assert toolvenv.licence_status()["exists"] is False
    mirror.parent.mkdir(parents=True)
    mirror.write_text(json.dumps({"accepted": {"faceswap": {"text_version": "2026-10-06",
                                  "accepted_at": "2026-10-06T20:00:00Z"}}}), "utf-8")  # fmt: skip
    assert toolvenv.licence_accepted("faceswap") is True
    st = toolvenv.licence_status()
    assert st["readable"] and st["licences"]["faceswap"]["accepted"] is True
    mirror.write_text(json.dumps({"accepted": {"faceswap": {"text_version": "2025-01-01"}}}))
    assert toolvenv.licence_accepted("faceswap") is False  # old text: must accept again
    mirror.write_text(json.dumps({"accepted": {"faceswap": {"text_version": "2026-10-06",
                                  "revoked_at": "2026-10-07T00:00:00Z"}}}))  # fmt: skip
    assert toolvenv.licence_accepted("faceswap") is False
    mirror.write_text("{not json")
    assert toolvenv.licence_accepted("faceswap") is False
    assert toolvenv.licence_status()["readable"] is False


def test_licence_text_version_in_sync_with_shared() -> None:
    src = (REPO / "packages" / "shared" / "src" / "consent.ts").read_text("utf-8")
    block = src[src.index("export const LICENCES") :]
    m = re.search(r'faceswap:\s*\{[^}]*?text_version:\s*"([^"]+)"', block, re.S)
    assert m is not None
    assert toolvenv.LICENCE_TEXT_VERSIONS["faceswap"] == m.group(1)


ALLOWED = [
    "PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL",
    "PYTHONUTF8", "PYTHONIOENCODING", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES",
    "HF_HUB_OFFLINE", "STUDIO_MODELS_DIR",
]  # fmt: skip
DENIED = [
    "HF_TOKEN", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY", "PYTHONPATH", "VIRTUAL_ENV", "UNKNOWN_APP_SETTING", "AWS_PROFILE",
    "STUDIO_API_TOKEN",
]  # fmt: skip


def test_tool_env_is_an_allowlist() -> None:
    """Audit fix 9 (25 names): only allowlisted variables reach a tool process; secrets never,
    even with an allowed prefix; proxies only for installs (network=True)."""
    assert len(ALLOWED) + len(DENIED) == 25
    base = {name: "x" for name in ALLOWED + DENIED}
    env = toolvenv.scrubbed_env(base)
    assert sorted(env) == sorted(ALLOWED)
    assert "HTTPS_PROXY" not in toolvenv.scrubbed_env({"HTTPS_PROXY": "http://p:3128"})
    install = toolvenv.scrubbed_env(
        {"HTTPS_PROXY": "http://p:3128", "https_proxy": "x"}, network=True
    )
    assert set(install) == {"HTTPS_PROXY", "https_proxy"}


def test_secret_detection() -> None:
    secrets = ["HF_TOKEN", "hf_token", "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY"]
    secrets += ["ELEVENLABS_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD"]
    for name in secrets:
        assert toolvenv.is_secret_var(name), name
    for name in ("PATH", "HF_HOME", "HF_HUB_OFFLINE", "USE_CUDA", "TOKENIZERS_PARALLELISM"):
        assert not toolvenv.is_secret_var(name), name


def test_pack_hooks_and_require_ready(tv: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    hooks = toolvenv.pack_hooks("chatterbox")
    assert hooks["tool_status"]() == {"id": "chatterbox", "state": "missing"}
    assert hooks["extra_status"](tv["models"])[0]["present"] is False
    with pytest.raises(CodedError) as err:
        toolvenv.require_ready("chatterbox")
    assert err.value.code == "TOOL_MISSING"
    assert err.value.details == {
        "tool": "chatterbox",
        "state": "missing",
        "packId": "tts-chatterbox",
    }
    assert "Chatterbox" in str(err.value) and "falta" in str(err.value)
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(toolvenv, "ensure", lambda tool, **kw: calls.append({"tool": tool, **kw}))
    hooks["post_install_env"](tv["models"], print)
    assert calls[0]["tool"] == "chatterbox" and calls[0]["use_cuda"] is False


def test_verify_records_providers(tv: dict[str, Any]) -> None:
    _ready_facefusion(tv, "cpu")
    nsfw = tv["models"] / "facefusion" / "nsfw_2.onnx"
    nsfw.parent.mkdir(parents=True)
    nsfw.write_bytes(b"onnx")
    runner = FakeRunner({"dists": ["onnxruntime"], "available": ["CPUExecutionProvider"],
                         "session": "CPUExecutionProvider"})  # fmt: skip
    out = toolvenv.verify("facefusion", runner=runner)
    assert out["verified"] is True and out["providers"] == ["CPUExecutionProvider"]
    assert runner.calls[0][-2:] == [str(nsfw), "cpu"]  # a real ORT session on nsfw_2.onnx
    assert toolvenv.read_stamp(tv["ff"] / ".venv").providers == ["CPUExecutionProvider"]
    # doctor (record=False) never writes the broken marker
    bad = FakeRunner(fail=(str(toolvenv.LAUNCHER),))
    out = toolvenv.verify("facefusion", runner=bad, record=False)
    assert out["verified"] is False and out["state"] == "broken"
    assert toolvenv.status("facefusion", use_cuda=False)["state"] == "ready"


def _wait_until(cond: Callable[[], bool], timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def test_idle_timer_fires_once_after_last_touch() -> None:
    # Generous margins (busy Windows runners, 15.6 ms clock): what matters is the order.
    fired: list[float] = []
    timer = toolvenv.IdleTimer(0.6, lambda: fired.append(time.monotonic()))
    timer.touch()
    time.sleep(0.3)
    last = time.monotonic()
    timer.touch()  # restarts the countdown
    time.sleep(0.3)
    assert fired == []  # 0.6 s after the first touch, but only 0.3 s after the last one
    assert _wait_until(lambda: len(fired) == 1)
    assert fired[0] - last >= 0.6 - 0.05
    time.sleep(0.2)
    assert len(fired) == 1  # once
    off = toolvenv.IdleTimer(0, lambda: fired.append(0))
    off.touch()
    time.sleep(0.05)
    assert len(fired) == 1
    timer.cancel()


def test_idle_timer_early_wake_is_rescheduled_and_stale_timers_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fired: list[int] = []
    timer = toolvenv.IdleTimer(0.3, lambda: fired.append(1))
    # the clock says it is far too early (coarse clock / early wake): the release must not be
    # dropped, it runs once the rest of the wait has passed
    real = time.monotonic
    skew = {"s": 0.0}
    monkeypatch.setattr(toolvenv.time, "monotonic", lambda: real() - skew["s"])
    timer.touch()
    skew["s"] = 0.25  # from now on the clock reads 0.25 s behind: the first wake looks early
    assert _wait_until(lambda: fired == [1], timeout=3.0)
    # only the current timer's thread may release: a call from anywhere else is a no-op
    timer.touch()
    timer._fire()
    timer.cancel()
    time.sleep(0.5)
    assert fired == [1]


def test_override_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit fix 23: an override of the managed tool paths is logged at startup."""
    for key in ("FACEFUSION_PYTHON", "FACEFUSION_APP_DIR", "CHATTERBOX_PYTHON"):
        monkeypatch.delenv(key, raising=False)
    assert toolvenv.override_warnings() == []
    monkeypatch.setenv("FACEFUSION_APP_DIR", "scripts/e2e/fake_facefusion")
    warnings = toolvenv.override_warnings()
    assert len(warnings) == 1 and warnings[0].startswith("FACEFUSION_APP_DIR=")
