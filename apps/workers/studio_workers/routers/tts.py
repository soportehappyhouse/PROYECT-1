from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import get_settings
from ..errors import NotFoundError, require_module
from ..media import wav_info, wav_to_mp3
from ..progress import registry
from ..schemas import TtsProviderInfo, TtsRequest, TtsResult, TtsVoice
from ..services import tts_providers
from ..tts.chatterbox import synthesize_request
from ..tts.providers import ProviderNotConfiguredError, SynthesisParams

router = APIRouter(prefix="/tts", tags=["tts"])


@router.get(
    "/voices",
    response_model=list[TtsVoice],
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def list_voices() -> list[TtsVoice]:
    """Piper voices (installed + downloadable catalog) + cloud voices of configured providers."""
    voices: list[TtsVoice] = []
    for provider in tts_providers().values():
        voices.extend(provider.voices())
    return voices


@router.get(
    "/providers",
    response_model=list[TtsProviderInfo],
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def list_providers() -> list[TtsProviderInfo]:
    return [p.info() for p in tts_providers().values()]


@router.post(
    "", response_model=TtsResult, response_model_by_alias=True, response_model_exclude_none=True
)
def synthesize(req: TtsRequest) -> TtsResult:
    settings = get_settings()
    provider = tts_providers().get(req.provider)
    if provider is None:
        raise NotFoundError(f"Proveedor TTS desconocido: {req.provider}")
    if req.provider == "chatterbox":
        return _synthesize_chatterbox(req)
    if req.provider == "piper":
        require_module("piper", "piper-tts==1.8.0")
    elif not provider.enabled():
        raise ProviderNotConfiguredError(f"{provider.name}: no configurado (falta la key en .env)")

    out = settings.storage_path(req.output_path)
    wav = out if out.suffix.lower() == ".wav" else out.with_suffix(".wav")
    params = SynthesisParams(
        speed=req.speed,
        noise_scale=req.noise_scale,
        noise_w=req.noise_w,
        sentence_silence=req.sentence_silence,
        speaker_id=req.speaker_id,
        volume=req.volume,
    )
    with registry.track(req.job_id, f"Sintetizando con {provider.name}"):
        provider.synthesize(req.text, req.voice, params, wav)
        duration, rate = wav_info(wav)
        final = wav
        if req.format == "mp3" or out.suffix.lower() == ".mp3":
            final = out if out.suffix.lower() == ".mp3" else out.with_suffix(".mp3")
            registry.update(req.job_id, 0.9, "Codificando MP3")
            wav_to_mp3(wav, final)
    return TtsResult(
        path=settings.storage_relative(final),
        duration_sec=round(duration, 3),
        wav_path=settings.storage_relative(wav),
        sample_rate=rate,
        provider=req.provider,
    )


class TtsCancelRequest(BaseModel):
    """POST /tts/cancel: the api's job id (= TtsRequest.job_id); empty = whatever is running."""

    job_id: str | None = Field(default=None, alias="jobId", max_length=120)

    model_config = {"populate_by_name": True}


@router.post("/cancel")
def cancel(req: TtsCancelRequest | None = None) -> dict[str, Any]:
    """Audit fix 8: a canceled voice.tts job really stops Chatterbox: the bridge tree is killed and
    the GPU released (the next request starts it again). Piper/cloud calls are short: no-op."""
    from ..services import chatterbox_client  # noqa: PLC0415

    job_id = req.job_id if req is not None else None
    stopped = chatterbox_client().cancel(job_id)
    return {"canceled": True, "stopped": stopped, "jobId": job_id}


def _synthesize_chatterbox(req: TtsRequest) -> TtsResult:
    """Sprint 4: Chatterbox Multilingual (isolated tool subprocess), optional zero-shot clone.

    Progress per text chunk (≤ 300 characters); WAV 24 kHz mono -> MP3 with the same path as Piper.
    """
    settings = get_settings()
    out = settings.storage_path(req.output_path)
    wav = out if out.suffix.lower() == ".wav" else out.with_suffix(".wav")

    def on_progress(chunk: int, chunks: int) -> None:
        if chunks > 0:
            registry.update(
                req.job_id, 0.05 + 0.85 * chunk / chunks, f"Chatterbox: trozo {chunk} de {chunks}"
            )

    with registry.track(req.job_id, "Sintetizando con Chatterbox"):
        registry.update(req.job_id, 0.02, "Cargando Chatterbox (la primera vez tarda)")
        outcome = synthesize_request(req, settings, wav, on_progress)
        duration, rate = wav_info(wav)
        final = wav
        if req.format == "mp3" or out.suffix.lower() == ".mp3":
            final = out if out.suffix.lower() == ".mp3" else out.with_suffix(".mp3")
            registry.update(req.job_id, 0.95, "Codificando MP3")
            wav_to_mp3(wav, final)
    return TtsResult(
        path=settings.storage_relative(final),
        duration_sec=round(duration, 3),
        wav_path=settings.storage_relative(wav),
        sample_rate=rate,
        provider="chatterbox",
        device="cuda" if outcome.device == "cuda" else "cpu",
        warnings=outcome.warnings or None,
        watermark="perth",
        rtf=outcome.rtf,
        model=outcome.model,
    )
