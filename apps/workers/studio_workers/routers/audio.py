from typing import Any

from fastapi import APIRouter

from ..config import get_settings
from ..schemas import DenoiseRequest
from ..services import denoise_engine
from .analyze import resolve_input

router = APIRouter(prefix="/audio", tags=["audio"])


@router.post("/denoise")
def denoise(req: DenoiseRequest) -> dict[str, Any]:
    """DeepFilterNet voice cleanup -> {path} (WAV, or MP3 by format/extension); voz-limpia."""
    settings = get_settings()
    src = resolve_input(settings, req.path)
    base = settings.storage_path(req.output_base)
    suffix = base.suffix.lower()
    fmt = req.format or (suffix.lstrip(".") if suffix in (".wav", ".mp3") else "wav")
    out = (
        base.with_suffix(f".{fmt}")
        if suffix in (".wav", ".mp3")
        else base.with_name(f"{base.name}.{fmt}")
    )
    path, device, warnings = denoise_engine().denoise(src, out)
    result: dict[str, Any] = {"path": settings.storage_relative(path), "device": device}
    if warnings:
        result["warnings"] = warnings
    return result
