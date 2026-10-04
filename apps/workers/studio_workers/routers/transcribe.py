from fastapi import APIRouter, HTTPException

from ..schemas import TranscribeRequest, Transcript

router = APIRouter(tags=["transcribe"])


@router.post("/transcribe", response_model=Transcript, response_model_by_alias=True)
def transcribe(req: TranscribeRequest) -> Transcript:
    # TODO(module-d): faster_whisper.WhisperModel(settings.whisper_model or req.model,
    #   device="cuda" if use_cuda else "cpu", compute_type="float16"/"int8",
    #   download_root=models_root/"whisper"); cache the model; word_timestamps=req.word_timestamps,
    #   vad_filter=True (min_silence_duration_ms=500); language=None when req.language == "auto";
    #   automatic GPU->CPU fallback. Run in a threadpool (sync def is fine).
    raise HTTPException(status_code=501, detail="TODO(module-d): transcribe not implemented")
