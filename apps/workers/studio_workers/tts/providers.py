"""TTS provider interface + implementations.

- piper: local, always available once a voice is installed (models/piper).
- chatterbox (sprint 4, tts/chatterbox.py): local Chatterbox Multilingual in an isolated tool
  venv (pack tts-chatterbox), with zero-shot cloning from a consented reference sample.
- elevenlabs / openai: optional, enabled ONLY when the key exists in .env. Keys are read from the
  environment by pydantic-settings and never returned by any endpoint.
"""

from __future__ import annotations

import threading
import wave
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..config import Settings
from ..media import to_wav, wav_info
from ..schemas import TtsProviderId, TtsProviderInfo, TtsVoice
from . import piper_catalog


@dataclass
class SynthesisParams:
    speed: float = 1.0
    noise_scale: float | None = None
    noise_w: float | None = None
    sentence_silence: float = 0.0
    speaker_id: int | None = None
    volume: float = 1.0


class ProviderNotConfiguredError(RuntimeError):
    pass


class VoiceNotInstalledError(RuntimeError):
    pass


class TtsProvider(ABC):
    id: TtsProviderId
    name: str

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @abstractmethod
    def enabled(self) -> bool: ...

    def info(self) -> TtsProviderInfo:
        enabled = self.enabled()
        status = "local" if self.id == "piper" else ("configurado" if enabled else "no configurado")
        return TtsProviderInfo(id=self.id, name=self.name, enabled=enabled, status=status)

    @abstractmethod
    def voices(self) -> list[TtsVoice]: ...

    @abstractmethod
    def synthesize(self, text: str, voice: str, params: SynthesisParams, out_wav: Path) -> None:
        """Write a PCM WAV to out_wav."""


# ------------------------------------------------------------------------------------- piper


class PiperProvider(TtsProvider):
    id = "piper"
    name = "Piper (local)"
    _cache: dict[str, object] = {}
    _lock = threading.Lock()

    def enabled(self) -> bool:
        from ..system_probe import module_installed  # noqa: PLC0415

        return module_installed("piper")

    def voices(self) -> list[TtsVoice]:
        root = self.settings.models_root
        installed = set(piper_catalog.installed_voice_ids(root))
        default = self.settings.piper_default_voice
        out: list[TtsVoice] = []
        catalog = piper_catalog.cached_voices_json(root)
        for vid in sorted(installed | set(piper_catalog.CATALOG)):
            name, language, quality = piper_catalog.describe(vid, root)
            if vid in installed:
                size = piper_catalog.voice_files(root, vid)[0].stat().st_size
            else:
                size = piper_catalog.remote_size(catalog, vid)
            out.append(
                TtsVoice(
                    provider="piper",
                    id=vid,
                    name=name,
                    language=language,
                    installed=vid in installed,
                    quality=quality,
                    size_bytes=size,
                    default=vid == default,
                )
            )
        return out

    def _load(self, voice: str) -> object:
        onnx, cfg = piper_catalog.voice_files(self.settings.models_root, voice)
        if not onnx.is_file() or not cfg.is_file():
            raise VoiceNotInstalledError(
                f"Voz Piper '{voice}' no instalada; descargala con POST /models/download"
            )
        with self._lock:
            cached = self._cache.get(voice)
            if cached is None:
                from piper import PiperVoice  # noqa: PLC0415 - optional heavy dependency

                # Piper is faster than real time on CPU; GPU (onnxruntime-gpu) is not needed.
                cached = PiperVoice.load(str(onnx), config_path=str(cfg), use_cuda=False)
                self._cache[voice] = cached
            return cached

    def synthesize(self, text: str, voice: str, params: SynthesisParams, out_wav: Path) -> None:
        piper_voice = self._load(voice)  # raises VoiceNotInstalledError first
        from piper import SynthesisConfig  # noqa: PLC0415

        cfg = SynthesisConfig(
            speaker_id=params.speaker_id,
            length_scale=1.0 / params.speed if params.speed else None,
            noise_scale=params.noise_scale,
            noise_w_scale=params.noise_w,
            normalize_audio=True,
            volume=params.volume,
        )
        out_wav.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(out_wav), "wb") as wav:
            if params.sentence_silence > 0:
                _synthesize_with_silence(piper_voice, text, cfg, wav, params.sentence_silence)
            else:
                piper_voice.synthesize_wav(text, wav, syn_config=cfg)  # type: ignore[attr-defined]


def _synthesize_with_silence(
    voice: object, text: str, cfg: object, wav: wave.Wave_write, gap: float
) -> None:
    first = True
    for chunk in voice.synthesize(text, syn_config=cfg):  # type: ignore[attr-defined]
        if first:
            wav.setframerate(chunk.sample_rate)
            wav.setsampwidth(chunk.sample_width)
            wav.setnchannels(chunk.sample_channels)
            first = False
        else:
            silence = int(chunk.sample_rate * gap) * chunk.sample_width * chunk.sample_channels
            wav.writeframes(b"\x00" * silence)
        wav.writeframes(chunk.audio_int16_bytes)


# ------------------------------------------------------------------------------------- cloud


class _CloudProvider(TtsProvider):
    key_name: str

    def key(self) -> str:
        key = self.settings.secret(self.key_name)
        if not key:
            raise ProviderNotConfiguredError(f"{self.name}: no configurado (falta la key en .env)")
        return key

    def enabled(self) -> bool:
        return self.settings.secret(self.key_name) is not None

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=self.settings.http_timeout_sec, follow_redirects=True)

    def _save_and_convert(self, data: bytes, suffix: str, out_wav: Path) -> None:
        raw = out_wav.with_name(out_wav.stem + ".src" + suffix)
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(data)
        try:
            to_wav(raw, out_wav)
        finally:
            raw.unlink(missing_ok=True)


class OpenAiProvider(_CloudProvider):
    id = "openai"
    name = "OpenAI TTS"
    key_name = "openai_api_key"
    VOICES = ("alloy", "echo", "fable", "onyx", "nova", "shimmer")

    def voices(self) -> list[TtsVoice]:
        if not self.enabled():
            return []
        return [
            TtsVoice(provider="openai", id=v, name=v.capitalize(), language="multi", installed=True)
            for v in self.VOICES
        ]

    def synthesize(self, text: str, voice: str, params: SynthesisParams, out_wav: Path) -> None:
        body = {
            "model": self.settings.openai_tts_model,
            "input": text[:4096],
            "voice": voice,
            "response_format": "wav",
            "speed": max(0.25, min(4.0, params.speed)),
        }
        with self._client() as http:
            res = http.post(
                "https://api.openai.com/v1/audio/speech",
                headers={"Authorization": f"Bearer {self.key()}"},
                json=body,
            )
        if res.status_code != 200:
            raise RuntimeError(f"OpenAI TTS respondio {res.status_code}: {res.text[:300]}")
        self._save_and_convert(res.content, ".wav", out_wav)


class ElevenLabsProvider(_CloudProvider):
    id = "elevenlabs"
    name = "ElevenLabs"
    key_name = "elevenlabs_api_key"
    _voices_cache: list[TtsVoice] | None = None

    def voices(self) -> list[TtsVoice]:
        if not self.enabled():
            return []
        if self._voices_cache is not None:
            return self._voices_cache
        try:
            with self._client() as http:
                res = http.get(
                    "https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": self.key()}
                )
            res.raise_for_status()
            items = res.json().get("voices", [])
        except (httpx.HTTPError, ValueError):
            return []
        self._voices_cache = [
            TtsVoice(
                provider="elevenlabs",
                id=str(v.get("voice_id")),
                name=str(v.get("name", v.get("voice_id"))),
                language="multi",
                installed=True,
            )
            for v in items
            if v.get("voice_id")
        ]
        return self._voices_cache

    def synthesize(self, text: str, voice: str, params: SynthesisParams, out_wav: Path) -> None:
        body = {
            "text": text,
            "model_id": self.settings.elevenlabs_model,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "speed": params.speed},
        }
        with self._client() as http:
            res = http.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": self.key()},
                json=body,
            )
        if res.status_code != 200:
            raise RuntimeError(f"ElevenLabs respondio {res.status_code}: {res.text[:300]}")
        self._save_and_convert(res.content, ".mp3", out_wav)


# ------------------------------------------------------------------------------------- registry


def build_providers(settings: Settings) -> dict[str, TtsProvider]:
    # Sprint 4: Chatterbox (local, isolated tool venv); Piper stays the default and the fallback.
    from .chatterbox import ChatterboxProvider  # noqa: PLC0415 - chatterbox imports this module

    providers: list[TtsProvider] = [
        PiperProvider(settings),
        ElevenLabsProvider(settings),
        OpenAiProvider(settings),
        ChatterboxProvider(settings),
    ]
    return {p.id: p for p in providers}


def output_info(path: Path) -> tuple[float, int]:
    return wav_info(path)
