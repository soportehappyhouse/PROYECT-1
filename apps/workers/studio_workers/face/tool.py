"""Bridge to the isolated FaceFusion runtime (tools/facefusion, Python 3.12).

The runtime belongs to the «herramientas» module (M3): ``studio_workers/toolvenv.py`` (venv,
stamp, status) and ``tools/launch.py`` (DLL preload, clean environment, ``runpy`` of the script).
Everything here imports it lazily; while it is not there (or in tests/e2e with
``FACEFUSION_PYTHON`` / ``FACEFUSION_APP_DIR``) a local ``_launch()`` with the same signature as
``toolvenv.command()`` runs ``<python> <app>/facefusion.py <args>`` with the same environment
rules, so switching to M3's launcher needs no change here.

Licence mirror: ``storage/consent/licences.json`` ({accepted: {id: {text_version, accepted_at}}}),
written only by the api when the user accepts the licence on screen.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import REPO_ROOT, get_settings

log = logging.getLogger("studio_workers")

TOOL = "facefusion"
PACK_ID = "faceswap"
LICENCE_MIRROR = "consent/licences.json"
VENV_ROW = "venv:tools/facefusion/.venv (Python 3.12, onnxruntime-gpu 1.24.4)"


def _toolvenv() -> Any | None:
    try:
        from .. import toolvenv  # noqa: PLC0415 - M3 module, may not exist yet
    except ImportError:
        return None
    return toolvenv


def tool_dir() -> Path:
    return REPO_ROOT / "tools" / TOOL


def override_python() -> str:
    return os.environ.get("FACEFUSION_PYTHON", "").strip()


def app_dir() -> Path:
    custom = os.environ.get("FACEFUSION_APP_DIR", "").strip()
    if custom:
        p = Path(custom)
        return (p if p.is_absolute() else REPO_ROOT / p).resolve()
    return tool_dir() / "app"


def venv_python() -> Path:
    venv = tool_dir() / ".venv"
    return venv / "Scripts" / "python.exe" if os.name == "nt" else venv / "bin" / "python"


def fallback_state() -> str:
    """{ready|broken|missing} from the filesystem only (no toolvenv): overrides first."""
    py = override_python()
    app_ok = (app_dir() / "facefusion.py").is_file()
    if py:
        return "ready" if (Path(py).is_file() or shutil.which(py)) and app_ok else "broken"
    return "ready" if venv_python().is_file() and app_ok else "missing"


def tool_summary() -> dict[str, str]:
    """{id, state} for GET /packs (PackSchema.tool) and the preflight (TOOL_MISSING)."""
    tv = _toolvenv()
    if tv is not None and hasattr(tv, "status_summary"):
        try:
            out = dict(tv.status_summary(TOOL))
            return {"id": TOOL, "state": str(out.get("state") or "missing")}
        except Exception as exc:  # a broken status must not break GET /packs
            log.warning("toolvenv.status_summary(facefusion) failed: %s", exc)
            return {"id": TOOL, "state": "broken"}
    return {"id": TOOL, "state": fallback_state()}


def tool_state() -> str:
    return tool_summary()["state"]


def tool_status_rows() -> list[dict[str, Any]]:
    """Pack.extra_status rows (the venv counts as a file of the pack)."""
    tv = _toolvenv()
    if tv is not None and hasattr(tv, "status_rows"):
        try:
            return list(tv.status_rows(TOOL))
        except Exception as exc:
            log.warning("toolvenv.status_rows(facefusion) failed: %s", exc)
    from ..packs import FACEFUSION_VENV_SIZE  # noqa: PLC0415

    return [{"name": VENV_ROW, "size": FACEFUSION_VENV_SIZE, "present": tool_state() == "ready"}]


def ensure_tool(say: Callable[[str], None]) -> None:
    """Pack.post_install_env: create/update tools/facefusion/.venv (M3's toolvenv.ensure)."""
    tv = _toolvenv()
    if tv is not None and hasattr(tv, "ensure"):
        tv.ensure(TOOL, use_cuda=bool(get_settings().use_cuda), on_line=say)
        return
    if override_python():
        say("FACEFUSION_PYTHON definido: no se crea tools/facefusion/.venv")
        return
    raise RuntimeError(
        "Falta studio_workers/toolvenv.py: no se puede crear el entorno aislado de FaceFusion "
        "(corré scripts\\windows\\setup.ps1 -Update)"
    )


def _child_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() != "HF_TOKEN"}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", OMP_NUM_THREADS="1", HF_HUB_OFFLINE="1")
    return env


def _launch(script: str, args: list[str]) -> tuple[list[str], dict[str, str], Path]:
    """Fallback of toolvenv.command(): same (argv, env, cwd), without the DLL preload."""
    app = app_dir()
    python = override_python() or str(venv_python())
    return [python, str(app / script), *args], _child_env(), app


def with_ffmpeg_path(env: dict[str, str], ffmpeg: str | None) -> dict[str, str]:
    """FaceFusion's pre_check needs ffmpeg/ffprobe on PATH: prepend Studio's ffmpeg folder."""
    if not ffmpeg:
        return env
    folder = str(Path(ffmpeg).resolve().parent)
    current = env.get("PATH") or env.get("Path") or ""
    if folder not in current.split(os.pathsep):
        key = "Path" if "Path" in env and "PATH" not in env else "PATH"
        env[key] = f"{folder}{os.pathsep}{current}" if current else folder
    return env


def command(script: str, args: list[str]) -> tuple[list[str], dict[str, str], Path]:
    """argv, env, cwd to run `script` of FaceFusion with `args` (M3 launcher when present)."""
    tv = _toolvenv()
    if tv is not None and hasattr(tv, "command"):
        argv, env, cwd = tv.command(TOOL, script, args)
        return list(argv), dict(env), Path(cwd)
    return _launch(script, args)


def mirror_accepted(licence_id: str) -> bool:
    path = get_settings().storage_root / LICENCE_MIRROR
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    accepted = data.get("accepted") if isinstance(data, dict) else None
    return isinstance(accepted, dict) and isinstance(accepted.get(licence_id), dict)


def licence_accepted(licence_id: str) -> bool:
    """Defence in depth: the licence must be in the api's mirror (toolvenv.licence_accepted)."""
    tv = _toolvenv()
    fn = getattr(tv, "licence_accepted", None) if tv is not None else None
    if fn is not None:
        try:
            return bool(fn(licence_id))
        except Exception as exc:
            log.warning("toolvenv.licence_accepted failed: %s", exc)
    return mirror_accepted(licence_id)
