"""Pydantic mirrors of the worker contract (see packages/shared/src/api.ts WORKER_ROUTES).

All paths are RELATIVE to STORAGE_DIR. Field names are camelCase on the wire to match TS.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Capabilities(CamelModel):
    whisper: bool
    piper: bool
    rvc: bool


class WorkerHealth(CamelModel):
    status: Literal["ok"] = "ok"
    cuda: bool
    capabilities: Capabilities


class TranscribeRequest(CamelModel):
    input_path: str
    language: str = "es"
    model: str | None = None
    word_timestamps: bool = True


class SubtitleWord(CamelModel):
    start: float
    end: float
    word: str
    probability: float | None = None


class SubtitleSegment(CamelModel):
    start: float
    end: float
    text: str
    words: list[SubtitleWord] | None = None


class Transcript(CamelModel):
    language: str
    duration_sec: float
    segments: list[SubtitleSegment]


class TtsVoice(CamelModel):
    provider: Literal["piper"] = "piper"
    id: str
    name: str
    language: str
    installed: bool


class TtsRequest(CamelModel):
    text: str
    voice: str
    speed: float = 1.0
    output_path: str


class TtsResult(CamelModel):
    path: str
    duration_sec: float


class RvcModel(CamelModel):
    id: str
    name: str
    model_path: str
    index_path: str | None = None


class RvcConvertRequest(CamelModel):
    input_path: str
    model_id: str
    pitch_shift: int = 0
    index_rate: float = 0.75
    f0_method: Literal["rmvpe", "harvest", "pm", "crepe"] = "rmvpe"
    device: Literal["cpu", "cuda"] | None = None
    output_path: str


class RvcResult(CamelModel):
    path: str
