"""Sprint 5 task contract (mirror of WorkerTaskSchema / WorkerTaskCancelSchema in
packages/shared/src/ai.ts). ``TaskQueue`` tasks expose ``TaskPublic`` on
``GET /<area>/tasks/{id}`` and answer ``TaskCancelResponse`` on ``POST /<area>/tasks/{id}/cancel``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

TaskStatus = Literal["queued", "running", "done", "error", "canceled"]


class TaskPublic(BaseModel):
    task_id: str
    kind: str
    target: str
    status: TaskStatus
    progress: float
    bytes_done: int = 0
    bytes_total: int = 0
    current_file: str | None = None
    done: int | None = None
    total: int | None = None
    stage_es: str | None = None
    eta_s: float | None = None
    cancellable: bool = True
    error: str | None = None
    code: str | None = None
    message: str | None = None
    result: Any = None


class TaskCancelResponse(BaseModel):
    task_id: str
    canceled: bool
    was: Literal["queued", "running", "finished"]


class TranscribeCancelRequest(BaseModel):
    """POST /transcribe/cancel body (answer: ``{stopped: bool}``)."""

    job_id: str


# ---------------------------------------------------------------------------------------------
# Sprint 6 (docs/trabajo/sprint6-contratos.md). Mirrors of WorkerSttWordsRequestSchema /
# ScriptAudioSchema (packages/shared/src/script.ts) and WorkerSuggestAnalyzeRequestSchema /
# WorkerSuggestAnalyzeResultSchema (suggestions.ts). Paso 0 registers the tasks; the owner
# modules implement them (M1 stt.words, M3 suggest.analyze + TaskQueue priority).

# TaskQueue priorities (M3 turns the FIFO into a PriorityQueue; lower runs first).
TASK_PRIORITY_USER = 0
TASK_PRIORITY_BACKGROUND = 5

SPRINT6_MODULES = {"M1": "M1 Guion", "M2": "M2 Sistema de diseño", "M3": "M3 Sugerencias"}


class SttWordsRequest(BaseModel):
    """POST /transcribe/words -> ``{task_id}`` (task ``stt.words``, area ``transcribe``)."""

    model_config = ConfigDict(extra="forbid")

    input_path: str = Field(min_length=1)
    language: str = "es"
    model: str | None = None
    job_id: str | None = None
    clip_in_s: float | None = Field(default=None, ge=0)
    clip_out_s: float | None = Field(default=None, ge=0)
    # "renders/<jobId>": transcript.json + script-audio.json + script-rms.f32
    output_base: str = Field(min_length=1)
    hallucination_silence_threshold: float = Field(default=2.0, gt=0)


class AudioGap(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    rms_db: float
    voiced: bool


class ScriptAudio(BaseModel):
    noise_floor_db: float
    window_ms: Literal[5] = 5
    # Float32 LE RMS in dB every 5 ms (STORAGE_DIR-relative)
    rms_db_path: str
    gaps: list[AudioGap]


class SuggestAnalyzeRequest(BaseModel):
    """POST /analyze/suggest -> ``{task_id}`` (task ``suggest.analyze``, area ``analyze``)."""

    model_config = ConfigDict(extra="forbid")

    input_path: str = Field(min_length=1)
    job_id: str | None = None
    silence_min_ms: int = Field(default=500, ge=100, le=10_000)
    silence_rel_db: float = Field(default=9.0, ge=3, le=30)
    priority: int = Field(default=TASK_PRIORITY_BACKGROUND, ge=0, le=9)


class SuggestAnalyzeResult(BaseModel):
    """``result`` of suggest.analyze (source seconds)."""

    duration_s: float = Field(ge=0)
    noise_floor_db: float
    silence_threshold_db: float
    silences: list[tuple[float, float]]
    lufs_i: float | None
    lra: float | None
    true_peak_db: float | None


class TaskSpec(BaseModel):
    """One Sprint 6 task kind: owner module, TaskQueue area, payload model and progress unit."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    kind: str
    module: str
    area: Literal["transcribe", "analyze"]
    route: str
    payload: type[BaseModel]
    priority: int
    unit: Literal["seconds", "items"] | None = None


SPRINT6_TASKS: dict[str, TaskSpec] = {
    "stt.words": TaskSpec(
        kind="stt.words",
        module=SPRINT6_MODULES["M1"],
        area="transcribe",
        route="/transcribe/words",
        payload=SttWordsRequest,
        priority=TASK_PRIORITY_USER,
        unit="seconds",
    ),
    "suggest.analyze": TaskSpec(
        kind="suggest.analyze",
        module=SPRINT6_MODULES["M3"],
        area="analyze",
        route="/analyze/suggest",
        payload=SuggestAnalyzeRequest,
        priority=TASK_PRIORITY_BACKGROUND,
        unit="seconds",
    ),
}
