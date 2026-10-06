"""Pydantic mirrors of the worker contract (see packages/shared/src/api.ts WORKER_ROUTES).

All paths are RELATIVE to STORAGE_DIR unless stated otherwise. Field names are camelCase on the
wire to match TS. Fields marked "additive" extend the base contract in docs/ARQUITECTURA.md §3;
they are optional so the api can ignore them.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

TtsProviderId = Literal["piper", "elevenlabs", "openai", "chatterbox"]
F0Method = Literal["rmvpe", "harvest", "pm", "crepe"]
JobState = Literal["running", "succeeded", "failed"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ---------------------------------------------------------------- health


class Capabilities(CamelModel):
    whisper: bool
    piper: bool
    rvc: bool


class TorchInfo(CamelModel):
    installed: bool
    version: str | None = None
    cuda_available: bool | None = None
    cuda_version: str | None = None
    device_name: str | None = None
    # True while the (slow) torch import is still running in the background.
    probing: bool = False


class FfmpegInfo(CamelModel):
    found: bool
    path: str | None = None
    version: str | None = None


class ModelsInfo(CamelModel):
    whisper: list[str] = Field(default_factory=list)
    piper: list[str] = Field(default_factory=list)
    rvc: list[str] = Field(default_factory=list)
    rvc_base: dict[str, bool] = Field(default_factory=dict)


class WorkerHealth(CamelModel):
    status: Literal["ok"] = "ok"
    # True when CUDA is requested (USE_CUDA) AND usable (torch or ctranslate2 sees a GPU).
    cuda: bool
    capabilities: Capabilities
    # additive
    use_cuda: bool | None = None
    torch: TorchInfo | None = None
    ffmpeg: FfmpegInfo | None = None
    models: ModelsInfo | None = None
    packages: dict[str, str | None] | None = None
    # Sprint 1: GET /gpu/status payload (snake_case) and {packId: installed|partial|missing}.
    gpu: dict[str, Any] | None = None
    packs: dict[str, str] | None = None
    # Sprint 2: {"gpl_venv": ready|stale|missing, "packs": {matting, matting-image, sam2, reframe}}
    vision: dict[str, Any] | None = None


# ---------------------------------------------------------------- jobs / progress


class JobProgress(CamelModel):
    job_id: str
    status: JobState
    progress: float = 0.0
    message: str | None = None
    error: str | None = None


# ---------------------------------------------------------------- transcribe


class TranscribeRequest(CamelModel):
    input_path: str
    language: str = "es"
    model: str | None = None
    word_timestamps: bool = True
    # additive
    job_id: str | None = None
    # e.g. "renders/<jobId>" -> writes <base>.json, <base>.srt, <base>.ass (relative to storage).
    output_base: str | None = None
    vad: bool = True
    beam_size: int = Field(default=5, ge=1, le=10)
    compute_type: str | None = None
    max_words_per_line: int = Field(default=7, ge=1, le=30)


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


class TranscriptFiles(CamelModel):
    json_path: str
    srt: str
    ass: str


class Transcript(CamelModel):
    language: str
    duration_sec: float
    segments: list[SubtitleSegment]
    # additive
    model: str | None = None
    device: str | None = None
    files: TranscriptFiles | None = None
    # Sprint 1 (docs/trabajo/sprint1-contratos.md): snake_case on the wire, as in the contract.
    model_used: str | None = Field(default=None, alias="model_used")
    compute_type: str | None = Field(default=None, alias="compute_type")
    warnings: list[str] | None = None


# ---------------------------------------------------------------- tts


class TtsVoice(CamelModel):
    provider: TtsProviderId = "piper"
    id: str
    name: str
    language: str
    installed: bool
    # additive
    quality: str | None = None
    size_bytes: int | None = None
    default: bool = False


class TtsProviderInfo(CamelModel):
    id: TtsProviderId
    name: str
    enabled: bool
    # Spanish status label for the dashboard: "local", "configurado", "no configurado",
    # "falta paquete" (sprint 4: Chatterbox without its pack).
    status: str
    # Sprint 4 (additive, Chatterbox row): pack, clone support, installed checkpoint, languages.
    pack_id: str | None = None
    installed: bool | None = None
    supports_clone: bool | None = None
    models: list[Literal["mtl-v3", "mtl-v2"]] | None = None
    languages: list[str] | None = None
    gpu: bool | None = None


class VoiceRef(CamelModel):
    """Sprint 4: reference sample to clone (Chatterbox). ``path`` is STORAGE_DIR-relative (a
    «Voz propia» asset under media/ or a Person sample under consent/persons/<id>/); ``consent`` is
    "self" or the consentId the api checked (logged; the workers re-check the storage layout)."""

    path: str = Field(min_length=1)
    consent: str = Field(min_length=1, max_length=120)


class TtsRequest(CamelModel):
    text: str = Field(min_length=1, max_length=20_000)
    voice: str
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    output_path: str
    # additive
    provider: TtsProviderId = "piper"
    format: Literal["wav", "mp3"] = "wav"
    noise_scale: float | None = Field(default=None, ge=0.0, le=2.0)
    noise_w: float | None = Field(default=None, ge=0.0, le=2.0)
    sentence_silence: float = Field(default=0.0, ge=0.0, le=5.0)
    speaker_id: int | None = None
    volume: float = Field(default=1.0, ge=0.0, le=4.0)
    job_id: str | None = None
    # Sprint 4 (Chatterbox; same ranges as the shared zod TtsRequest; ignored by Piper/cloud).
    language: str | None = Field(default=None, pattern=r"^[a-z]{2}$")
    model: Literal["mtl-v3", "mtl-v2"] | None = None
    voice_ref: VoiceRef | None = None
    exaggeration: float | None = Field(default=None, ge=0.25, le=2.0)
    cfg: float | None = Field(default=None, ge=0.0, le=1.0)
    temperature: float | None = Field(default=None, ge=0.05, le=2.0)
    seed: int | None = Field(default=None, ge=0)


class TtsResult(CamelModel):
    path: str
    duration_sec: float
    # additive
    wav_path: str | None = None
    sample_rate: int | None = None
    provider: TtsProviderId | None = None
    # Sprint 4 (Chatterbox): device used, warnings (gpu_fallback_cpu, chatterbox_cpu_slow...),
    # inaudible PerTh watermark, real-time factor and checkpoint (mtl-v3 | mtl-v2).
    device: Literal["cuda", "cpu"] | None = None
    warnings: list[str] | None = None
    watermark: Literal["perth"] | None = None
    rtf: float | None = None
    model: str | None = None


# ---------------------------------------------------------------- models download


class ModelDownloadRequest(CamelModel):
    kind: Literal["piper", "whisper", "rvc-base"]
    # piper voice id (es_AR-daniela-high) or whisper size (base). Unused for rvc-base.
    id: str | None = None
    force: bool = False
    # rvc-base only: also fetch the legacy fairseq hubert_base.pt (not used by infer-rvc-python).
    include_legacy: bool = False


class DownloadedFile(CamelModel):
    path: str  # relative to MODELS_DIR
    size_bytes: int
    skipped: bool = False


class ModelDownloadResult(CamelModel):
    kind: str
    id: str | None = None
    files: list[DownloadedFile]


# ---------------------------------------------------------------- rvc


class RvcModel(CamelModel):
    id: str
    name: str
    model_path: str  # relative to MODELS_DIR
    index_path: str | None = None


class RvcConvertRequest(CamelModel):
    input_path: str
    model_id: str
    pitch_shift: int = Field(default=0, ge=-24, le=24)
    index_rate: float = Field(default=0.75, ge=0.0, le=1.0)
    f0_method: F0Method = "rmvpe"
    device: Literal["cpu", "cuda"] | None = None
    output_path: str
    # additive
    filter_radius: int = Field(default=3, ge=0, le=7)
    rms_mix_rate: float = Field(default=0.25, ge=0.0, le=1.0)
    protect: float = Field(default=0.33, ge=0.0, le=0.5)
    job_id: str | None = None


class RvcResult(CamelModel):
    path: str
    # additive
    sample_rate: int | None = None
    duration_sec: float | None = None
    device: str | None = None
    warnings: list[str] | None = None


# ---------------------------------------------------------------- sprint 1 (snake_case contract)


class SnakeModel(BaseModel):
    """docs/trabajo/sprint1-contratos.md uses snake_case; camelCase input is accepted too."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ScenesRequest(SnakeModel):
    path: str
    threshold: float | None = Field(default=None, gt=0, le=255)
    min_scene_len_s: float | None = Field(default=None, ge=0, le=600)


class TranscriptWord(SnakeModel):
    w: str
    s: float
    e: float


class TranscriptWords(SnakeModel):
    words: list[TranscriptWord] = Field(default_factory=list)


class SilencesRequest(SnakeModel):
    path: str
    min_silence_ms: int = Field(default=500, ge=50, le=60_000)
    noise_db: float = Field(default=-35.0, ge=-120, le=0)
    padding_ms: int = Field(default=120, ge=0, le=5_000)
    fillers: bool = True
    transcript: TranscriptWords | None = None
    language: str = "es"
    # Whisper VAD when the workers transcribe here (no transcript sent). Off by default: the VAD
    # filter tends to drop fillers ("eh", "mmm") together with the pauses around them.
    vad: bool = False


class DenoiseRequest(SnakeModel):
    path: str
    output_base: str
    format: Literal["wav", "mp3"] | None = None


# ---------------------------------------------------------------- sprint 2 (vision, snake_case)
# Coordinates (bbox, points): pixels of the source frame, or normalized 0..1 when every value is
# <= 1 (or `normalized: true`). frame / frame_range: frame indexes of the source, inclusive.


class BBox(SnakeModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class MatteRefine(SnakeModel):
    """Sprint 3b alpha refinement (vision_gpl/refine.py); None = default of the quality."""

    erode: int | None = Field(default=None, ge=0, le=20)
    feather: float | None = Field(default=None, ge=0, le=20)
    despill: bool | None = None
    temporal: float | None = Field(default=None, ge=0, le=0.9)
    mask_dilate: int | None = Field(default=None, ge=0, le=200)


class MatteRequest(SnakeModel):
    path: str
    model: Literal["rvm", "birefnet"] = "rvm"
    output_base: str
    downsample: float | None = Field(default=None, ge=0.25, le=1.0)
    chunk_frames: int = Field(default=300, ge=10, le=3000)
    # sprint 3b: fast = mobilenetv3 (pack matting); high = resnet50 + refinement (matting-hq)
    quality: Literal["fast", "high"] = "fast"
    refine: MatteRefine | None = None
    # SAM mask guide: one PNG or a folder of %05d.png (relative to STORAGE_DIR)
    mask_path: str | None = None


class MatteImageRequest(SnakeModel):
    path: str
    output_base: str


class SamSessionRequest(SnakeModel):
    path: str
    frame_range: tuple[int, int] | None = None
    asset_id: str = ""


class SamPoint(SnakeModel):
    x: float
    y: float
    label: Literal[0, 1] = 1


class SamPointsRequest(SnakeModel):
    frame: int = Field(ge=0)
    points: list[SamPoint] = Field(min_length=1)
    obj_id: int = Field(default=1, ge=0)
    normalized: bool | None = None
    # additive: true = these points replace the previous clicks of this frame/object
    replace: bool = False


class SamPropagateRequest(SnakeModel):
    chunk_frames: int = Field(default=200, ge=10, le=600)
    alpha: bool = True


class TrackRequest(SnakeModel):
    path: str
    bbox: BBox | None = None
    mask_png: str | None = None
    method: Literal["sam2", "csrt"] = "csrt"
    frame_range: tuple[int, int] | None = None
    asset_id: str = ""
    smoothing: bool = True
    output_base: str | None = None


class SceneSpan(SnakeModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class ReframeRequest(SnakeModel):
    path: str
    target: Literal["9:16", "1:1", "4:5"] = "9:16"
    scenes: list[SceneSpan] | None = None
    subject: Literal["face", "track"] = "face"
    track_path: str | None = None
