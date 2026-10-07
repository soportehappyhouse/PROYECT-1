"""Bridge to the isolated FaceFusion runtime (tools/facefusion, Python 3.12).

The runtime belongs to the «herramientas» module (M3): ``studio_workers/toolvenv.py`` (venv,
stamp, status, allowlisted environment) and ``tools/launch.py`` (DLL preload, clean environment,
``runpy`` of the script). There is no local fallback launcher any more (audit fix 9): if
``toolvenv`` cannot be imported the tool is reported broken and every run is ``TOOL_MISSING``,
so nothing ever starts with the workers' full environment. Tests and the e2e mocks point
``FACEFUSION_PYTHON`` / ``FACEFUSION_APP_DIR`` at a fake ``facefusion.py`` and still go through
``toolvenv.command()`` + ``tools/launch.py``.

Licence mirror: ``storage/consent/licences.json`` ({accepted: {id: {text_version, accepted_at}}}),
written only by the api when the user accepts the licence on screen (and at every api start).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

from ..config import get_settings

log = logging.getLogger("studio_workers")

TOOL = "facefusion"
PACK_ID = "faceswap"
LICENCE_MIRROR = "consent/licences.json"
VENV_ROW = "venv:tools/facefusion/.venv (Python 3.12, onnxruntime-gpu 1.24.4)"


def _toolvenv() -> ModuleType:
    """M3's toolvenv, or TOOL_MISSING (broken): never a silent fallback."""
    try:
        from .. import toolvenv  # noqa: PLC0415 - heavy module, imported on use
    except ImportError as exc:
        from ..errors import CodedError  # noqa: PLC0415 - errors imports packs (cycle)

        raise CodedError(
            "TOOL_MISSING",
            "El entorno aislado de FaceFusion no está listo (roto): falta el lanzador de "
            f"herramientas ({exc}). Corré scripts\\windows\\setup.ps1 -Update.",
            details={"tool": TOOL, "state": "broken", "packId": PACK_ID},
        ) from exc
    return toolvenv


def tool_summary() -> dict[str, str]:
    """{id, state} for GET /packs (PackSchema.tool) and the preflight (TOOL_MISSING)."""
    try:
        out = dict(_toolvenv().status_summary(TOOL))
    except Exception as exc:  # a broken status must not break GET /packs
        log.warning("toolvenv.status_summary(facefusion) failed: %s", exc)
        return {"id": TOOL, "state": "broken"}
    return {"id": TOOL, "state": str(out.get("state") or "missing")}


def tool_state() -> str:
    return tool_summary()["state"]


def tool_status_rows() -> list[dict[str, Any]]:
    """Pack.extra_status rows (the venv counts as a file of the pack)."""
    try:
        return list(_toolvenv().status_rows(TOOL))
    except Exception as exc:
        log.warning("toolvenv.status_rows(facefusion) failed: %s", exc)
    from ..packs import FACEFUSION_VENV_SIZE  # noqa: PLC0415

    return [{"name": VENV_ROW, "size": FACEFUSION_VENV_SIZE, "present": False}]


def ensure_tool(say: Callable[[str], None]) -> None:
    """Pack.post_install_env: create/update tools/facefusion/.venv (M3's toolvenv.ensure)."""
    _toolvenv().ensure(TOOL, use_cuda=bool(get_settings().use_cuda), on_line=say)


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
    """argv, env, cwd to run `script` of FaceFusion with `args` (tools/launch.py in its venv)."""
    argv, env, cwd = _toolvenv().command(TOOL, script, args)
    return list(argv), dict(env), Path(cwd)


def licence_accepted(licence_id: str) -> bool:
    """Defence in depth: the licence must be in the api's mirror (toolvenv.licence_accepted).
    Any problem reading it means «not accepted»."""
    try:
        return bool(_toolvenv().licence_accepted(licence_id))
    except Exception as exc:
        log.warning("toolvenv.licence_accepted failed: %s", exc)
        return False
