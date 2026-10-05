"""Process-wide singletons (engines keep loaded models in memory). Tests call reset()."""

from __future__ import annotations

from functools import lru_cache

from .config import get_settings
from .denoise import DenoiseEngine
from .gpu import GpuBudget
from .rvc_engine import RvcEngine
from .stt.engine import WhisperEngine
from .tasks import TaskQueue
from .tts.providers import TtsProvider, build_providers
from .vision.matte import MatteEngine
from .vision.sam import SamManager


@lru_cache
def gpu_budget() -> GpuBudget:
    return GpuBudget(use_cuda=get_settings().use_cuda)


@lru_cache
def whisper_engine() -> WhisperEngine:
    return WhisperEngine(get_settings(), budget=gpu_budget())


@lru_cache
def rvc_engine() -> RvcEngine:
    return RvcEngine(get_settings(), budget=gpu_budget())


@lru_cache
def denoise_engine() -> DenoiseEngine:
    return DenoiseEngine(get_settings(), budget=gpu_budget())


@lru_cache
def pack_queue() -> TaskQueue:
    """Pack downloads: one at a time."""
    return TaskQueue("packs")


@lru_cache
def perf_queue() -> TaskQueue:
    return TaskQueue("perf")


@lru_cache
def matte_engine() -> MatteEngine:
    return MatteEngine(get_settings(), budget=gpu_budget())


@lru_cache
def sam_manager() -> SamManager:
    return SamManager(get_settings(), budget=gpu_budget())


@lru_cache
def vision_queue() -> TaskQueue:
    """Vision jobs (matte, propagate, track, reframe): one at a time (one GPU)."""
    return TaskQueue("vision")


@lru_cache
def tts_providers() -> dict[str, TtsProvider]:
    return build_providers(get_settings())


def reset() -> None:
    get_settings.cache_clear()
    gpu_budget.cache_clear()
    whisper_engine.cache_clear()
    rvc_engine.cache_clear()
    denoise_engine.cache_clear()
    tts_providers.cache_clear()
    pack_queue.cache_clear()
    perf_queue.cache_clear()
    matte_engine.cache_clear()
    sam_manager.cache_clear()
    vision_queue.cache_clear()
