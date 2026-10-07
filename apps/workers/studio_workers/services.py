"""Process-wide singletons (engines keep loaded models in memory). Tests call reset()."""

from __future__ import annotations

from functools import lru_cache

from .agent.ollama_client import OllamaClient, OllamaError
from .audio.stems import StemsEngine
from .config import get_settings
from .denoise import DenoiseEngine
from .gpu import GpuBudget
from .rvc_engine import RvcEngine
from .stt.engine import WhisperEngine
from .tasks import TaskQueue
from .tts.providers import TtsProvider, build_providers
from .vision.matte import MatteEngine
from .vision.sam import SamManager


def release_ollama() -> list[str]:
    """GpuBudget hook: unload the models Ollama keeps in VRAM (keep_alive 0) so Whisper/vision fit
    on a 6 GB card. Best-effort; [] when Ollama is not running or OLLAMA_URL is refused."""
    client = ollama_client()
    try:
        client.check_url()
    except OllamaError:
        return []
    return client.unload_loaded_sync()


def gpu_reserve_mb() -> int:
    """GPU_RESERVE_MB (.env; empty = 800): VRAM left for Windows, the browser and NVENC before a
    model counts as fitting. Lower it on a 6 GB card to keep Chatterbox / FaceFusion on the GPU
    (audit fix 14); invalid values fall back to the default."""
    from .gpu import DEFAULT_RESERVE_MB  # noqa: PLC0415
    from .toolvenv import tool_settings  # noqa: PLC0415

    try:
        raw = str(tool_settings().gpu_reserve_mb or "").strip()
        value = int(float(raw)) if raw else DEFAULT_RESERVE_MB
    except (ValueError, Exception):  # noqa: BLE001 - unreadable .env: default
        return DEFAULT_RESERVE_MB
    return value if 0 <= value <= 8000 else DEFAULT_RESERVE_MB


@lru_cache
def gpu_budget() -> GpuBudget:
    return GpuBudget(
        use_cuda=get_settings().use_cuda,
        external_release=release_ollama,
        reserve_mb=gpu_reserve_mb(),
    )


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
def agent_queue() -> TaskQueue:
    """Agent evaluations (one at a time: they share Ollama and the GPU)."""
    return TaskQueue("agent")


# Sprint 3b stems (audio/stems.py): engine + its own one-at-a-time queue (GET /audio/tasks/{id}).
@lru_cache
def stems_engine() -> StemsEngine:
    return StemsEngine(get_settings(), budget=gpu_budget())


@lru_cache
def audio_queue() -> TaskQueue:
    """Audio separation jobs: one at a time (one GPU)."""
    return TaskQueue("audio")


@lru_cache
def ollama_client() -> OllamaClient:
    settings = get_settings()
    return OllamaClient(
        settings.ollama_url,
        timeout=settings.agent_timeout_sec,
        allow_remote=settings.agent_allow_remote_ollama,
    )


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
    agent_queue.cache_clear()
    stems_engine.cache_clear()
    audio_queue.cache_clear()
    # tests may monkeypatch ollama_client with a plain factory (fake Ollama transport)
    getattr(ollama_client, "cache_clear", lambda: None)()


# BEGIN sprint4:M2 — Chatterbox TTS client (one bridge subprocess per workers process)
import threading as _threading_m2  # noqa: E402

_chatterbox_clients: list = []
_chatterbox_lock = _threading_m2.Lock()


def chatterbox_client():  # type: ignore[no-untyped-def]  # -> tts.chatterbox.ChatterboxClient
    """The single ChatterboxClient (starts its tool subprocess lazily; GpuBudget "chatterbox")."""
    from .tts.chatterbox import ChatterboxClient  # noqa: PLC0415

    with _chatterbox_lock:
        if not _chatterbox_clients:
            _chatterbox_clients.append(ChatterboxClient(get_settings(), budget=gpu_budget()))
        return _chatterbox_clients[0]


def _stop_chatterbox() -> None:
    with _chatterbox_lock:
        clients = list(_chatterbox_clients)
        _chatterbox_clients.clear()
    for client in clients:
        client.stop()


_reset_before_sprint4_m2 = reset


def reset() -> None:  # noqa: F811 - extends reset() above (terminates the Chatterbox subprocess)
    _stop_chatterbox()
    _reset_before_sprint4_m2()


# END sprint4:M2


# BEGIN sprint4:M1 — face swap engine (FaceFusion subprocess) + its own one-at-a-time queue
@lru_cache
def face_engine():  # type: ignore[no-untyped-def]  # -> face.engine.FaceEngine
    from .face.engine import FaceEngine  # noqa: PLC0415

    return FaceEngine(get_settings(), budget=gpu_budget())


@lru_cache
def face_queue() -> TaskQueue:
    """Face previews / swaps: one at a time (one GPU, FaceFusion uses ~3.5 GB)."""
    return TaskQueue("face")


_reset_before_sprint4_m1 = reset


def reset() -> None:  # noqa: F811 - extends reset() above (face engine + queue)
    # tests may monkeypatch them with plain factories
    getattr(face_engine, "cache_clear", lambda: None)()
    getattr(face_queue, "cache_clear", lambda: None)()
    _reset_before_sprint4_m1()


# END sprint4:M1
