from fastapi import APIRouter

from ..config import get_settings
from ..media import ffmpeg_version, find_ffmpeg
from ..packs import summary as packs_summary
from ..rvc_engine import base_status, discover_models
from ..schemas import Capabilities, FfmpegInfo, ModelsInfo, WorkerHealth
from ..services import gpu_budget
from ..stt.engine import installed_models
from ..system_probe import ctranslate2_cuda_devices, module_installed, package_versions, torch_info
from ..tts.piper_catalog import installed_voice_ids

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=WorkerHealth,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def health() -> WorkerHealth:
    settings = get_settings()
    root = settings.models_root
    torch = torch_info()
    piper_voices = installed_voice_ids(root)
    rvc_models = [m.id for m in discover_models(root)]
    gpu_seen = bool(torch.cuda_available) or (settings.use_cuda and ctranslate2_cuda_devices() > 0)
    ffmpeg = find_ffmpeg()
    return WorkerHealth(
        cuda=settings.use_cuda and gpu_seen,
        capabilities=Capabilities(
            whisper=module_installed("faster_whisper"),
            piper=module_installed("piper") and bool(piper_voices),
            rvc=module_installed("infer_rvc_python") and bool(rvc_models),
        ),
        use_cuda=settings.use_cuda,
        torch=torch,
        ffmpeg=FfmpegInfo(
            found=ffmpeg is not None,
            path=ffmpeg,
            version=ffmpeg_version(ffmpeg) if ffmpeg else None,
        ),
        models=ModelsInfo(
            whisper=installed_models(root),
            piper=piper_voices,
            rvc=rvc_models,
            rvc_base=base_status(root),
        ),
        packages=package_versions(),
        gpu=gpu_budget().status(),
        packs=packs_summary(root),
    )
