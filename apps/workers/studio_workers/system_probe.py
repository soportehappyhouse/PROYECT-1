"""Environment probing for /health: packages, torch/CUDA, ffmpeg, installed models.

Importing torch takes seconds (more on Windows), so it runs once in a background thread started
at app startup; /health returns immediately with `torch.probing=true` until it finishes.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from importlib import metadata
from importlib.util import find_spec
from pathlib import Path

from .schemas import TorchInfo

log = logging.getLogger("studio_workers")

PACKAGES = {
    "faster-whisper": "faster_whisper",
    "ctranslate2": "ctranslate2",
    "piper-tts": "piper",
    "infer-rvc-python": "infer_rvc_python",
    "torch": "torch",
    "onnxruntime": "onnxruntime",
}

_lock = threading.Lock()
_torch_info: TorchInfo | None = None
_probe_started = False


def module_installed(module: str) -> bool:
    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def package_versions() -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for dist in PACKAGES:
        try:
            out[dist] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[dist] = None
    return out


def _probe_torch() -> TorchInfo:
    if not module_installed("torch"):
        return TorchInfo(installed=False)
    try:
        import torch  # noqa: PLC0415 - heavy import on purpose

        available = bool(torch.cuda.is_available())
        return TorchInfo(
            installed=True,
            version=str(torch.__version__),
            cuda_available=available,
            cuda_version=getattr(torch.version, "cuda", None),
            device_name=torch.cuda.get_device_name(0) if available else None,
        )
    except Exception as exc:  # broken DLLs etc. must not kill /health
        log.warning("torch probe failed: %s", exc)
        return TorchInfo(installed=True, cuda_available=False, version=f"error: {exc}")


def start_background_probe() -> None:
    global _probe_started
    with _lock:
        if _probe_started:
            return
        _probe_started = True

    def run() -> None:
        global _torch_info
        info = _probe_torch()
        with _lock:
            _torch_info = info

    threading.Thread(target=run, name="torch-probe", daemon=True).start()


def torch_info() -> TorchInfo:
    with _lock:
        if _torch_info is not None:
            return _torch_info
        started = _probe_started
    if not module_installed("torch"):
        return TorchInfo(installed=False)
    return TorchInfo(installed=True, probing=started)


def ctranslate2_cuda_devices() -> int:
    if not module_installed("ctranslate2"):
        return 0
    try:
        import ctranslate2  # noqa: PLC0415

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def register_cuda_dll_dirs() -> list[str]:
    """Windows: expose CUDA/cuDNN DLLs bundled in torch\\lib or nvidia-*-cu12 wheels.

    ctranslate2 (faster-whisper) needs cublas64_12.dll + cudnn*64_9.dll. The torch cu128 wheel
    ships them in torch\\lib; nvidia-cublas-cu12 / nvidia-cudnn-cu12 put them in nvidia\\*\\bin.
    """
    if sys.platform != "win32":
        return []
    added: list[str] = []
    candidates: list[Path] = []
    for entry in sys.path:
        base = Path(entry)
        candidates.append(base / "torch" / "lib")
        nvidia = base / "nvidia"
        if nvidia.is_dir():
            candidates.extend(p / "bin" for p in nvidia.iterdir())
    for folder in candidates:
        if folder.is_dir():
            try:
                os.add_dll_directory(str(folder))  # type: ignore[attr-defined]
                os.environ["PATH"] = f"{folder}{os.pathsep}{os.environ.get('PATH', '')}"
                added.append(str(folder))
            except OSError:
                continue
    return added
