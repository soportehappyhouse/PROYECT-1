"""Domain exceptions -> HTTP responses ({detail, code}) registered in main.create_app()."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .agent.ollama_client import (
    OllamaError,
    OllamaRemoteRefusedError,
    OllamaTimeoutError,
    OllamaUnavailableError,
)
from .downloads import DownloadError
from .media import FfmpegNotFoundError
from .packs import PackRequiredError
from .tts.providers import ProviderNotConfiguredError, VoiceNotInstalledError
from .vision.gpl import GplProcessError
from .vision.sam import SessionBusyError


class NotFoundError(LookupError):
    pass


class DependencyMissingError(RuntimeError):
    """An optional Python package (faster-whisper / piper-tts / infer-rvc-python) is missing."""


# Sprint 4 error codes (docs/trabajo/sprint4-contratos.md «Códigos de error nuevos»): same HTTP
# status as SPRINT4_ERRORS in packages/shared/src/api.ts. Messages go in Spanish in `detail`.
SPRINT4_ERROR_STATUS: dict[str, int] = {
    "CONSENT_REQUIRED": 403,
    "LICENCE_REQUIRED": 403,
    "HUMAN_ONLY": 403,
    "TOOL_MISSING": 409,
    "TOOL_FAILED": 502,
    "TEXT_OUTDATED": 409,
    "VOICE_SAMPLE_MISSING": 409,
    "CONTENT_BLOCKED": 422,
    "NO_FACE": 422,
    "RVC_MODEL_INCOMPATIBLE": 422,
    "CLIP_TOO_LONG": 400,
    "VOICE_SAMPLE_INVALID": 400,
    "PERSON_NOT_FOUND": 404,
}


class CodedError(RuntimeError):
    """Error with an explicit API code -> ``{detail, code}`` (+ ``details`` when given).

    ``status`` defaults to SPRINT4_ERROR_STATUS[code] (else 400). Background tasks can read
    ``.code`` / ``.details`` to fill their ``{status, error, code}`` answer. Modules imported by
    this file (tts, vision, packs...) must import it lazily inside the function (as vision/sam.py
    does with NotFoundError) to avoid an import cycle.
    """

    def __init__(
        self, code: str, detail: str, status: int | None = None, details: dict | None = None
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.status = status if status is not None else SPRINT4_ERROR_STATUS.get(code, 400)
        self.details = details

    def payload(self) -> dict:
        out: dict = {"detail": str(self), "code": self.code}
        if self.details is not None:
            out["details"] = self.details
        return out


_MAP: list[tuple[type[Exception], int, str]] = [
    (NotFoundError, 404, "NOT_FOUND"),
    (FileNotFoundError, 404, "NOT_FOUND"),
    (VoiceNotInstalledError, 409, "VOICE_NOT_INSTALLED"),
    (ProviderNotConfiguredError, 409, "PROVIDER_NOT_CONFIGURED"),
    (DependencyMissingError, 503, "DEPENDENCY_MISSING"),
    (FfmpegNotFoundError, 503, "FFMPEG_NOT_FOUND"),
    (SessionBusyError, 409, "SESSION_BUSY"),
    (GplProcessError, 500, "GPL_PROCESS_FAILED"),
    (DownloadError, 502, "DOWNLOAD_FAILED"),
    (OllamaRemoteRefusedError, 403, "OLLAMA_REMOTE_REFUSED"),
    (OllamaUnavailableError, 503, "OLLAMA_UNAVAILABLE"),
    (OllamaTimeoutError, 504, "OLLAMA_TIMEOUT"),
    (OllamaError, 502, "OLLAMA_ERROR"),
    (ValueError, 400, "BAD_REQUEST"),
]


def register_error_handlers(app: FastAPI) -> None:
    def pack_required(_req: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, PackRequiredError)
        return JSONResponse(status_code=409, content=exc.payload())

    app.add_exception_handler(PackRequiredError, pack_required)

    def coded(_req: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, CodedError)
        return JSONResponse(status_code=exc.status, content=exc.payload())

    app.add_exception_handler(CodedError, coded)
    for exc_type, status, code in _MAP:

        def handler(_req: Request, exc: Exception, status: int = status, code: str = code):
            return JSONResponse(status_code=status, content={"detail": str(exc), "code": code})

        app.add_exception_handler(exc_type, handler)


def require_module(module: str, package: str) -> None:
    from .system_probe import module_installed  # noqa: PLC0415

    if not module_installed(module):
        raise DependencyMissingError(
            f"Falta el paquete Python '{package}'. Ejecuta scripts\\windows\\setup.ps1 "
            f"o pip install {package} en apps/workers/.venv"
        )
