"""Sprint 4 (M3): tools/launch.py, the generic launcher of the isolated tools (stdlib only).

In-process tests import the file as a module; the end-to-end ones run it with this interpreter
(no tool venv needed) through toolvenv.command(), exactly as the face/tts runners do."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from studio_workers import toolvenv

LAUNCH = Path(__file__).resolve().parents[3] / "tools" / "launch.py"


def load_launch() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("studio_tool_launch", LAUNCH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def launch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[types.ModuleType]:
    """The module + a sandbox for what main() mutates (cwd, argv, sys.path, os.environ)."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    monkeypatch.setattr(sys, "path", list(sys.path))
    saved = dict(os.environ)  # main() adds/removes keys: restore the exact environment
    monkeypatch.setenv("STUDIO_MODELS_DIR", str(tmp_path / "models"))
    yield load_launch()
    os.environ.clear()
    os.environ.update(saved)


SCRIPT = """\
import json, os, sys
out = {"argv": sys.argv, "cwd": os.getcwd(), "path0": sys.path[0],
       "env": {k: os.environ.get(k) for k in ("HF_TOKEN", "OPENAI_API_KEY", "HF_HUB_OFFLINE",
               "PYTHONUTF8", "PYTHONIOENCODING", "OMP_NUM_THREADS", "HF_HOME", "PYTHONPATH",
               "ELEVENLABS_API_KEY", "PATH")}}
with open(os.environ["OUT_FILE"], "w", encoding="utf-8") as fh:
    json.dump(out, fh)
"""


def test_env_scrubbing_and_offline_flags(launch: types.ModuleType, tmp_path: Path) -> None:
    env = {
        "HF_TOKEN": "hf_x",
        "HUGGING_FACE_HUB_TOKEN": "hf_y",
        "OPENAI_API_KEY": "sk",
        "ELEVENLABS_API_KEY": "el",
        "MY_SERVICE_SECRET": "s",
        "PYTHONPATH": "/workers",
        "PATH": "/usr/bin",
        "STUDIO_MODELS_DIR": str(tmp_path / "models"),
    }
    removed = launch.scrub_env(dict(env))
    assert set(removed) == {"HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY",
                            "ELEVENLABS_API_KEY", "MY_SERVICE_SECRET"}  # fmt: skip
    launch.apply_env("facefusion", env)
    assert "HF_TOKEN" not in env and "OPENAI_API_KEY" not in env and "PYTHONPATH" not in env
    assert env["HF_HUB_OFFLINE"] == "1" and env["TRANSFORMERS_OFFLINE"] == "1"
    assert env["PYTHONUTF8"] == "1" and env["PYTHONIOENCODING"] == "utf-8"
    assert env["OMP_NUM_THREADS"] == "1" and env["PATH"] == "/usr/bin"
    assert env["HF_HOME"] == str(tmp_path / "models" / "facefusion" / ".hf")
    other = {"PATH": "/usr/bin"}
    launch.apply_env("chatterbox", other)
    assert "OMP_NUM_THREADS" not in other and other["STUDIO_TOOL"] == "chatterbox"


def test_runs_script_with_argv_cwd_and_clean_env(
    launch: types.ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = tmp_path / "app dir ñ"
    app.mkdir()
    (app / "tool.py").write_text(SCRIPT, "utf-8")
    out = tmp_path / "out.json"
    monkeypatch.setenv("OUT_FILE", str(out))
    monkeypatch.setenv("HF_TOKEN", "hf_secret")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    code = launch.main(["--tool", "facefusion", "--chdir", str(app), "--", "tool.py",
                        "headless-run", "--source-paths", "a b.jpg"])  # fmt: skip
    assert code == 0
    data = json.loads(out.read_text("utf-8"))
    assert data["argv"] == [str(app / "tool.py"), "headless-run", "--source-paths", "a b.jpg"]
    assert Path(data["cwd"]) == app and Path(data["path0"]) == app
    assert data["env"]["HF_TOKEN"] is None and data["env"]["OPENAI_API_KEY"] is None
    assert data["env"]["HF_HUB_OFFLINE"] == "1" and data["env"]["OMP_NUM_THREADS"] == "1"
    # the launcher's own folder (tools/) is not on sys.path
    assert str(LAUNCH.parent) not in sys.path


def test_dash_c_mode(
    launch: types.ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "c.json"
    monkeypatch.setenv("OUT_FILE", str(out))
    code = "import json, os, sys\nopen(os.environ['OUT_FILE'], 'w').write(json.dumps(sys.argv))"
    assert launch.main(["--tool", "chatterbox", "--chdir", str(tmp_path), "--", "-c", code,
                        "x", "y"]) == 0  # fmt: skip
    assert json.loads(out.read_text()) == ["-c", "x", "y"]


@pytest.mark.parametrize(
    "argv,needle",
    [
        (["--tool", "facefusion", "facefusion.py"], "uso"),
        (["--tool", "nope", "--", "x.py"], "--tool"),
        (["--tool", "facefusion", "--"], "falta el script"),
        (["--tool", "facefusion", "--bogus", "--", "x.py"], "desconocido"),
        (["--tool", "facefusion", "--chdir", "/no/such/dir", "--", "x.py"], "carpeta"),
        (["--tool", "facefusion", "--", "missing.py"], "no existe el script"),
    ],
)
def test_startup_errors_are_one_json_line(
    launch: types.ModuleType, capsys: pytest.CaptureFixture[str], argv: list[str], needle: str
) -> None:
    assert launch.main(argv) == 2
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1
    event = json.loads(out[0])
    assert event["event"] == "error" and event["code"] == "LAUNCH_FAILED"
    assert needle in event["message"]


def test_preload_ort_with_fake_onnxruntime(
    launch: types.ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    fake = types.ModuleType("onnxruntime")
    fake.preload_dlls = lambda: calls.append("preload")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    site = tmp_path / "site"
    for pkg in ("cublas", "cudnn", "curand"):
        (site / "nvidia" / pkg / "bin").mkdir(parents=True)
    dirs = launch.nvidia_dll_dirs([site], windows=True)
    assert [d.parent.name for d in dirs] == ["cublas", "cudnn", "curand"]
    assert launch.nvidia_dll_dirs([site], windows=False) == []  # Linux wheels use lib/
    monkeypatch.setattr(launch, "nvidia_dll_dirs", lambda *a, **k: dirs)
    added: list[str] = []
    monkeypatch.setattr(os, "add_dll_directory", lambda d: added.append(d) or object(),
                        raising=False)  # fmt: skip
    app = tmp_path / "app"
    app.mkdir()
    (app / "tool.py").write_text("import onnxruntime\n", "utf-8")
    monkeypatch.setenv("PATH", "/usr/bin")
    assert launch.main(["--tool", "facefusion", "--chdir", str(app), "--preload-ort", "--",
                        "tool.py"]) == 0  # fmt: skip
    assert calls == ["preload"]
    assert added == [str(d) for d in dirs]
    assert os.environ["PATH"].split(os.pathsep)[0] == str(dirs[-1])
    assert all(str(d) in os.environ["PATH"] for d in dirs)


def test_preload_failure_is_a_warning(
    launch: types.ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:  # fmt: skip
    fake = types.ModuleType("onnxruntime")

    def boom() -> None:
        raise OSError("cudnn64_9.dll not found")

    fake.preload_dlls = boom  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    monkeypatch.setattr(launch, "nvidia_dll_dirs", lambda *a, **k: [])
    (tmp_path / "t.py").write_text("print('ran')\n")
    assert launch.main(["--tool", "facefusion", "--chdir", str(tmp_path), "--preload-ort", "--",
                        "t.py"]) == 0  # fmt: skip
    cap = capsys.readouterr()
    assert "ran" in cap.out and "cudnn64_9.dll" in cap.err


def test_preload_without_onnxruntime_fails(
    launch: types.ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:  # fmt: skip
    monkeypatch.setitem(sys.modules, "onnxruntime", None)  # import -> ImportError
    monkeypatch.setattr(launch, "nvidia_dll_dirs", lambda *a, **k: [])
    (tmp_path / "t.py").write_text("print('ran')\n")
    assert launch.main(["--tool", "facefusion", "--chdir", str(tmp_path), "--preload-ort", "--",
                        "t.py"]) == 2  # fmt: skip
    event = json.loads(capsys.readouterr().out.strip())
    assert event["code"] == "LAUNCH_FAILED" and "onnxruntime" in event["message"]


def test_tool_exit_code_is_kept(launch: types.ModuleType, tmp_path: Path) -> None:
    (tmp_path / "t.py").write_text("raise SystemExit(3)\n")
    with pytest.raises(SystemExit) as exc:
        launch.main(["--tool", "facefusion", "--chdir", str(tmp_path), "--", "t.py"])
    assert exc.value.code == 3


# ------------------------------------------------------------------- real process, end to end


def test_command_runs_through_launch_py(
    dirs: tuple[Path, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """toolvenv.command() + tools/launch.py with this interpreter as FACEFUSION_PYTHON (what the
    e2e mocks do): secrets never reach the tool, paths with spaces/accents stay one argument."""
    app = tmp_path / "fake facefusion"
    app.mkdir()
    (app / "facefusion.py").write_text(SCRIPT, "utf-8")
    out = tmp_path / "out.json"
    monkeypatch.setenv("FACEFUSION_PYTHON", sys.executable)
    monkeypatch.setenv("FACEFUSION_APP_DIR", str(app))
    monkeypatch.setenv("OUT_FILE", str(out))
    monkeypatch.setenv("HF_TOKEN", "hf_secret")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "el-secret")
    monkeypatch.setenv("PYTHONPATH", "/somewhere")
    photo = tmp_path / "Persona Ñandú" / "foto 1.jpg"
    argv, env, cwd = toolvenv.command("facefusion", "facefusion.py",
                                      ["headless-run", "--source-paths", str(photo)])  # fmt: skip
    proc = subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True, timeout=60)  # noqa: S603
    assert proc.returncode == 0, proc.stdout + proc.stderr
    data: dict[str, Any] = json.loads(out.read_text("utf-8"))
    assert data["argv"][1:] == ["headless-run", "--source-paths", str(photo)]
    assert Path(data["cwd"]) == app
    assert data["env"]["HF_TOKEN"] is None and data["env"]["ELEVENLABS_API_KEY"] is None
    assert data["env"]["PYTHONPATH"] is None
    assert data["env"]["HF_HUB_OFFLINE"] == "1" and data["env"]["PYTHONUTF8"] == "1"
    assert data["env"]["HF_HOME"] == str(dirs[1] / "facefusion" / ".hf")


def test_launch_failed_from_a_real_process(tmp_path: Path) -> None:
    proc = subprocess.run(  # noqa: S603
        [sys.executable, str(LAUNCH), "--tool", "chatterbox", "--chdir", str(tmp_path), "--",
         "studio_tts_server.py"],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    assert proc.returncode == 2
    event = json.loads(proc.stdout.strip())
    assert event == {"event": "error", "code": "LAUNCH_FAILED", "message": event["message"]}
    assert "studio_tts_server.py" in event["message"]
