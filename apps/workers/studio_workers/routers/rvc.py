from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError, require_module
from ..gpu import GPU_FALLBACK_CPU
from ..progress import registry
from ..rvc_engine import BUDGET_KEY, ConvertParams, discover_models
from ..schemas import RvcConvertRequest, RvcModel, RvcResult
from ..services import rvc_engine

router = APIRouter(prefix="/rvc", tags=["rvc"])


@router.get(
    "/models",
    response_model=list[RvcModel],
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def list_models() -> list[RvcModel]:
    """models/rvc/<name>/{*.pth,*.index} (folders starting with "_" are ignored)."""
    return discover_models(get_settings().models_root)


@router.post(
    "/convert",
    response_model=RvcResult,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def convert(req: RvcConvertRequest) -> RvcResult:
    """Sync. CPU works but is slow (~audio duration or more); CUDA is optional."""
    settings = get_settings()
    model = next((m for m in discover_models(settings.models_root) if m.id == req.model_id), None)
    if model is None:
        raise NotFoundError(f"Modelo RVC no encontrado: {req.model_id} (models/rvc/<nombre>/)")
    src = settings.storage_path(req.input_path)
    if not src.is_file():
        raise NotFoundError(f"No existe el audio de entrada: {req.input_path}")
    out = settings.storage_path(req.output_path)
    if out.suffix.lower() != ".wav":
        out = out.with_suffix(".wav")
    require_module("infer_rvc_python", "infer-rvc-python==1.3.1")
    engine = rvc_engine()
    device, warnings = engine.acquire_device(req.device)
    params = ConvertParams(
        pitch_shift=req.pitch_shift,
        index_rate=req.index_rate,
        f0_method=req.f0_method,
        filter_radius=req.filter_radius,
        rms_mix_rate=req.rms_mix_rate,
        protect=req.protect,
    )
    with registry.track(req.job_id, "Convirtiendo voz (RVC)"):
        progress = lambda p, m: registry.update(req.job_id, p, m)  # noqa: E731
        try:
            path, rate, duration = engine.convert(model, src, out, params, device, progress)
        except Exception:
            if device != "cuda":
                raise
            engine.unload_device("cuda")
            warnings = [*warnings, *(engine.budget.failed(BUDGET_KEY) if engine.budget else [])]
            warnings = list(dict.fromkeys(warnings or [GPU_FALLBACK_CPU]))
            device = "cpu"
            path, rate, duration = engine.convert(model, src, out, params, device, progress)
    return RvcResult(
        path=settings.storage_relative(path),
        sample_rate=rate,
        duration_sec=round(duration, 3),
        device=device,
        warnings=warnings or None,
    )
