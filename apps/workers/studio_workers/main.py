"""FastAPI application factory for the Studio workers service."""

from fastapi import FastAPI

from . import __version__
from .routers import health, rvc, transcribe, tts


def create_app() -> FastAPI:
    app = FastAPI(title="Studio Workers", version=__version__)
    app.include_router(health.router)
    app.include_router(transcribe.router)
    app.include_router(tts.router)
    app.include_router(rvc.router)
    return app


app = create_app()
