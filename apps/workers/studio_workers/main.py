"""FastAPI application factory for the Studio workers service."""

import logging
import os
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from . import __version__
from .config import get_settings
from .errors import register_error_handlers
from .packs import write_registry
from .routers import (
    agent,
    analyze,
    audio,
    gpu,
    health,
    jobs,
    models,
    packs,
    perf,
    rvc,
    transcribe,
    tts,
    vision,
)
from .system_probe import register_cuda_dll_dirs, start_background_probe

log = logging.getLogger("studio_workers")


def prepare_environment() -> None:
    """PATH tweaks needed by third-party libs that spawn `ffmpeg` / load CUDA DLLs by name."""
    settings = get_settings()
    if settings.ffmpeg_path:
        ffmpeg_dir = str(Path(settings.ffmpeg_path).parent)
        if ffmpeg_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = f"{ffmpeg_dir}{os.pathsep}{os.environ.get('PATH', '')}"
    if settings.use_cuda:
        added = register_cuda_dll_dirs()
        if added:
            log.info("CUDA DLL directories: %s", added)
    for sub in ("whisper", "piper", "rvc"):
        (settings.models_root / sub).mkdir(parents=True, exist_ok=True)
    # SAM sessions live in memory: frames left by a previous run (crash, restart) can never be
    # used again. (tmp/matte is kept: a re-submitted RVM job resumes from its finished chunks.)
    shutil.rmtree(settings.storage_root / "tmp" / "sam", ignore_errors=True)
    try:
        write_registry(settings.models_root)  # models/packs.json (static registry)
    except OSError as exc:
        log.warning("could not write models/packs.json: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    prepare_environment()
    start_background_probe()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Studio Workers", version=__version__, lifespan=lifespan)
    register_error_handlers(app)
    app.include_router(health.router)
    app.include_router(jobs.router)
    app.include_router(transcribe.router)
    app.include_router(tts.router)
    app.include_router(rvc.router)
    app.include_router(models.router)
    app.include_router(gpu.router)
    app.include_router(packs.router)
    app.include_router(analyze.router)
    app.include_router(audio.router)
    app.include_router(perf.router)
    app.include_router(vision.router)
    app.include_router(agent.router)
    return app


app = create_app()
