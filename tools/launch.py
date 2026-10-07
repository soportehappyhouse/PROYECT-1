"""Generic launcher of Studio's isolated tools (FaceFusion, Chatterbox).

Runs INSIDE the tool venv (``tools/<id>/.venv``), started by the workers through
``studio_workers.toolvenv.command()`` with an argv array (never a shell):

    <venv python> tools/launch.py --tool facefusion|chatterbox [--chdir <dir>] [--preload-ort]
                  -- <script> <args...>
    <venv python> tools/launch.py --tool facefusion --preload-ort -- -c "<code>" <args...>

Before the tool code is imported it:

1. cleans the environment with an ALLOWLIST (system paths, temp, locale, ``PYTHON*``,
   ``CUDA*`` / ``NVIDIA*``, ``STUDIO_*``, …; never ``HF_TOKEN`` or any ``*_API_KEY`` /
   ``*_TOKEN`` / ``*_SECRET`` variable: Studio never uses tokens, only public repos),
   ``HF_HUB_OFFLINE=1`` (models are downloaded by Studio's packs, the tool never fetches
   anything), ``HF_HOME=<models>/<tool>/.hf``, ``PYTHONUTF8=1``, ``PYTHONIOENCODING=utf-8`` and
   ``OMP_NUM_THREADS=1`` for FaceFusion;
2. with ``--preload-ort``: puts every ``site-packages/nvidia/*/bin`` folder on the DLL search path
   (``os.add_dll_directory`` + ``PATH``; ORT does not preload curand/nvrtc on Windows) and calls
   ``onnxruntime.preload_dlls()`` (cuBLAS, cuFFT, cudart, cuDNN 9 of the nvidia-*-cu12 wheels):
   without conda nobody else puts them on the path (docs/trabajo/fuentes-sprint4.md §1.3);
3. ``os.chdir(<dir>)`` (FaceFusion resolves .assets/.jobs/.caches against the cwd),
   ``sys.path.insert(0, <dir>)``, ``sys.argv = [script, *args]`` and ``runpy.run_path``.

A startup failure prints ONE JSON line on stdout,
``{"event": "error", "code": "LAUNCH_FAILED", "message": ...}``, and exits with code 2. Errors of
the tool itself keep their own exit code and traceback.

Standard library only: this file must run on Python 3.11 (Chatterbox) and 3.12 (FaceFusion).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import runpy
import sys
import sysconfig
from collections.abc import MutableMapping
from pathlib import Path

TOOLS = ("facefusion", "chatterbox")
LAUNCH_FAILED = "LAUNCH_FAILED"
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent

# Same allowlist as studio_workers/toolvenv.py (ENV_ALLOW_*; test_launch checks they match).
ENV_ALLOW_EXACT = frozenset(
    {
        "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
        "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
        "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
        "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
        "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "USERNAME", "USER", "LOGNAME",
        "LANG", "LANGUAGE", "TZ", "TERM", "LD_LIBRARY_PATH",
        "HF_HUB_OFFLINE", "HF_HOME", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY",
        "DO_NOT_TRACK", "GRADIO_ANALYTICS_ENABLED", "TOKENIZERS_PARALLELISM",
    }
)  # fmt: skip
ENV_ALLOW_PREFIXES = (
    "LC_", "PYTHON", "CUDA", "NVIDIA", "CUDNN", "STUDIO_", "OMP_", "MKL_", "KMP_",
    "TORCH_", "PYTORCH_", "ORT_",
)  # fmt: skip
_SECRET_EXACT = {
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "HUGGINGFACE_TOKEN",
    "HF_API_TOKEN",
}
_SECRET_RE = re.compile(r"(?i)(_API_KEY|_APIKEY|_TOKEN|_SECRET|_SECRET_KEY|_PASSWORD|_ACCESS_KEY)$")
_PY_LEAKS = ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "CONDA_PREFIX")
# Kept alive on purpose: os.add_dll_directory() removes the folder when its handle is collected.
_DLL_HANDLES: list[object] = []


class LaunchError(Exception):
    """Startup problem -> one LAUNCH_FAILED JSON line + exit 2."""


def is_secret(name: str) -> bool:
    return name.upper() in _SECRET_EXACT or bool(_SECRET_RE.search(name))


def is_allowed(name: str) -> bool:
    up = name.upper()
    if is_secret(name) or up in _PY_LEAKS:
        return False
    return up in ENV_ALLOW_EXACT or up.startswith(ENV_ALLOW_PREFIXES)


def scrub_env(env: MutableMapping[str, str]) -> list[str]:
    """Keep only allowlisted variables in `env` (in place); returns the removed names (never
    values)."""
    removed = [k for k in list(env) if not is_allowed(k)]
    for k in removed:
        env.pop(k, None)
    return removed


def models_dir(env: MutableMapping[str, str]) -> Path:
    raw = env.get("STUDIO_MODELS_DIR", "").strip()
    if raw:
        return Path(raw)
    return REPO_ROOT / "models"


def apply_env(tool: str, env: MutableMapping[str, str]) -> None:
    """Offline + UTF-8 environment of every tool process (also what its children inherit)."""
    scrub_env(env)
    for key in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "CONDA_PREFIX"):
        env.pop(key, None)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONNOUSERSITE"] = "1"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    env["DO_NOT_TRACK"] = "1"
    env["GRADIO_ANALYTICS_ENABLED"] = "False"
    env.setdefault("HF_HOME", str(models_dir(env) / tool / ".hf"))
    env["STUDIO_TOOL"] = tool
    if tool == "facefusion":
        env["OMP_NUM_THREADS"] = "1"  # facefusion.py sets it too, but ORT is imported before


def site_dirs() -> list[Path]:
    paths = sysconfig.get_paths()
    out: list[Path] = []
    for key in ("purelib", "platlib"):
        p = paths.get(key)
        if p and Path(p) not in out:
            out.append(Path(p))
    return out


def nvidia_dll_dirs(sites: list[Path] | None = None, *, windows: bool | None = None) -> list[Path]:
    """site-packages/nvidia/*/bin (Windows DLLs) or */lib (Linux .so) of nvidia-*-cu12 wheels."""
    win = os.name == "nt" if windows is None else windows
    sub = "bin" if win else "lib"
    out: list[Path] = []
    for site in sites if sites is not None else site_dirs():
        root = site / "nvidia"
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            cand = d / sub
            if cand.is_dir() and cand not in out:
                out.append(cand)
    return out


def preload_ort(env: MutableMapping[str, str], warn) -> list[str]:  # type: ignore[no-untyped-def]
    """DLL folders + onnxruntime.preload_dlls(). ImportError -> LaunchError; a preload failure is
    only a warning (the tool reports CUDA problems itself, or runs on CPU)."""
    dirs = nvidia_dll_dirs()
    for d in dirs:
        add = getattr(os, "add_dll_directory", None)
        if add is not None:
            try:
                _DLL_HANDLES.append(add(str(d)))
            except OSError as exc:
                warn(f"add_dll_directory({d}) failed: {exc}")
        env["PATH"] = str(d) + os.pathsep + env.get("PATH", "")
    try:
        import onnxruntime as ort  # noqa: PLC0415
    except Exception as exc:  # broken wheel, missing DLL of the CPU part, ...
        raise LaunchError(
            f"onnxruntime no se puede importar en el entorno de la herramienta: {exc}"
        ) from exc
    pre = getattr(ort, "preload_dlls", None)
    if pre is None:
        warn("onnxruntime has no preload_dlls() (< 1.21): CUDA DLLs come from PATH only")
    else:
        try:
            pre()
        except Exception as exc:
            warn(f"onnxruntime.preload_dlls() failed: {exc}")
    return [str(d) for d in dirs]


def parse_args(argv: list[str]) -> tuple[str, Path | None, bool, str, list[str]]:
    """(tool, chdir, preload, script, args). Everything after '--' belongs to the script."""
    if "--" not in argv:
        raise LaunchError(
            "uso: launch.py --tool <id> [--chdir <dir>] [--preload-ort] -- <script> …"
        )
    cut = argv.index("--")
    own, rest = argv[:cut], argv[cut + 1 :]
    tool = ""
    chdir: Path | None = None
    preload = False
    i = 0
    while i < len(own):
        arg = own[i]
        if arg == "--tool" and i + 1 < len(own):
            tool = own[i + 1]
            i += 2
        elif arg == "--chdir" and i + 1 < len(own):
            chdir = Path(own[i + 1])
            i += 2
        elif arg == "--preload-ort":
            preload = True
            i += 1
        else:
            raise LaunchError(f"argumento desconocido: {arg}")
    if tool not in TOOLS:
        raise LaunchError(f"--tool debe ser {' | '.join(TOOLS)} (recibido: {tool or 'nada'})")
    if not rest:
        raise LaunchError("falta el script después de '--'")
    return tool, chdir, preload, rest[0], rest[1:]


def _emit_error(message: str) -> int:
    line = json.dumps({"event": "error", "code": LAUNCH_FAILED, "message": message})
    with contextlib.suppress(Exception):  # closed stdout: nothing else to do
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    return 2


def _warn(message: str) -> None:
    sys.stderr.write(f"[launch] {message}\n")
    sys.stderr.flush()


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            with contextlib.suppress(ValueError, OSError):
                reconfigure(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    _utf8_stdio()
    # The launcher's own folder (tools/, sys.path[0]) must not shadow packages named like the
    # tools (tools/facefusion vs FaceFusion's `facefusion` package).
    sys.path[:] = [p for p in sys.path if not p or Path(p).resolve() != HERE]
    try:
        tool, chdir, preload, script, script_args = parse_args(args)
        apply_env(tool, os.environ)
        cwd = (chdir or Path.cwd()).resolve()
        if not cwd.is_dir():
            raise LaunchError(f"no existe la carpeta de trabajo: {cwd}")
        target: Path | None = None
        if script != "-c":
            target = Path(script)
            if not target.is_absolute():
                target = cwd / target
            if not target.is_file():
                raise LaunchError(f"no existe el script: {target}")
        if preload:
            preload_ort(os.environ, _warn)
        os.chdir(cwd)
        sys.path.insert(0, str(cwd))
    except LaunchError as exc:
        return _emit_error(str(exc))
    except Exception as exc:  # anything else before the tool runs is still a launch failure
        return _emit_error(f"{type(exc).__name__}: {exc}")
    if target is None:
        if not script_args:
            return _emit_error("-c necesita el código")
        sys.argv = ["-c", *script_args[1:]]
        code = compile(script_args[0], "<launch -c>", "exec")
        exec(code, {"__name__": "__main__", "__builtins__": __builtins__})  # noqa: S102
        return 0
    sys.argv = [str(target), *script_args]
    runpy.run_path(str(target), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
