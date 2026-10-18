import threading
from functools import lru_cache

from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError, require_module
from ..progress import registry
from ..schemas import TranscribeRequest, Transcript, TranscriptFiles
from ..services import whisper_engine
from ..stt.formats import write_all
from ..stt.words import run_stt_words
from ..task_schema import TASK_PRIORITY_USER, SttWordsRequest, TranscribeCancelRequest
from ..tasks import Task, TaskCanceled, TaskQueue, cancel_or_404, task_not_found

router = APIRouter(tags=["transcribe"])

# Sprint 5: job_id -> cancel event of a running /transcribe (checked between segments).
_cancels: dict[str, threading.Event] = {}
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
    # Audit D10: the cancel event exists before any check, so a cancel sent while the input is
    # being validated (or the module looked up) is not lost.
    cancel = threading.Event()
    if req.job_id:
        with _lock:
            _cancels[req.job_id] = cancel

    def on_progress(p: float, message: str) -> None:
        if cancel.is_set():
            raise TaskCanceled(req.job_id or "transcribe")
        registry.update(req.job_id, p, message)

    try:
        settings = get_settings()
        src = settings.storage_path(req.input_path)
        if not src.is_file():
            raise NotFoundError(f"No existe el audio de entrada: {req.input_path}")
        require_module("faster_whisper", "faster-whisper==1.2.1")
        if cancel.is_set():
            raise TaskCanceled(req.job_id or "transcribe")
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
                if _cancels.get(req.job_id) is cancel:
                    del _cancels[req.job_id]
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


# BEGIN sprint6:M1 (M1 Guion: task stt.words in the ``transcribe`` TaskQueue area, user priority;
# docs/trabajo/sprint6-contratos.md)
@lru_cache
def transcribe_queue() -> TaskQueue:
    """Word-level transcriptions for the Guion: one at a time (Whisper + numpy on the WAV)."""
    return TaskQueue("transcribe")


@router.post("/transcribe/words")
def transcribe_words(req: SttWordsRequest) -> dict[str, str]:
    """Word-level transcription without VAD + RMS envelope and gaps -> ``{task_id, status}``."""
    settings = get_settings()
    src = settings.storage_path(req.input_path)
    if not src.is_file():
        raise NotFoundError(f"No existe el audio de entrada: {req.input_path}")
    require_module("faster_whisper", "faster-whisper==1.2.1")
    engine = whisper_engine()

    def run(task: Task) -> dict[str, object]:
        return run_stt_words(task, req, engine, settings)

    task = transcribe_queue().submit(
        "stt.words", req.job_id or req.input_path, run, priority=TASK_PRIORITY_USER
    )
    return {"task_id": task.id, "status": task.status}


@router.get("/transcribe/tasks/{task_id}")
def transcribe_task(task_id: str) -> dict[str, object]:
    task = transcribe_queue().get(task_id)
    if task is None:
        raise task_not_found(task_id)
    out = task.public()
    warnings = (task.result or {}).get("warnings") if isinstance(task.result, dict) else None
    if warnings:
        out["warnings"] = warnings
    return out


@router.post("/transcribe/tasks/{task_id}/cancel")
def transcribe_task_cancel(task_id: str) -> dict[str, object]:
    return cancel_or_404(transcribe_queue(), task_id)


# END sprint6:M1
