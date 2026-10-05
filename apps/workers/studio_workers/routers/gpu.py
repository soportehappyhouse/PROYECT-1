from typing import Any

from fastapi import APIRouter

from ..config import get_settings
from ..services import gpu_budget, matte_engine
from ..system_probe import onnxruntime_info

router = APIRouter(prefix="/gpu", tags=["gpu"])


def onnx_provider(status: dict[str, Any]) -> str | None:
    """ "cuda" | "cpu" (BiRefNet's onnxruntime provider) or None when onnxruntime is missing."""
    info = onnxruntime_info(
        get_settings().use_cuda, bool(status.get("cuda")), matte_engine().birefnet_device()
    )
    if not info["installed"]:
        return None
    return "cuda" if info["provider"] == "CUDAExecutionProvider" else "cpu"


def _with_onnx(status: dict[str, Any]) -> dict[str, Any]:
    # additive: the web CPU pre-warning of «Quitar fondo» on images (BiRefNet) reads it
    return {**status, "onnx_provider": onnx_provider(status)}


@router.get("/status")
def status() -> dict[str, Any]:
    """{cuda, gpu_name, vram_total_mb, vram_free_mb, resident_model, mode, sysmem_fallback,
    onnx_provider}."""
    return _with_onnx(gpu_budget().status())


@router.post("/release")
def release() -> dict[str, Any]:
    """Unload the resident model (frees VRAM for NVENC, a game, another app...)."""
    released = gpu_budget().release()
    return {"released": released, **_with_onnx(gpu_budget().status())}
