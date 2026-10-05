"""Start the workers with test doubles for what cannot run in CI / a GPU-less sandbox.

    apps/workers/.venv/bin/python scripts/e2e/workers-with-mocks.py

- DeepFilterNet (pack voz-limpia): the backend is replaced by FFmpeg `afftdn` and the pack is
  reported as installed, so audio.denoise runs end to end (real api + real workers routes).
- STUDIO_MOCK_GPU_FALLBACK=1: denoise answers `warnings: ["gpu_fallback_cpu"]` (what the GPU
  manager returns when there is no free VRAM), to check the api/web propagation.

Everything else (scenes, silences, packs, gpu, perf) is the real code. Never used by setup/start.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "workers"))

import uvicorn
from studio_workers import packs, services
from studio_workers.__main__ import uvicorn_level
from studio_workers.config import get_settings
from studio_workers.gpu import GPU_FALLBACK_CPU
from studio_workers.main import app


def afftdn(src: Path, dst: Path, _device: str) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-af",
            "afftdn=nf=-25",
            str(dst),
        ],
        check=True,
    )


_status = packs.pack_status


def pack_status(pack, root, catalog=None):  # type: ignore[no-untyped-def]
    row = _status(pack, root, catalog)
    if pack.id == "voz-limpia":
        row.update(installed=True, partial=False)
    return row


packs.pack_status = pack_status
engine = services.denoise_engine()
engine._backend = afftdn
if os.environ.get("STUDIO_MOCK_GPU_FALLBACK") == "1":
    _denoise = engine.denoise

    def denoise(src: Path, out: Path):  # type: ignore[no-untyped-def]
        path, device, warnings = _denoise(src, out)
        return path, device, [*warnings, GPU_FALLBACK_CPU]

    engine.denoise = denoise  # type: ignore[method-assign]

settings = get_settings()
uvicorn.run(
    app,
    host=settings.workers_host,
    port=settings.workers_port,
    log_level=uvicorn_level("info"),
)
