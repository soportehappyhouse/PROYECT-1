"""Process-wide singletons (engines keep loaded models in memory). Tests call reset()."""

from __future__ import annotations

from functools import lru_cache

from .config import get_settings
from .rvc_engine import RvcEngine
from .stt.engine import WhisperEngine
from .tts.providers import TtsProvider, build_providers


@lru_cache
def whisper_engine() -> WhisperEngine:
    return WhisperEngine(get_settings())


@lru_cache
def rvc_engine() -> RvcEngine:
    return RvcEngine(get_settings())


@lru_cache
def tts_providers() -> dict[str, TtsProvider]:
    return build_providers(get_settings())


def reset() -> None:
    get_settings.cache_clear()
    whisper_engine.cache_clear()
    rvc_engine.cache_clear()
    tts_providers.cache_clear()
