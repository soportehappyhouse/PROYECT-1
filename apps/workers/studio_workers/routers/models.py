from fastapi import APIRouter

from ..config import get_settings
from ..errors import require_module
from ..rvc_engine import download_base_assets
from ..schemas import DownloadedFile, ModelDownloadRequest, ModelDownloadResult
from ..stt.engine import download_model as download_whisper
from ..tts.piper_catalog import download_voice

router = APIRouter(prefix="/models", tags=["models"])


@router.post(
    "/download",
    response_model=ModelDownloadResult,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def download(req: ModelDownloadRequest) -> ModelDownloadResult:
    """Fetch a model on demand into MODELS_DIR (verified size / md5 when the catalog has it)."""
    settings = get_settings()
    root = settings.models_root
    files: list[DownloadedFile] = []

    def rel(path) -> str:  # noqa: ANN001
        return path.resolve().relative_to(root).as_posix()

    if req.kind == "piper":
        voice = req.id or settings.piper_default_voice
        for path, size, skipped in download_voice(root, voice, force=req.force):
            files.append(DownloadedFile(path=rel(path), size_bytes=size, skipped=skipped))
        return ModelDownloadResult(kind=req.kind, id=voice, files=files)
    if req.kind == "whisper":
        require_module("faster_whisper", "faster-whisper==1.2.1")
        name = req.id or settings.whisper_model
        folder = download_whisper(root, name)
        size = sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
        files.append(DownloadedFile(path=rel(folder), size_bytes=size))
        return ModelDownloadResult(kind=req.kind, id=name, files=files)
    results = download_base_assets(root, include_legacy=req.include_legacy, force=req.force)
    for path, size, skipped in results:
        files.append(DownloadedFile(path=rel(path), size_bytes=size, skipped=skipped))
    return ModelDownloadResult(kind=req.kind, id=None, files=files)
