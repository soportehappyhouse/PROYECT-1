"""Workers face contract (docs/trabajo/sprint4-contratos.md «M1 · Workers», snake_case).

All paths are relative to STORAGE_DIR (resolved with resolve_input / settings.storage_path, which
refuse `..` and absolute paths outside storage)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SwapperModel = Literal["hyperswap_1a_256", "ghost_1_256", "inswapper_128_fp16"]


class FaceDetectRequest(BaseModel):
    path: str
    t: float = Field(0.0, ge=0)


class DetectedFace(BaseModel):
    index: int
    box: dict[str, float]  # x, y, w, h in 0..1 of the frame
    score: float


class FaceDetectResult(BaseModel):
    t: float
    width: int
    height: int
    frame_path: str
    faces: list[DetectedFace]


class FaceSelector(BaseModel):
    mode: Literal["reference", "one"]
    t: float | None = Field(None, ge=0)  # seconds of the target asset
    face_index: int | None = Field(None, ge=0)  # left to right
    distance: float = Field(0.3, ge=0.05, le=1.5)


class FaceSwapWorkerRequest(BaseModel):
    source_paths: list[str] = Field(min_length=1, max_length=10)  # consent/persons/<id>/photos/*
    target_path: str
    output_base: str = Field(min_length=1)  # renders/face/<jobId>/
    range: tuple[float, float] | None = None
    preview_t: float | None = Field(None, ge=0)  # => one PNG frame (before/after)
    selector: FaceSelector = Field(default_factory=lambda: FaceSelector(mode="one"))
    model: SwapperModel = "hyperswap_1a_256"
    enhancer: bool = True
    enhancer_blend: int = Field(80, ge=0, le=100)
    strength: float = Field(1.0, ge=0.1, le=1.0)
    consent_id: str = Field(min_length=1)
    licence_ids: list[Literal["faceswap"]] = Field(min_length=1)


class FaceTaskResult(BaseModel):
    output_path: str
    before_path: str | None = None
    frames: int
    fps: float
    proc_fps: float
    device: Literal["cuda", "cpu"]
    model: str
    timings: dict[str, float]
    warnings: list[str] = []
    log_tail: list[str] = []
