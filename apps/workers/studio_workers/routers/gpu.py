from typing import Any

from fastapi import APIRouter

from ..services import gpu_budget

router = APIRouter(prefix="/gpu", tags=["gpu"])


@router.get("/status")
def status() -> dict[str, Any]:
    """{cuda, gpu_name, vram_total_mb, vram_free_mb, resident_model, mode, sysmem_fallback}."""
    return gpu_budget().status()


@router.post("/release")
def release() -> dict[str, Any]:
    """Unload the resident model (frees VRAM for NVENC, a game, another app...)."""
    released = gpu_budget().release()
    return {"released": released, **gpu_budget().status()}
