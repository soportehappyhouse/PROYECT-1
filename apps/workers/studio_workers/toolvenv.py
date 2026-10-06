"""Isolated tool environments (sprint 4): FaceFusion and Chatterbox, each in its own venv.

Decision 2 of the plan: GPL / non-commercial code and stacks with conflicting pins (FaceFusion needs
Python 3.12 + onnxruntime-gpu 1.24.4; Chatterbox pins torch 2.6.0 and numpy < 2) never run inside
the workers' venv. Each tool has:

- a recipe versioned in the repo: ``tools/<id>/<id>.lock.json`` + ``requirements*.txt``;
- a venv created on demand when its pack is downloaded (or by ``setup.ps1`` / ``models_cli
  --tool-venv``): ``tools/<id>/.venv`` with a stamp ``.studio-tool-install`` (hash of
  requirements + lock and the cuda/cpu profile; ``variant``/``source`` lines);
- a launcher ``tools/launch.py`` that runs INSIDE that venv: clean environment (no HF token or API
  keys, Hugging Face offline, UTF-8), optional ``onnxruntime.preload_dlls()``, fixed cwd, then the
  tool script through ``runpy``. ``command()`` builds that argv (always an array, never a shell).

States (``ToolStateSchema``): ``ready``, ``stale`` (requirements/lock or the CPU<->CUDA profile
changed, or an install was interrupted: ``ensure`` recreates the venv), ``missing``, ``broken``
(the import/ORT check failed) and ``python`` (FaceFusion needs Python 3.12 and none was found).

Everything that touches the network or spawns pip goes through ``runner`` / ``client`` arguments
so tests (and CI) never create a real tool venv nor download anything.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("studio_workers")

ToolId = Literal["facefusion", "chatterbox"]
ToolState = Literal["ready", "stale", "missing", "broken", "python"]
TOOL_IDS: tuple[ToolId, ...] = ("facefusion", "chatterbox")

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOLS_DIR = REPO_ROOT / "tools"
LAUNCHER = TOOLS_DIR / "launch.py"
# setup.ps1 («Python 3.12 para herramientas») records the interpreter it found/installed here.
RUNTIMES_JSON = TOOLS_DIR / "runtimes.json"
STAMP = ".studio-tool-install"
BROKEN = ".studio-tool-broken"
SOURCE_RECORD = ".studio-source.json"  # sha256 of the FaceFusion zip (trust on first download)
APP_COMMIT = ".studio-commit"

IS_WINDOWS = os.name == "nt"  # tests monkeypatch it (interpreter paths, junctions, kill tree)

LineFn = Callable[[str], None]
# runner(argv, on_line, env=None, cwd=None) -> exit code. Tests pass a fake one.
Runner = Callable[..., int]

LICENCE_MIRROR_REL = Path("consent") / "licences.json"  # LICENCE_MIRROR_PATH (shared/consent.ts)
# Text version of each licence (LICENCES[id].text_version in packages/shared/src/consent.ts;
# test_toolvenv checks they stay in sync). A mirror entry with another version does not count.
LICENCE_TEXT_VERSIONS: dict[str, str] = {"faceswap": "2026-10-06"}

PYPI_TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu124"
CHATTERBOX_PYPI_FALLBACK = "chatterbox-tts==0.1.7"
ORT_FLAVOURS = (
    "onnxruntime",
    "onnxruntime-gpu",
    "onnxruntime-directml",
    "onnxruntime-openvino",
    "onnxruntime-qnn",
    "onnxruntime-training",
)

STATE_ES: dict[str, str] = {
    "ready": "listo",
    "stale": "desactualizado",
    "missing": "falta",
    "broken": "roto",
    "python": "falta Python 3.12",
}

# ------------------------------------------------------------------------------------ settings


class ToolSettings(BaseSettings):
    """New .env keys (paths and timeouts only; empty = automatic). Strings on purpose: an empty
    ``CHATTERBOX_IDLE_S=`` must not break the workers."""

    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    facefusion_base_python: str = ""
    facefusion_python: str = ""
    facefusion_app_dir: str = ""
    chatterbox_python: str = ""
    chatterbox_idle_s: str = ""
    rvc_idle_s: str = ""
    ffmpeg_path: str = ""
    ffprobe_path: str = ""

    def seconds(self, name: str, default: float) -> float:
        raw = str(getattr(self, name, "") or "").strip()
        try:
            value = float(raw) if raw else default
        except ValueError:
            return default
        return value if value >= 0 else default


def tool_settings() -> ToolSettings:
    """Read every call (cheap): tests and a running service see .env / env changes."""
    return ToolSettings()


def _main_settings() -> Any:
    from .config import get_settings  # noqa: PLC0415

    return get_settings()


def models_root() -> Path:
    return Path(_main_settings().models_root)


def storage_root() -> Path:
    return Path(_main_settings().storage_root)


def use_cuda_setting() -> bool:
    try:
        return bool(_main_settings().use_cuda)
    except Exception:  # unreadable settings: CPU semantics
        return False


# ------------------------------------------------------------------------------------ specs

FACEFUSION_CHECK = """\
import importlib.metadata as md, json, sys
import onnxruntime as ort
names = sorted({(d.metadata["Name"] or "").lower() for d in md.distributions()})
flavours = [n for n in names if n.startswith("onnxruntime")]
if len(flavours) > 1:
    raise SystemExit("two onnxruntime builds in one venv: " + ", ".join(flavours))
model = sys.argv[1] if len(sys.argv) > 1 else ""
want = sys.argv[2] if len(sys.argv) > 2 else "cpu"
session = None
if model:
    providers = ["CUDAExecutionProvider"] if want == "cuda" else ["CPUExecutionProvider"]
    session = ort.InferenceSession(model, providers=providers).get_providers()[0]
print(json.dumps({"onnxruntime": ort.__version__, "dists": flavours,
                  "available": ort.get_available_providers(), "session": session}))
"""

CHATTERBOX_CHECK = """\
import json
import torch
import perth
import chatterbox.mtl_tts  # noqa: F401
if perth.PerthImplicitWatermarker is None:
    raise SystemExit("perth.PerthImplicitWatermarker is None (PerTh broken)")
print(json.dumps({"torch": torch.__version__, "cuda": bool(torch.cuda.is_available()),
                  "cuda_version": torch.version.cuda}))
"""


@dataclass(frozen=True)
class ToolSpec:
    id: ToolId
    pack_id: str
    python: Literal["3.11", "3.12"]  # 3.11 = base interpreter of the workers
    lock: Path  # tools/<id>/<id>.lock.json
    requirements: dict[str, Path]  # {"cuda": ..., "cpu": ...}
    check: list[str]  # python -c ... run through launch.py (imports; ORT with a real session)
    python_env: str  # FACEFUSION_PYTHON / CHATTERBOX_PYTHON (tests, advanced)
    app_dir_env: str | None  # FACEFUSION_APP_DIR (cwd of the tool); None = tools/<id>
    # additive (not in the contract signature)
    name_es: str = ""
    preload_ort: bool = False
    omp_single_thread: bool = False
    venv_size: tuple[int, int] = (0, 0)  # approx bytes (cuda, cpu) [S] for GET /packs


TOOLS: dict[ToolId, ToolSpec] = {
    "facefusion": ToolSpec(
        id="facefusion",
        pack_id="faceswap",
        python="3.12",
        lock=TOOLS_DIR / "facefusion" / "facefusion.lock.json",
        requirements={
            "cuda": TOOLS_DIR / "facefusion" / "requirements-cuda.txt",
            "cpu": TOOLS_DIR / "facefusion" / "requirements-cpu.txt",
        },
        check=["-c", FACEFUSION_CHECK],
        python_env="FACEFUSION_PYTHON",
        app_dir_env="FACEFUSION_APP_DIR",
        name_es="FaceFusion",
        preload_ort=True,
        omp_single_thread=True,
        # onnxruntime-gpu 207 MB + nvidia cu12/cudnn ~1.65 GB + numpy/opencv/scipy/gradio [V/S]
        venv_size=(2_200_000_000, 450_000_000),
    ),
    "chatterbox": ToolSpec(
        id="chatterbox",
        pack_id="tts-chatterbox",
        python="3.11",
        lock=TOOLS_DIR / "chatterbox" / "chatterbox.lock.json",
        requirements={
            "cuda": TOOLS_DIR / "chatterbox" / "requirements.txt",
            "cpu": TOOLS_DIR / "chatterbox" / "requirements.txt",
        },
        check=["-c", CHATTERBOX_CHECK],
        python_env="CHATTERBOX_PYTHON",
        app_dir_env=None,
        name_es="Chatterbox",
        # torch 2.6.0+cu124 ~2.5 GB [U] + transformers/librosa/...; CPU torch ~0.2 GB [V]
        venv_size=(3_000_000_000, 1_200_000_000),
    ),
}


def spec_of(tool: str) -> ToolSpec:
    if tool not in TOOLS:
        raise ValueError(f"Herramienta desconocida: {tool} (facefusion | chatterbox)")
    return TOOLS[cast(ToolId, tool)]


def tool_dir(tool: ToolId) -> Path:
    return spec_of(tool).lock.parent


def venv_dir(tool: ToolId) -> Path:
    return tool_dir(tool) / ".venv"


def venv_python(venv: Path, *, windows: bool | None = None) -> Path:
    """Interpreter of a venv: Scripts\\python.exe on Windows, bin/python elsewhere."""
    win = IS_WINDOWS if windows is None else windows
    return venv / "Scripts" / "python.exe" if win else venv / "bin" / "python"


def app_dir(tool: ToolId) -> Path:
    """cwd of the tool: FACEFUSION_APP_DIR or tools/facefusion/app; tools/chatterbox for Chatterbox
    (studio_tts_server.py lives there). FaceFusion resolves .assets/.jobs/.caches against it."""
    spec = spec_of(tool)
    if spec.app_dir_env:
        custom = str(getattr(tool_settings(), spec.app_dir_env.lower(), "") or "").strip()
        if custom:
            p = Path(custom)
            return p if p.is_absolute() else (REPO_ROOT / p).resolve()
        return tool_dir(tool) / "app"
    return tool_dir(tool)


def tool_models_dir(tool: ToolId) -> Path:
    return models_root() / tool


def override_python(tool: ToolId) -> str:
    """FACEFUSION_PYTHON / CHATTERBOX_PYTHON (tests, e2e mocks, advanced setups) or ''."""
    spec = spec_of(tool)
    return str(getattr(tool_settings(), spec.python_env.lower(), "") or "").strip()


def read_lock(tool: ToolId) -> dict[str, Any]:
    try:
        data = json.loads(spec_of(tool).lock.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def profile_of(use_cuda: bool) -> str:
    return "cuda" if use_cuda else "cpu"


def recipe_hash(tool: ToolId, profile: str) -> str:
    """sha256(requirements[profile] + lock)[:16]; 'none' while a recipe file is missing."""
    spec = spec_of(tool)
    req = spec.requirements.get(profile)
    try:
        data = (req.read_bytes() if req else b"") + b"\n--lock--\n" + spec.lock.read_bytes()
    except OSError:
        return "none"
    return hashlib.sha256(data).hexdigest()[:16]


def recipe_present(tool: ToolId, profile: str) -> bool:
    spec = spec_of(tool)
    req = spec.requirements.get(profile)
    return bool(req and req.is_file() and spec.lock.is_file())


# ------------------------------------------------------------------------- never two ORTs


def ort_requirements(path: Path) -> list[str]:
    """onnxruntime* requirement lines of a requirements file (comments and blanks skipped)."""
    out: list[str] = []
    try:
        lines = path.read_text("utf-8").splitlines()
    except OSError:
        return out
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if re.match(r"(?i)^onnxruntime([-_][a-z]+)?\b", line):
            out.append(line)
    return out


def assert_single_ort(path: Path) -> None:
    """A tool venv never gets two onnxruntime builds (they share the onnxruntime/ folder and the
    CUDA provider stops loading): at most one onnxruntime* line per requirements file."""
    found = ort_requirements(path)
    names = {
        re.split(r"[\[=<>~! ]", line, maxsplit=1)[0].lower().replace("_", "-") for line in found
    }
    if len(names) > 1 or len(found) > 1:
        raise ToolError(f"{path.name} pide dos onnxruntime a la vez: {', '.join(found)}")


# ------------------------------------------------------------------------------ errors


class ToolError(RuntimeError):
    """An ensure/verify step failed (message in Spanish, shown in the pack log)."""


def tool_missing_error(tool: ToolId, state: str) -> Exception:
    """409 TOOL_MISSING (CodedError, lazy import: errors.py imports packs.py)."""
    from .errors import CodedError  # noqa: PLC0415

    spec = spec_of(tool)
    if state == "python":
        msg = "Falta Python 3.12: corré scripts\\windows\\setup.ps1 -Update"
    else:
        msg = (
            f"El entorno aislado de {spec.name_es} no está listo ({STATE_ES.get(state, state)}). "
            "Volvé a descargar el paquete en Ajustes → Paquetes de IA o corré "
            "scripts\\windows\\setup.ps1 -Update."
        )
    return CodedError(
        "TOOL_MISSING", msg, details={"tool": tool, "state": state, "packId": spec.pack_id}
    )


def require_ready(tool: ToolId) -> dict[str, Any]:
    """status() when ready; else raise TOOL_MISSING (face/tts routers call it before a job)."""
    st = status(tool)
    if st["state"] != "ready":
        raise tool_missing_error(tool, st["state"])
    return st


# --------------------------------------------------------------------------- base pythons

_PY_CACHE: dict[str, tuple[float, tuple[str, str] | None]] = {}
_PY_CACHE_TTL = 60.0
_VERSION_CODE = "import sys; print('.'.join(map(str, sys.version_info[:3])))"
_EXE_CODE = "import sys; print(sys.executable)"


def clear_caches() -> None:
    _PY_CACHE.clear()


def _run_capture(argv: list[str], timeout: float = 20.0) -> str | None:
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = [ln.strip() for ln in (out.stdout or "").splitlines() if ln.strip()]
    return lines[-1] if out.returncode == 0 and lines else None


def probe_python(exe: str) -> str | None:
    """'3.12.10' for a working interpreter, else None."""
    return _run_capture([exe, "-c", _VERSION_CODE])


def _py_launcher(version: str) -> str | None:
    if not IS_WINDOWS or shutil.which("py") is None:
        return None
    return _run_capture(["py", f"-{version}", "-c", _EXE_CODE])


def _runtimes_python(version: str) -> str | None:
    try:
        data = json.loads(RUNTIMES_JSON.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    entry = data.get(f"python{version.replace('.', '')}") if isinstance(data, dict) else None
    path = entry.get("path") if isinstance(entry, dict) else None
    return str(path) if path else None


def _windows_locations(version: str) -> list[str]:
    tag = version.replace(".", "")
    out = []
    for base, sub in ((os.environ.get("LOCALAPPDATA"), f"Programs\\Python\\Python{tag}"),
                      (os.environ.get("PROGRAMFILES"), f"Python{tag}")):  # fmt: skip
        if base:
            out.append(str(Path(base) / sub / "python.exe"))
    return out


def python_candidates(version: str, explicit: str = "") -> list[str]:
    """Where a base interpreter of `version` may be, in order (explicit .env value first)."""
    out: list[str] = []
    if explicit:
        return [explicit]  # FACEFUSION_BASE_PYTHON wins (and is the only one tried)
    rt = _runtimes_python(version)
    if rt:
        out.append(rt)
    launcher = _py_launcher(version)
    if launcher:
        out.append(launcher)
    which = shutil.which(f"python{version}")
    if which:
        out.append(which)
    if IS_WINDOWS:
        out.extend(_windows_locations(version))
    return list(dict.fromkeys(out))


def find_base_python(tool: ToolId, *, fresh: bool = False) -> tuple[str, str] | None:
    """(interpreter, version) of the base Python the tool venv is created with, or None.

    Chatterbox: the workers' own interpreter (Python 3.11.9 of Studio). FaceFusion: Python 3.12
    from FACEFUSION_BASE_PYTHON, tools/runtimes.json (setup.ps1), ``py -3.12``, ``python3.12`` or
    the default install folders. Cached 60 s (GET /packs asks often)."""
    spec = spec_of(tool)
    if spec.python == "3.11":
        return sys.executable, ".".join(map(str, sys.version_info[:3]))
    explicit = tool_settings().facefusion_base_python.strip()
    key = f"{tool}|{explicit}"
    now = time.monotonic()
    hit = _PY_CACHE.get(key)
    if hit and not fresh and now - hit[0] < _PY_CACHE_TTL:
        return hit[1]
    found: tuple[str, str] | None = None
    for exe in python_candidates(spec.python, explicit):
        if not exe or (os.path.isabs(exe) and not Path(exe).is_file()):
            continue
        ver = probe_python(exe)
        if ver and (ver == spec.python or ver.startswith(spec.python + ".")):
            found = (exe, ver)
            break
    _PY_CACHE[key] = (now, found)
    return found


# ------------------------------------------------------------------------------------ stamp


@dataclass
class Stamp:
    hash: str = ""
    profile: str = ""
    variant: str | None = None
    source: str | None = None
    python: str | None = None
    providers: list[str] | None = None
    checked: str | None = None

    def render(self) -> str:
        lines = [f"{self.hash} {self.profile}"]
        if self.variant:
            lines.append(f"variant {self.variant}")
        if self.source:
            lines.append(f"source {self.source}")
        if self.python:
            lines.append(f"python {self.python}")
        if self.providers:
            lines.append(f"providers {','.join(self.providers)}")
        if self.checked:
            lines.append(f"checked {self.checked}")
        return "\n".join(lines) + "\n"


def read_stamp(venv: Path) -> Stamp | None:
    try:
        text = (venv / STAMP).read_text("utf-8")
    except OSError:
        return None
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return None
    head = lines[0].split()
    st = Stamp(hash=head[0], profile=head[1] if len(head) > 1 else "")
    for ln in lines[1:]:
        key, _, value = ln.partition(" ")
        value = value.strip()
        if key == "variant":
            st.variant = value or None
        elif key == "source":
            st.source = value or None
        elif key == "python":
            st.python = value or None
        elif key == "providers":
            st.providers = [p for p in value.split(",") if p] or None
        elif key == "checked":
            st.checked = value or None
    return st


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


# ----------------------------------------------------------------------------------- status


def status(tool: ToolId, *, use_cuda: bool | None = None) -> dict[str, Any]:
    """{id, state, python, dir, version, variant?, providers?, profile?, pack_id} (filesystem only
    plus a cached base-Python probe: cheap enough for every GET /packs)."""
    spec = spec_of(tool)
    profile = profile_of(use_cuda_setting() if use_cuda is None else use_cuda)
    lock = read_lock(tool)
    base: dict[str, Any] = {
        "id": tool,
        "pack_id": spec.pack_id,
        "dir": str(venv_dir(tool)),
        "python": None,
        "version": _lock_version(tool, lock, None),
        "app_dir": str(app_dir(tool)),
    }
    override = override_python(tool)
    if override:
        return {**base, "state": "ready", "python": override, "dir": None, "override": True}
    venv = venv_dir(tool)
    py = venv_python(venv)
    if not py.is_file():
        state: ToolState = "missing"
        if spec.python == "3.12" and find_base_python(tool) is None:
            state = "python"
        return {**base, "state": state}
    stamp = read_stamp(venv)
    if (venv / BROKEN).is_file():
        state = "broken"
    elif stamp is None or stamp.profile != profile or stamp.hash != recipe_hash(tool, profile):
        state = "stale"
    elif tool == "facefusion" and not (app_dir(tool) / "facefusion.py").is_file():
        state = "stale"  # venv fine but the FaceFusion code is gone (app/ deleted)
    else:
        state = "ready"
    out = {**base, "state": state, "python": str(py)}
    if stamp is not None:
        out.update(
            profile=stamp.profile or None,
            variant=stamp.variant,
            source=stamp.source,
            python_version=stamp.python,
            providers=stamp.providers,
            checked=stamp.checked,
            version=_lock_version(tool, lock, stamp),
        )
    broken = venv / BROKEN
    if broken.is_file():
        with contextlib.suppress(OSError):
            out["error"] = broken.read_text("utf-8").strip()[:500]
    return out


def _lock_version(tool: ToolId, lock: Mapping[str, Any], stamp: Stamp | None) -> str | None:
    if tool == "facefusion":
        return str(lock.get("version")) if lock.get("version") else None
    if stamp is not None and stamp.variant == "v2":
        return str(lock.get("fallback_pypi") or CHATTERBOX_PYPI_FALLBACK).split("==")[-1]
    sha = str(lock.get("chatterbox_sha") or "")
    return f"git {sha[:7]}" if sha else None


def status_summary(tool: ToolId) -> dict[str, str]:
    """{id, state} -> Pack.tool_status / PackSchema.tool."""
    return {"id": tool, "state": str(status(tool)["state"])}


def status_rows(tool: ToolId) -> list[dict[str, Any]]:
    """Rows for Pack.extra_status (GET /packs files): Python 3.12 (FaceFusion) + the venv."""
    spec = spec_of(tool)
    st = status(tool)
    rows: list[dict[str, Any]] = []
    if spec.python == "3.12" and not st.get("override"):
        rows.append(
            {"name": "Python 3.12 (herramientas)", "size": 0, "present": st["state"] != "python"}
        )
    use_cuda = use_cuda_setting()
    size = spec.venv_size[0] if use_cuda else spec.venv_size[1]
    what = {"facefusion": "onnxruntime-gpu" if use_cuda else "onnxruntime"}.get(tool, "torch 2.6")
    rows.append(
        {
            "name": f"venv:tools/{tool}/.venv (Python {spec.python}, {what})",
            "size": size,
            "present": st["state"] == "ready",
        }
    )
    return rows


def pack_hooks(tool: ToolId) -> dict[str, Any]:
    """Pack(...) keyword arguments for a pack that needs this tool venv (M1/M2 may use it):
    post_install_env (ensure), extra_status (status_rows) and tool_status (status_summary)."""

    def post_install_env(_root: Path, say: LineFn) -> None:
        ensure(tool, use_cuda=use_cuda_setting(), on_line=say)

    return {
        "post_install_env": post_install_env,
        "extra_status": lambda _root: status_rows(tool),
        "tool_status": lambda: status_summary(tool),
    }


# ------------------------------------------------------------------------------- licences


def licence_mirror_path() -> Path:
    return storage_root() / LICENCE_MIRROR_REL


def read_licence_mirror() -> dict[str, Any] | None:
    """storage/consent/licences.json ({accepted: {id: {text_version, accepted_at}}}), written by
    the api on every accept/revoke. None when it does not exist or cannot be read."""
    try:
        data = json.loads(licence_mirror_path().read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def licence_accepted(licence_id: str) -> bool:
    """The licence is in the mirror with the CURRENT text version and not revoked."""
    data = read_licence_mirror() or {}
    accepted = data.get("accepted")
    entry = accepted.get(licence_id) if isinstance(accepted, dict) else None
    if not isinstance(entry, dict) or entry.get("revoked_at"):
        return False
    want = LICENCE_TEXT_VERSIONS.get(licence_id)
    return bool(want) and entry.get("text_version") == want


def licence_status() -> dict[str, Any]:
    """{readable, path, licences: {id: {accepted, text_version, accepted_at}}} for doctor/cli."""
    data = read_licence_mirror()
    accepted = (data or {}).get("accepted")
    rows: dict[str, Any] = {}
    for lid, version in LICENCE_TEXT_VERSIONS.items():
        entry = accepted.get(lid) if isinstance(accepted, dict) else None
        entry = entry if isinstance(entry, dict) else {}
        rows[lid] = {
            "accepted": licence_accepted(lid),
            "text_version": entry.get("text_version"),
            "current_version": version,
            "accepted_at": entry.get("accepted_at"),
        }
    path = licence_mirror_path()
    return {
        "path": str(path),
        "exists": path.is_file(),
        "readable": data is not None,
        "licences": rows,
    }


# ------------------------------------------------------------------------------ environment

_SECRET_EXACT = {
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "HUGGINGFACE_TOKEN",
    "HF_API_TOKEN",
}
_SECRET_RE = re.compile(r"(?i)(_API_KEY|_APIKEY|_TOKEN|_SECRET|_SECRET_KEY|_PASSWORD|_ACCESS_KEY)$")
# Python variables of the workers venv that must not leak into another interpreter.
_PY_LEAKS = (
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "__PYVENV_LAUNCHER__",
)


def is_secret_var(name: str) -> bool:
    return name.upper() in _SECRET_EXACT or bool(_SECRET_RE.search(name))


def scrubbed_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """Copy of the environment without tokens/API keys or the workers' Python variables (pip and
    every tool process get this)."""
    src = os.environ if base is None else base
    env = {k: v for k, v in src.items() if not is_secret_var(k)}
    for key in _PY_LEAKS:
        env.pop(key, None)
    return env


def _ffmpeg_dirs() -> list[str]:
    st = tool_settings()
    out: list[str] = []
    for exe in (st.ffmpeg_path, st.ffprobe_path, shutil.which("ffmpeg") or ""):
        if exe and Path(exe).is_file():
            out.append(str(Path(exe).resolve().parent))
    return list(dict.fromkeys(out))


def tool_env(tool: ToolId, base: Mapping[str, str] | None = None) -> dict[str, str]:
    """Environment of a tool process (launch.py applies the same rules again inside the venv)."""
    spec = spec_of(tool)
    env = scrubbed_env(base)
    root = models_root()
    env.update(
        {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONNOUSERSITE": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "DO_NOT_TRACK": "1",
            "GRADIO_ANALYTICS_ENABLED": "False",
            "HF_HOME": str(root / tool / ".hf"),
            "STUDIO_TOOL": tool,
            "STUDIO_MODELS_DIR": str(root),
        }
    )
    if spec.omp_single_thread:
        env["OMP_NUM_THREADS"] = "1"
    dirs = _ffmpeg_dirs()  # FaceFusion's pre_check needs ffmpeg/ffprobe on PATH
    if dirs:
        env["PATH"] = os.pathsep.join([*dirs, env.get("PATH", "")]).rstrip(os.pathsep)
    return env


def wants_preload(tool: ToolId) -> bool:
    """--preload-ort: FaceFusion venv built for CUDA (onnxruntime-gpu in a plain venv needs
    ``preload_dlls``). Not for interpreter overrides (tests/e2e) unless
    STUDIO_TOOL_PRELOAD_ORT=1."""
    spec = spec_of(tool)
    if not spec.preload_ort:
        return False
    if override_python(tool):
        return os.environ.get("STUDIO_TOOL_PRELOAD_ORT") == "1"
    stamp = read_stamp(venv_dir(tool))
    return bool(stamp and stamp.profile == "cuda")


def interpreter(tool: ToolId) -> str:
    return override_python(tool) or str(venv_python(venv_dir(tool)))


def command(tool: ToolId, script: str, args: list[str]) -> tuple[list[str], dict[str, str], Path]:
    """(argv, env, cwd) to run ``script`` of the tool through tools/launch.py inside its venv.

    ``script`` is relative to the tool cwd (``facefusion.py``, ``studio_tts_server.py``) or
    ``-c`` followed by code in ``args``. Every path goes as its own argv element (spaces/accents
    safe); spawn with ``subprocess.Popen(argv, env=env, cwd=cwd, **popen_kwargs())``."""
    spec = spec_of(tool)
    cwd = app_dir(tool)
    argv = [interpreter(tool), str(LAUNCHER), "--tool", spec.id, "--chdir", str(cwd)]
    if wants_preload(tool):
        argv.append("--preload-ort")
    argv += ["--", str(script), *(str(a) for a in args)]
    return argv, tool_env(tool), cwd


# ------------------------------------------------------------------------- process control


def popen_kwargs() -> dict[str, Any]:
    """Own process group so cancel can kill the whole tree (FaceFusion spawns ffmpeg)."""
    if IS_WINDOWS:
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)}
    return {"start_new_session": True}


def kill_tree_command(pid: int) -> list[str]:
    """Windows: taskkill /T /F /PID <pid> (argv, no shell)."""
    return ["taskkill", "/T", "/F", "/PID", str(int(pid))]


def kill_tree(proc: subprocess.Popen[Any] | int, *, timeout: float = 10.0) -> None:
    """Kill a tool process and its children (cancel, GPU budget unload, idle shutdown)."""
    pid = proc if isinstance(proc, int) else proc.pid
    if IS_WINDOWS:
        try:
            subprocess.run(  # noqa: S603 - fixed argv
                kill_tree_command(pid), capture_output=True, timeout=timeout, check=False
            )
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("taskkill %s failed: %s", pid, exc)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)
    if not isinstance(proc, int):
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log.warning("tool process %s did not exit after kill", pid)


def spawn(
    tool: ToolId,
    script: str,
    args: list[str],
    *,
    stdin: Any = None,
    stdout: Any = subprocess.PIPE,
    stderr: Any = subprocess.PIPE,
    text: bool = True,
) -> subprocess.Popen[Any]:
    """Popen of command(...) with UTF-8 pipes and its own process group (see kill_tree)."""
    argv, env, cwd = command(tool, script, args)
    kw: dict[str, Any] = {"encoding": "utf-8", "errors": "replace"} if text else {}
    return subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        argv,
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        cwd=str(cwd),
        env=env,
        text=text,
        **kw,
        **popen_kwargs(),
    )


# ---------------------------------------------------------------------------------- runner


def default_runner(
    cmd: list[str],
    on_line: LineFn,
    *,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> int:
    shown = " ".join(Path(c).name if i == 0 else c for i, c in enumerate(cmd))
    on_line("> " + shown[:400])
    proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(cwd) if cwd else None,
        env=dict(env) if env is not None else scrubbed_env(),
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line.rstrip("\n"))
    return proc.wait()


def _pip(py: Path, *args: str) -> list[str]:
    return [str(py), "-m", "pip", *args]


def _pip_install(py: Path, *args: str) -> list[str]:
    return _pip(py, "install", "--disable-pip-version-check", "--progress-bar", "off", *args)


class _Ctx:
    """One ensure run: runner + log + scrubbed env for pip."""

    def __init__(self, runner: Runner, say: LineFn) -> None:
        self.runner = runner
        self.say = say
        self.env = scrubbed_env()
        self.lines: list[str] = []

    def run(
        self, cmd: list[str], *, env: Mapping[str, str] | None = None, cwd: Path | None = None
    ) -> int:
        self.lines = []

        def collect(line: str) -> None:
            self.lines.append(line)
            self.say(line)

        return int(self.runner(cmd, collect, env=dict(env or self.env), cwd=cwd))

    def must(self, cmd: list[str], what: str, **kw: Any) -> None:
        code = self.run(cmd, **kw)
        if code != 0:
            raise ToolError(f"{what} falló (código {code})")

    def last_json(self) -> dict[str, Any] | None:
        for line in reversed(self.lines):
            text = line.strip()
            if text.startswith("{"):
                try:
                    data = json.loads(text)
                except ValueError:
                    continue
                if isinstance(data, dict):
                    return data
        return None


# ---------------------------------------------------------------------------------- ensure


def ensure(
    tool: ToolId,
    *,
    use_cuda: bool,
    on_line: LineFn | None = None,
    runner: Runner | None = None,
    force: bool = False,
    client: Any = None,
    git_available: Callable[[], bool] | None = None,
) -> str:
    """Create/update the tool venv. Returns 'omitido' (already ready) or 'ejecutado'.

    stale (requirements/lock/profile changed, interrupted install) or broken -> the venv is
    deleted and created again. Raises TOOL_MISSING (state python) without a Python 3.12 for
    FaceFusion, ToolError when a step fails (the venv stays without stamp -> 'stale')."""
    spec = spec_of(tool)
    say = on_line or (lambda _line: None)
    ctx = _Ctx(runner or default_runner, say)
    profile = profile_of(use_cuda)
    override = override_python(tool)
    if override:
        say(f"{spec.python_env}={override}: no se crea el entorno de {spec.name_es}")
        return "omitido"
    st = status(tool, use_cuda=use_cuda)
    if st["state"] == "ready" and not force:
        say(f"entorno de {spec.name_es} listo: {venv_dir(tool)}")
        return "omitido"
    if not recipe_present(tool, profile):
        raise ToolError(
            f"Falta la receta de {spec.name_es} ({spec.lock.name} / requirements) en tools/{tool}: "
            "actualizá Studio (git pull o el ZIP nuevo)"
        )
    req = spec.requirements[profile]
    assert_single_ort(req)
    base = find_base_python(tool, fresh=True)
    if base is None:
        raise tool_missing_error(tool, "python")
    base_exe, base_version = base
    venv = venv_dir(tool)
    if venv.exists() and (force or st["state"] in ("stale", "broken")):
        say(f"entorno de {spec.name_es} {STATE_ES.get(st['state'], st['state'])}: se recrea")
        _rmtree_venv(venv)
    say(f"creando el entorno aislado de {spec.name_es} (Python {base_version}) en {venv}")
    ctx.must([base_exe, "-m", "venv", str(venv)], f"python -m venv tools/{tool}/.venv")
    py = venv_python(venv)
    (venv / BROKEN).unlink(missing_ok=True)
    lock = read_lock(tool)
    if tool == "facefusion":
        stamp = _ensure_facefusion(ctx, py, req, lock, use_cuda, client)
    else:
        stamp = _ensure_chatterbox(ctx, py, req, lock, use_cuda, git_available or _git_on_path)
    stamp.hash = recipe_hash(tool, profile)
    stamp.profile = profile
    stamp.python = base_version
    stamp.checked = _now_iso()
    (venv / STAMP).write_text(stamp.render(), "utf-8")
    variant = f", {stamp.variant}" if stamp.variant else ""
    say(f"entorno de {spec.name_es} listo ({profile}{variant})")
    return "ejecutado"


def _git_on_path() -> bool:
    return shutil.which("git") is not None


def _rmtree_venv(venv: Path) -> None:
    shutil.rmtree(venv, ignore_errors=True)
    if venv.exists():
        raise ToolError(f"No se pudo borrar {venv}: cerrá Studio y reintentá")


def _run_check(
    ctx: _Ctx, tool: ToolId, py: Path, extra: list[str], *, preload: bool
) -> dict[str, Any]:
    """The spec check through launch.py (same environment as a real run); writes BROKEN on error."""
    spec = spec_of(tool)
    cwd = app_dir(tool)
    argv = [str(py), str(LAUNCHER), "--tool", tool, "--chdir", str(cwd)]
    if preload:
        argv.append("--preload-ort")
    argv += ["--", *spec.check, *extra]
    code = ctx.run(argv, env=tool_env(tool), cwd=cwd)
    data = ctx.last_json()
    if code != 0 or data is None:
        tail = " | ".join(ln.strip() for ln in ctx.lines[-6:] if ln.strip())[-400:]
        msg = f"La prueba del entorno de {spec.name_es} falló (código {code}): {tail}"
        with contextlib.suppress(OSError):
            (venv_dir(tool) / BROKEN).write_text(msg + "\n", "utf-8")
        raise ToolError(msg)
    return data


# ------------------------------------------------------------------------------- facefusion


def _ensure_facefusion(
    ctx: _Ctx, py: Path, req: Path, lock: dict[str, Any], use_cuda: bool, client: Any
) -> Stamp:
    ctx.must(_pip_install(py, "-U", "pip"), "pip install -U pip")
    commit = str(lock.get("commit") or "")
    fetch_facefusion_app(lock, on_line=ctx.say, client=client)
    # install.py would do the same with the `pip` of PATH: never run it (fuentes-sprint4 §1.2).
    ctx.must(_pip(py, "uninstall", "-y", *ORT_FLAVOURS), "pip uninstall onnxruntime*")
    ctx.must(_pip_install(py, "-r", str(req)), f"pip install -r {req.name}")
    target = models_root() / "facefusion"
    link_dir(app_dir("facefusion") / ".assets" / "models", target)
    ctx.say(f"modelos de FaceFusion: {target}")
    nsfw = target / "nsfw_2.onnx"
    extra = [str(nsfw), profile_of(use_cuda)] if nsfw.is_file() else []
    data = _run_check(ctx, "facefusion", py, extra, preload=use_cuda)
    dists = [str(d) for d in data.get("dists") or []]
    if len(dists) > 1:
        raise ToolError("Quedaron dos onnxruntime en el entorno de FaceFusion: " + ", ".join(dists))
    available = [str(p) for p in data.get("available") or []]
    session = data.get("session")
    providers = [str(session)] if session else available
    cuda_ok = "CUDAExecutionProvider" in available and session in (None, "CUDAExecutionProvider")
    if use_cuda and not cuda_ok:
        ctx.say(
            "AVISO onnx_cuda_unavailable: onnxruntime no cargó CUDA en tools\\facefusion (driver "
            "NVIDIA 570+, VC++ x64). Corré scripts\\windows\\doctor.ps1; mientras tanto usa CPU."
        )
    return Stamp(source=commit or None, providers=providers or None)


def fetch_facefusion_app(
    lock: Mapping[str, Any], *, on_line: LineFn | None = None, client: Any = None
) -> Path:
    """FaceFusion code at the pinned commit -> tools/facefusion/app/ (git-ignored).

    Downloads the GitHub archive zip of the lock (sha256 from the lock when it is pinned; else
    the first download records it in tools/facefusion/.studio-source.json and later downloads
    must match), extracts it safely and leaves ``app/.studio-commit``."""
    from .downloads import Expected  # noqa: PLC0415
    from .models_manifest import fetch_file  # noqa: PLC0415

    say = on_line or (lambda _line: None)
    commit = str(lock.get("commit") or "")
    url = str(lock.get("source_url") or "")
    if not commit or not url.startswith("https://"):
        raise ToolError("facefusion.lock.json sin commit / source_url")
    app = app_dir("facefusion")
    marker = app / APP_COMMIT
    if marker.is_file() and marker.read_text("utf-8").strip() == commit:
        say(f"código de FaceFusion {lock.get('version')} ya presente ({commit[:12]})")
        return app
    root = tool_dir("facefusion")
    record_path = root / SOURCE_RECORD
    try:
        record = json.loads(record_path.read_text("utf-8"))
    except (OSError, ValueError):
        record = {}
    pinned = str(lock.get("source_sha256") or "") or None
    recorded = record.get("sha256") if record.get("commit") == commit else None
    zip_path = root / ".downloads" / f"facefusion-{commit}.zip"
    say(f"bajando FaceFusion {lock.get('version')} ({commit[:12]}) de GitHub")
    res = fetch_file(url, zip_path, Expected(sha256=pinned or recorded), client=client)
    if pinned is None and recorded is None:
        record = {"commit": commit, "url": url, "sha256": res.sha256, "size": res.size,
                  "date": _now_iso(), "verified": "first-download"}  # fmt: skip
        record_path.write_text(json.dumps(record, indent=2) + "\n", "utf-8")
        say(f"sha256 del zip registrado (primera descarga): {res.sha256}")
    extract_app(zip_path, app)
    marker.write_text(commit + "\n", "utf-8")
    return app


def extract_app(zip_path: Path, app: Path) -> None:
    """Extract a GitHub archive (one top folder) into `app` (refuses absolute / '..' members)."""
    tmp = app.with_name(app.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            p = Path(member)
            if p.is_absolute() or ".." in p.parts or member.startswith(("/", "\\")):
                raise ToolError(f"Zip con rutas inseguras: {member}")
        zf.extractall(tmp)
    entries = list(tmp.iterdir())
    top = entries[0] if len(entries) == 1 and entries[0].is_dir() else tmp
    if app.exists():
        _unlink_dir_link(app / ".assets" / "models")
        shutil.rmtree(app, ignore_errors=True)
    shutil.move(str(top), str(app))
    shutil.rmtree(tmp, ignore_errors=True)


def _is_dir_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    isjunction = getattr(os.path, "isjunction", None)  # Python 3.12+
    return bool(isjunction and isjunction(path))


def _unlink_dir_link(path: Path) -> None:
    """Remove a directory symlink/junction WITHOUT touching its target."""
    if not _is_dir_link(path):
        return
    try:
        path.unlink()
    except (IsADirectoryError, PermissionError, OSError):
        os.rmdir(path)  # a junction on Windows


def link_dir(link: Path, target: Path) -> None:
    """``link`` -> ``target`` as a junction on Windows (no admin needed) / symlink elsewhere.

    A real folder already at ``link`` (models FaceFusion downloaded by itself) is moved into
    ``target`` first, so nothing is lost and nothing is downloaded twice."""
    target.mkdir(parents=True, exist_ok=True)
    if _is_dir_link(link):
        try:
            if link.resolve() == target.resolve():
                return
        except OSError:
            pass
        _unlink_dir_link(link)
    elif link.is_dir():
        for item in link.iterdir():
            dest = target / item.name
            if not dest.exists():
                shutil.move(str(item), str(dest))
        shutil.rmtree(link, ignore_errors=True)
    link.parent.mkdir(parents=True, exist_ok=True)
    if IS_WINDOWS:
        import _winapi  # noqa: PLC0415 - Windows only

        _winapi.CreateJunction(str(target), str(link))  # type: ignore[attr-defined]
    else:
        link.symlink_to(target, target_is_directory=True)


# ------------------------------------------------------------------------------- chatterbox


def _ensure_chatterbox(
    ctx: _Ctx,
    py: Path,
    req: Path,
    lock: dict[str, Any],
    use_cuda: bool,
    git_available: Callable[[], bool],
) -> Stamp:
    # PerTh 1.0.1 imports pkg_resources: setuptools 82 removed it (fuentes-sprint4 §2.1).
    ctx.must(_pip_install(py, "-U", "pip", "wheel", "setuptools<82"), "pip install -U pip wheel")
    torch_v = str(lock.get("torch") or "2.6.0")
    torch_args = [f"torch=={torch_v}", f"torchaudio=={torch_v}"]
    if use_cuda:  # PyPI's Windows torch is CPU only: the CUDA build comes from the cu124 index
        torch_args += ["--index-url", str(lock.get("torch_cuda_index") or PYPI_TORCH_CUDA_INDEX)]
    ctx.must(_pip_install(py, *torch_args), f"pip install torch=={torch_v}")
    variant = "v3"
    source = str(lock.get("chatterbox_sha") or "")
    if not git_available():
        ctx.say("Git no está en el PATH: se instala Chatterbox V2 desde PyPI")
        variant = "v2"
    else:
        perth = f"resemble-perth @ git+{lock.get('perth_git')}@{lock.get('perth_sha')}"
        code = ctx.run(_pip_install(py, perth))
        if code == 0:
            ctx.must(_pip_install(py, "-r", str(req)), f"pip install -r {req.name}")
            cb = f"chatterbox-tts @ git+{lock.get('chatterbox_git')}@{lock.get('chatterbox_sha')}"
            code = ctx.run(_pip_install(py, "--no-deps", cb))
        if code != 0:
            ctx.say("No se pudo instalar Chatterbox desde GitHub: se usa V2 de PyPI")
            variant = "v2"
    if variant == "v2":
        fallback = str(lock.get("fallback_pypi") or CHATTERBOX_PYPI_FALLBACK)
        ctx.must(_pip_install(py, fallback, "setuptools<82"), f"pip install {fallback}")
        ctx.say("AVISO chatterbox_v2_fallback: Chatterbox multilingüe V2 (PyPI 0.1.7)")
        source = f"pypi:{fallback}"
    data = _run_check(ctx, "chatterbox", py, [], preload=False)
    providers = ["cuda" if data.get("cuda") else "cpu"]
    if use_cuda and not data.get("cuda"):
        ctx.say("AVISO torch_cpu_build: torch del entorno de Chatterbox no ve CUDA (usa CPU)")
    if data.get("torch"):
        ctx.say(f"torch {data.get('torch')} (CUDA {data.get('cuda_version') or 'no'})")
    return Stamp(variant=variant, source=source or None, providers=providers)


# ----------------------------------------------------------------------------------- verify


def verify(
    tool: ToolId,
    *,
    on_line: LineFn | None = None,
    runner: Runner | None = None,
    record: bool = True,
) -> dict[str, Any]:
    """Run the check of a ready venv now (doctor: 'proveedor CUDA real'). ``record`` writes the
    providers into the stamp, or the BROKEN marker on failure; doctor passes record=False."""
    st = status(tool)
    if st["state"] not in ("ready", "broken") or st.get("override"):
        return {**st, "verified": False}
    venv = venv_dir(tool)
    ctx = _Ctx(runner or default_runner, on_line or (lambda _line: None))
    stamp = read_stamp(venv) or Stamp()
    use_cuda = stamp.profile == "cuda"
    extra: list[str] = []
    if tool == "facefusion":
        nsfw = models_root() / "facefusion" / "nsfw_2.onnx"
        extra = [str(nsfw), stamp.profile or "cpu"] if nsfw.is_file() else []
    py = venv_python(venv)
    broken_before = (venv / BROKEN).is_file()
    try:
        data = _run_check(ctx, tool, py, extra, preload=use_cuda and tool == "facefusion")
    except ToolError as exc:
        if not record and not broken_before:
            (venv / BROKEN).unlink(missing_ok=True)
        return {**st, "verified": False, "state": "broken", "error": str(exc)}
    if tool == "facefusion":
        providers = (
            [str(data["session"])] if data.get("session") else list(data.get("available") or [])
        )
    else:
        providers = ["cuda" if data.get("cuda") else "cpu"]
    if record:
        (venv / BROKEN).unlink(missing_ok=True)
        stamp.providers = providers or None
        stamp.checked = _now_iso()
        (venv / STAMP).write_text(stamp.render(), "utf-8")
    return {**status(tool), "verified": True, "check": data, "providers": providers}


# -------------------------------------------------------------------------- idle shutdown


class IdleTimer:
    """Calls ``on_idle`` once ``idle_s`` passed since the last ``touch()`` (RVC / Chatterbox
    release the GPU budget after a while without use). ``idle_s`` <= 0 disables it."""

    def __init__(self, idle_s: float, on_idle: Callable[[], None]) -> None:
        self.idle_s = idle_s
        self.on_idle = on_idle
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self.last_used = time.monotonic()

    def touch(self) -> None:
        with self._lock:
            self.last_used = time.monotonic()
            if self._timer is not None:
                self._timer.cancel()
            if self.idle_s <= 0:
                self._timer = None
                return
            self._timer = threading.Timer(self.idle_s, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        with self._lock:
            if time.monotonic() - self.last_used < self.idle_s * 0.99:
                return
            self._timer = None
        try:
            self.on_idle()
        except Exception as exc:  # never kill the timer thread loudly
            log.warning("idle release failed: %s", exc)

    def cancel(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = None
