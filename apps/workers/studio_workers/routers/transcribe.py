from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError, require_module
from ..progress import registry
from ..schemas import TranscribeRequest, Transcript, TranscriptFiles
from ..services import whisper_engine
from ..stt.formats import write_all

router = APIRouter(tags=["transcribe"])


@router.post(
    "/transcribe",
    response_model=Transcript,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def transcribe(req: TranscribeRequest) -> Transcript:
    """Sync call (runs in the threadpool). Progress: GET /jobs/{jobId} when jobId is sent."""
    settings = get_settings()
    src = settings.storage_path(req.input_path)
    if not src.is_file():
        raise NotFoundError(f"No existe el audio de entrada: {req.input_path}")
    require_module("faster_whisper", "faster-whisper==1.2.1")
    with registry.track(req.job_id, "Cargando modelo Whisper"):
        transcript = whisper_engine().transcribe(
            src,
            model=req.model,
            language=req.language,
            word_timestamps=req.word_timestamps,
            vad=req.vad,
            beam_size=req.beam_size,
            compute_type=req.compute_type,
            on_progress=lambda p, m: registry.update(req.job_id, p, m),
        )
        if req.output_base:
            base = settings.storage_path(req.output_base)
            json_p, srt_p, ass_p = write_all(transcript, base, req.max_words_per_line)
            transcript.files = TranscriptFiles(
                json_path=settings.storage_relative(json_p),
                srt=settings.storage_relative(srt_p),
                ass=settings.storage_relative(ass_p),
            )
    return transcript
