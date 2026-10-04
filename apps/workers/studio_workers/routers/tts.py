from fastapi import APIRouter, HTTPException

from ..schemas import TtsRequest, TtsResult, TtsVoice

router = APIRouter(prefix="/tts", tags=["tts"])


@router.get("/voices", response_model=list[TtsVoice], response_model_by_alias=True)
def list_voices() -> list[TtsVoice]:
    # TODO(module-d): scan models_root/"piper" for *.onnx + *.onnx.json and report installed voices.
    return []


@router.post("", response_model=TtsResult, response_model_by_alias=True)
def synthesize(req: TtsRequest) -> TtsResult:
    # TODO(module-d): piper.PiperVoice.load(models_root/"piper"/f"{req.voice}.onnx"),
    #   synthesize to WAV at settings.storage_path(req.output_path), length_scale = 1 / req.speed.
    raise HTTPException(status_code=501, detail="TODO(module-d): tts not implemented")
