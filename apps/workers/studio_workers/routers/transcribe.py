import threading

from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError, require_module
from ..progress import registry
from ..schemas import TranscribeRequest, Transcript, TranscriptFiles
from ..services import whisper_engine
from ..stt.formats import write_all
from ..task_schema import TranscribeCancelRequest
from ..tasks import TaskCanceled

router = APIRouter(tags=["transcribe"])

# Sprint 5: job_id -> cancel event of a running /transcribe (checked between segments).
_cancels: dict[str, threading.Event] = {}
# job_id -> (done_s, total_s) of a running /transcribe (GET /transcribe/progress/{job_id}).
_progress: dict[str, tuple[float, float | None]] = {}
_lock = threading.Lock()


@router.post(
    "/transcribe",
    response_model=Transcript,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def transcribe(req: TranscribeRequest) -> Transcript:
    """Sync call (runs in the threadpool). Progress: GET /jobs/{jobId} when jobId is sent.
    Sprint 5: POST /transcribe/cancel {job_id} stops it between segments (TaskCanceled)."""
    settings = get_settings()
    src = settings.storage_path(req.input_path)
    if not src.is_file():
        raise NotFoundError(f"No existe el audio de entrada: {req.input_path}")
    require_module("faster_whisper", "faster-whisper==1.2.1")
    cancel = threading.Event()
    if req.job_id:
        with _lock:
            _cancels[req.job_id] = cancel

    def on_progress(p: float, message: str) -> None:
        if cancel.is_set():
            raise TaskCanceled(req.job_id or "transcribe")
        registry.update(req.job_id, p, message)
        if req.job_id:
            with _lock:
                _progress[req.job_id] = (float(p), None)

    try:
        with registry.track(req.job_id, "Cargando modelo Whisper"):
            transcript = whisper_engine().transcribe(
                src,
                model=req.model,
                language=req.language,
                word_timestamps=req.word_timestamps,
                vad=req.vad,
                beam_size=req.beam_size,
                compute_type=req.compute_type,
                on_progress=on_progress,
            )
            if cancel.is_set():
                raise TaskCanceled(req.job_id or "transcribe")
            if req.output_base:
                base = settings.storage_path(req.output_base)
                json_p, srt_p, ass_p = write_all(transcript, base, req.max_words_per_line)
                transcript.files = TranscriptFiles(
                    json_path=settings.storage_relative(json_p),
                    srt=settings.storage_relative(srt_p),
                    ass=settings.storage_relative(ass_p),
                )
    finally:
        if req.job_id:
            with _lock:
                _cancels.pop(req.job_id, None)
                _progress.pop(req.job_id, None)
    return transcript


@router.post("/transcribe/cancel")
def transcribe_cancel(req: TranscribeCancelRequest) -> dict[str, bool]:
    """Stop the running /transcribe of ``job_id`` at the next segment -> {stopped}."""
    with _lock:
        event = _cancels.get(req.job_id)
    if event is None:
        return {"stopped": False}
    event.set()
    return {"stopped": True}


@router.get("/transcribe/progress/{job_id}")
def transcribe_progress(job_id: str) -> dict[str, float | None]:
    """{progress, done_s, total_s} of a running /transcribe (total_s from the transcript info
    when known; the api uses the asset duration otherwise)."""
    with _lock:
        item = _progress.get(job_id)
    if item is None:
        raise NotFoundError(f"No hay una transcripción en curso para {job_id}")
    p, total = item
    return {"progress": p, "done_s": p * total if total else None, "total_s": total}
