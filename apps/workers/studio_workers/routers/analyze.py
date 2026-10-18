from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from ..analyze import (
    SUGGEST_STAGE_ES,
    Word,
    analyze_for_suggestions,
    detect_scenes,
    plan_cuts,
    run_silencedetect,
    words_from_transcript,
)
from ..config import Settings, get_settings
from ..errors import NotFoundError
from ..packs import module_present
from ..schemas import ScenesRequest, SilencesRequest
from ..services import whisper_engine
from ..task_schema import SuggestAnalyzeRequest, SuggestAnalyzeResult
from ..tasks import Task, TaskQueue, cancel_or_404, task_not_found

router = APIRouter(prefix="/analyze", tags=["analyze"])


def resolve_input(settings: Settings, path: str) -> Path:
    """STORAGE_DIR-relative path (absolute paths are accepted only inside storage)."""
    candidate = Path(path)
    if candidate.is_absolute():
        resolved = candidate.resolve()
        root = settings.storage_root
        if resolved != root and root not in resolved.parents:
            raise ValueError(f"La ruta debe estar dentro de storage: {path}")
    else:
        resolved = settings.storage_path(path)
    if not resolved.is_file():
        raise NotFoundError(f"No existe el archivo: {path}")
    return resolved


@router.post("/scenes")
def scenes(req: ScenesRequest) -> dict[str, Any]:
    """PySceneDetect ContentDetector -> {scenes: [{start, end, score}]} (409 PACK_REQUIRED)."""
    src = resolve_input(get_settings(), req.path)
    return detect_scenes(src, req.threshold, req.min_scene_len_s)


@router.post("/silences")
def silences(req: SilencesRequest) -> dict[str, Any]:
    """FFmpeg silencedetect + Whisper word fillers -> {cuts, total_removed_s} (plan only)."""
    src = resolve_input(get_settings(), req.path)
    intervals, duration = run_silencedetect(src, req.noise_db, req.min_silence_ms)
    warnings: list[str] = []
    words: list[Word] | None = None
    source = None
    if req.fillers:
        if req.transcript is not None:
            words = [Word(w.w, w.s, w.e) for w in req.transcript.words]
            source = "request"
        elif module_present("faster_whisper"):
            transcript = whisper_engine().transcribe(
                src, language=req.language, word_timestamps=True, vad=req.vad
            )
            words = words_from_transcript(transcript)
            warnings.extend(transcript.warnings or [])
            source = f"whisper:{transcript.model_used}"
        else:
            warnings.append("fillers_skipped_no_transcript")
    result = plan_cuts(intervals, duration, words, padding_ms=req.padding_ms)
    result["silences_detected"] = len(intervals)
    result["words_source"] = source
    if warnings:
        result["warnings"] = list(dict.fromkeys(warnings))
    return result


# BEGIN sprint6:M3 (suggest.analyze in the ``analyze`` TaskQueue, background priority;
# docs/trabajo/sprint6-contratos.md M3)
@lru_cache
def analyze_queue() -> TaskQueue:
    """Import analyses (CPU, one at a time). Background tasks (priority 5) never run before a
    queued user task (priority 0); a running one checks cancel every second of audio."""
    return TaskQueue("analyze")


@router.post("/suggest")
def suggest(req: SuggestAnalyzeRequest) -> dict[str, str]:
    """One FFmpeg pass (ebur128 + 8 kHz PCM: floor, relative silences) -> ``{task_id}``;
    poll ``GET /analyze/tasks/{id}`` (result = SuggestAnalyzeResult)."""
    src = resolve_input(get_settings(), req.input_path)

    def job(task: Task) -> dict[str, Any]:
        task.set_items(0, 1, SUGGEST_STAGE_ES)
        raw = analyze_for_suggestions(
            src,
            silence_min_ms=req.silence_min_ms,
            silence_rel_db=req.silence_rel_db,
            task=task,
        )
        return SuggestAnalyzeResult.model_validate(raw).model_dump()

    target = req.job_id or req.input_path
    task = analyze_queue().submit("suggest.analyze", target, job, priority=req.priority)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def analyze_task(task_id: str) -> dict[str, Any]:
    task = analyze_queue().get(task_id)
    if task is None:
        raise task_not_found(task_id)
    return task.public()


@router.post("/tasks/{task_id}/cancel")
def analyze_task_cancel(task_id: str) -> dict[str, Any]:
    return cancel_or_404(analyze_queue(), task_id)


# END sprint6:M3
