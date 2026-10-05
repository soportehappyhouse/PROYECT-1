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
