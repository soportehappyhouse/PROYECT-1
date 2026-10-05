"""faster-whisper engine: lazy model loading, small LRU cache, CUDA -> CPU fallback."""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings
from ..schemas import SubtitleSegment, SubtitleWord, Transcript

log = logging.getLogger("studio_workers")

# Real names from faster_whisper/utils.py (docs/trabajo/fuentes-audio.md §3.1).
WHISPER_MODELS = (
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v1",
    "large-v2",
    "large-v3",
    "large",
    "large-v3-turbo",
    "turbo",
    "distil-large-v2",
    "distil-large-v3",
    "distil-large-v3.5",
    "distil-medium.en",
    "distil-small.en",
)
MAX_CACHED_MODELS = 2

ProgressFn = Callable[[float, str], None]
ModelFactory = Callable[[str, str, str, str], Any]


def whisper_dir(models_root: Path) -> Path:
    return models_root / "whisper"


def installed_models(models_root: Path) -> list[str]:
    """Models present in the HF cache layout used by WhisperModel(download_root=...)."""
    root = whisper_dir(models_root)
    if not root.is_dir():
        return []
    found = []
    for repo in sorted(root.glob("models--*--faster-whisper-*")):
        name = repo.name.split("--faster-whisper-", 1)[1]
        if any(repo.glob("snapshots/*/model.bin")):
            found.append(name)
    return found


def _default_factory(name: str, device: str, compute_type: str, download_root: str) -> Any:
    from faster_whisper import WhisperModel  # noqa: PLC0415 - optional heavy dependency

    return WhisperModel(name, device=device, compute_type=compute_type, download_root=download_root)


def download_model(models_root: Path, name: str) -> Path:
    if name not in WHISPER_MODELS:
        raise ValueError(f"Modelo Whisper desconocido: {name}")
    from faster_whisper import download_model as fw_download  # noqa: PLC0415

    root = whisper_dir(models_root)
    root.mkdir(parents=True, exist_ok=True)
    return Path(fw_download(name, cache_dir=str(root)))


class WhisperEngine:
    def __init__(self, settings: Settings, factory: ModelFactory | None = None) -> None:
        self.settings = settings
        self._factory = factory or _default_factory
        self._models: OrderedDict[tuple[str, str, str], Any] = OrderedDict()
        self._lock = threading.Lock()

    def _compute_type(self, device: str, requested: str | None) -> str:
        wanted = (requested or self.settings.whisper_compute_type or "auto").lower()
        if wanted != "auto":
            return wanted
        return "float16" if device == "cuda" else "int8"

    def _get(self, name: str, device: str, compute_type: str) -> Any:
        key = (name, device, compute_type)
        with self._lock:
            if key in self._models:
                self._models.move_to_end(key)
                return self._models[key]
            root = whisper_dir(self.settings.models_root)
            root.mkdir(parents=True, exist_ok=True)
            log.info("loading whisper %s on %s (%s)", name, device, compute_type)
            model = self._factory(name, device, compute_type, str(root))
            self._models[key] = model
            while len(self._models) > MAX_CACHED_MODELS:
                self._models.popitem(last=False)
            return model

    def transcribe(
        self,
        audio: Path,
        *,
        model: str | None = None,
        language: str = "es",
        word_timestamps: bool = True,
        vad: bool = True,
        beam_size: int = 5,
        compute_type: str | None = None,
        on_progress: ProgressFn | None = None,
    ) -> Transcript:
        name = model or self.settings.whisper_model
        if name not in WHISPER_MODELS:
            raise ValueError(f"Modelo Whisper desconocido: {name}")
        devices = ["cuda", "cpu"] if self.settings.use_cuda else ["cpu"]
        last_error: Exception | None = None
        for device in devices:
            ctype = self._compute_type(device, compute_type)
            if device == "cpu" and ctype in ("float16", "int8_float16"):
                ctype = "int8"  # fp16 is not supported on CPU
            try:
                instance = self._get(name, device, ctype)
                return self._run(
                    instance,
                    audio,
                    name,
                    device,
                    language,
                    word_timestamps,
                    vad,
                    beam_size,
                    on_progress,
                )
            except Exception as exc:  # CUDA/cuDNN DLL problems surface here on Windows
                if device == "cuda":
                    log.warning("whisper on CUDA failed (%s); falling back to CPU int8", exc)
                    if on_progress:
                        on_progress(0.0, "CUDA no disponible, usando CPU")
                    last_error = exc
                    continue
                raise
        raise RuntimeError(f"No se pudo transcribir: {last_error}")

    def _run(
        self,
        instance: Any,
        audio: Path,
        name: str,
        device: str,
        language: str,
        word_timestamps: bool,
        vad: bool,
        beam_size: int,
        on_progress: ProgressFn | None,
    ) -> Transcript:
        lang = None if language in ("", "auto") else language
        kwargs: dict[str, Any] = {
            "language": lang,
            "beam_size": beam_size,
            "word_timestamps": word_timestamps,
            "vad_filter": vad,
            "condition_on_previous_text": False,
        }
        if vad:
            kwargs["vad_parameters"] = {"min_silence_duration_ms": 500}
        segments_iter, info = instance.transcribe(str(audio), **kwargs)
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        segments: list[SubtitleSegment] = []
        for seg in segments_iter:  # generator: decoding happens while iterating
            words = None
            if word_timestamps and getattr(seg, "words", None):
                words = [
                    SubtitleWord(
                        start=max(0.0, float(w.start)),
                        end=max(0.0, float(w.end)),
                        word=str(w.word).strip(),
                        probability=_clamp01(getattr(w, "probability", None)),
                    )
                    for w in seg.words
                    if str(w.word).strip()
                ]
            segments.append(
                SubtitleSegment(
                    start=max(0.0, float(seg.start)),
                    end=max(0.0, float(seg.end)),
                    text=str(seg.text).strip(),
                    words=words,
                )
            )
            if on_progress and duration > 0:
                on_progress(min(0.99, float(seg.end) / duration), "Transcribiendo")
        return Transcript(
            language=str(getattr(info, "language", None) or lang or "und"),
            duration_sec=duration,
            segments=segments,
            model=name,
            device=device,
        )


def _clamp01(value: float | None) -> float | None:
    if value is None:
        return None
    return max(0.0, min(1.0, float(value)))
