import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";
import type { Project } from "./timeline.js";

/**
 * Sprint 1 (docs/trabajo/sprint1-contratos.md): GPU manager, model packs on demand, scenes,
 * silences/fillers, voice cleanup, AI performance test and "Revisión para redes".
 * Workers fields keep the snake_case names of the Python contract.
 */

/** Internal workers routes added in Sprint 1 (only the api calls them). */
export const WORKER_AI_ROUTES = {
  gpuStatus: "/gpu/status", // GET GpuStatus
  gpuRelease: "/gpu/release", // POST -> releases the resident model
  packs: "/packs", // GET Pack[]
  packDownload: "/packs/:id/download", // POST -> {task_id}
  packTask: "/packs/tasks/:id", // GET PackTask
  perfTask: "/perf/tasks/:id", // GET PackTask (same shape) of the perf test task
  analyzeScenes: "/analyze/scenes", // POST {path, threshold?, min_scene_len_s?} -> SceneList
  analyzeSilences: "/analyze/silences", // POST WorkerSilencesRequest -> SilenceCuts
  audioDenoise: "/audio/denoise", // POST {path, output_base} -> {path}
  perfRun: "/perf/run", // POST -> {task_id} (poll perfTask); result in storage/run/perf.json
  // Sprint 2 (vision). Tasks are polled on visionTask -> VisionTask {status, progress, result}.
  visionMatte: "/vision/matte", // POST {path, model, output_base, downsample?, chunk_frames?} -> {task_id}
  visionMatteImage: "/vision/matte-image", // POST {path, output_base} -> {path} (PNG RGBA)
  visionTask: "/vision/tasks/:id", // GET VisionTask
  samSession: "/vision/sam/session", // POST {path, frame_range?} -> {session_id, frames, fps}
  samPoints: "/vision/sam/session/:id/points", // POST {frame, points, obj_id} -> {mask_png_path, bbox}
  samPropagate: "/vision/sam/session/:id/propagate", // POST {chunk_frames?} -> {task_id}
  samSessionItem: "/vision/sam/session/:id", // DELETE
  visionTrack: "/vision/track", // POST {path, bbox | mask_png, method, frame_range?} -> {task_id}
  visionReframe: "/vision/reframe", // POST {path, target, scenes?, subject, track_path?} -> {task_id}
} as const;

/** GET /api/ai/gpu (proxy of workers GET /gpu/status). */
export const GpuStatusSchema = z.object({
  cuda: z.boolean(),
  gpu_name: z.string().nullish(),
  vram_total_mb: z.number().nullish(),
  vram_free_mb: z.number().nullish(),
  resident_model: z.string().nullable().default(null),
  mode: z.enum(["gpu", "cpu"]),
  sysmem_fallback: z.boolean().default(false),
  warnings: z.array(z.string()).optional(),
  /**
   * onnxruntime execution provider BiRefNet gets ("cpu" when only the CPU build is installed, e.g.
   * pulled by piper/faster-whisper); null = onnxruntime not installed.
   */
  onnx_provider: z.enum(["cuda", "cpu"]).nullish(),
});
export type GpuStatus = z.infer<typeof GpuStatusSchema>;

export const PackFileSchema = z.object({
  name: z.string(),
  size: z.number().nonnegative(),
  present: z.boolean(),
});
export type PackFile = z.infer<typeof PackFileSchema>;

/** One item of GET /api/ai/packs (models/packs.json + install state). */
export const PackSchema = z.object({
  id: z.string().min(1),
  name_es: z.string(),
  description_es: z.string().default(""),
  size_bytes: z.number().nonnegative(),
  installed: z.boolean(),
  partial: z.boolean().default(false),
  files: z.array(PackFileSchema).default([]),
  required_by: z.array(z.string()).default([]),
  license: z.string().nullish(),
  group: z.string().nullish(),
});
export type Pack = z.infer<typeof PackSchema>;

export const PackTaskStatusSchema = z.enum(["queued", "running", "done", "error"]);
export type PackTaskStatus = z.infer<typeof PackTaskStatusSchema>;

/** Workers GET /packs/tasks/{task_id}. */
export const PackTaskSchema = z.object({
  status: PackTaskStatusSchema,
  progress: z.number().min(0).max(1).default(0),
  bytes_done: z.number().nonnegative().default(0),
  bytes_total: z.number().nonnegative().default(0),
  current_file: z.string().nullish(),
  error: z.string().nullish(),
});
export type PackTask = z.infer<typeof PackTaskSchema>;

/** Workers answer of POST /packs/{id}/download and POST /perf/run. */
export const WorkerTaskAcceptedSchema = z.object({ task_id: z.string().min(1) });
export type WorkerTaskAccepted = z.infer<typeof WorkerTaskAcceptedSchema>;

/** Detected scene, in SOURCE seconds of the asset. */
export const SceneSchema = z.object({
  start: SecondsSchema,
  end: SecondsSchema,
  score: z.number().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const SceneListSchema = z.object({ scenes: z.array(SceneSchema) });
export type SceneList = z.infer<typeof SceneListSchema>;

export const SilenceCutKindSchema = z.enum(["silence", "filler"]);
export type SilenceCutKind = z.infer<typeof SilenceCutKindSchema>;

/** Proposed cut, in SOURCE seconds of the clip's asset (same time base as Clip.in/out). */
export const SilenceCutSchema = z.object({
  start: SecondsSchema,
  end: SecondsSchema,
  kind: SilenceCutKindSchema.default("silence"),
  text: z.string().optional(),
});
export type SilenceCut = z.infer<typeof SilenceCutSchema>;

export const SilenceCutsSchema = z.object({
  cuts: z.array(SilenceCutSchema),
  total_removed_s: z.number().nonnegative(),
});
export type SilenceCuts = z.infer<typeof SilenceCutsSchema>;

/**
 * storage/run/perf.json written by the workers perf test (GET /api/ai/perf). `gpu` is a label: the
 * GPU name or "cpu"; the full /gpu/status snapshot goes in `gpu_status`. Components that could not
 * be measured are null and listed in `skipped` (component -> reason) or `errors`.
 */
export const PerfResultSchema = z.object({
  gpu: z.string().nullish(),
  gpu_status: GpuStatusSchema.partial().passthrough().nullish(),
  whisper_turbo_s_per_min: z.number().nullish(),
  whisper_s_per_min: z.number().nullish(),
  whisper_model: z.string().nullish(),
  whisper_device: z.string().nullish(),
  piper_s_per_100chars: z.number().nullish(),
  rvc_s_per_min: z.number().nullish(),
  scenes_fps: z.number().nullish(),
  /**
   * Sprint 2 (vision). `rvm_fps`: a 1920×1080 5 s clip through the GPL subprocess (decode + model +
   * VP9 alpha encode); criterion ≥ `rvm_target_fps` (15). Precision fp16 (CUDA) / fp32 (CPU).
   */
  rvm_fps: z.number().nullish(),
  rvm_proc_fps: z.number().nullish(),
  rvm_device: z.string().nullish(),
  rvm_precision: z.string().nullish(),
  rvm_downsample: z.number().nullish(),
  rvm_resolution: z.string().nullish(),
  rvm_target_fps: z.number().nullish(),
  sam2_fps: z.number().nullish(),
  yunet_fps: z.number().nullish(),
  cpu_fallback_ok: z.boolean().default(false),
  ran_at: z.string(),
  skipped: z.record(z.string(), z.string()).default({}),
  errors: z.record(z.string(), z.string()).default({}),
  warnings: z.array(z.string()).default([]),
});
export type PerfResult = z.infer<typeof PerfResultSchema>;

/** Relative to STORAGE_DIR. */
export const PERF_RESULT_PATH = "run/perf.json";

/** "Revisión para redes" flags (what the video contains). */
export const PublishFlagsSchema = z.object({
  aiFace: z.boolean().default(false),
  aiVoice: z.boolean().default(false),
  aiOther: z.boolean().default(false),
  music: z.boolean().default(false),
  thirdParty: z.boolean().default(false),
});
export type PublishFlags = z.infer<typeof PublishFlagsSchema>;

export const DEFAULT_AI_LABEL_TEXT = "Contenido alterado con IA";

/**
 * `project.publish`. When `forSocial` AND `aiLabel` are true the export burns `aiLabelText`
 * (default DEFAULT_AI_LABEL_TEXT) bottom-left for the whole video (decision 4: the label is only
 * for social media; unchecking "Voy a subirlo a redes" turns it off without losing `aiLabel`).
 */
export const PublishSettingsSchema = z.object({
  forSocial: z.boolean().default(false),
  flags: PublishFlagsSchema.default({
    aiFace: false,
    aiVoice: false,
    aiOther: false,
    music: false,
    thirdParty: false,
  }),
  aiLabel: z.boolean().default(false),
  aiLabelText: z.string().max(120).optional(),
});
export type PublishSettings = z.infer<typeof PublishSettingsSchema>;

/** Label text burned on export, or undefined when the label is off (needs forSocial + aiLabel). */
export function aiLabelText(publish: PublishSettings | undefined): string | undefined {
  if (!publish?.forSocial || !publish.aiLabel) return undefined;
  return publish.aiLabelText?.trim() || DEFAULT_AI_LABEL_TEXT;
}

// ---------- api requests / job payloads ----------

/** POST /api/ai/analyze/scenes -> job analyze.scenes. */
export const AnalyzeScenesRequestSchema = z.object({
  assetId: IdSchema,
  threshold: z.number().positive().optional(),
  minSceneLenSec: z.number().positive().optional(),
});
export type AnalyzeScenesRequest = z.infer<typeof AnalyzeScenesRequestSchema>;

export const AnalyzeScenesResultSchema = z.object({
  assetId: IdSchema,
  scenes: z.array(SceneSchema),
});
export type AnalyzeScenesResult = z.infer<typeof AnalyzeScenesResultSchema>;

export const SilenceOptionsSchema = z.object({
  minSilenceMs: z.number().int().positive().default(500),
  noiseDb: z.number().max(0).default(-35),
  paddingMs: z.number().int().nonnegative().default(120),
  fillers: z.boolean().default(true),
  /**
   * `false`: ignore the project subtitles (usually transcribed with VAD, which drops fillers) and
   * let the workers re-transcribe the clip with Whisper's VAD off. Omitted = use the subtitles.
   */
  vad: z.boolean().optional(),
});
export type SilenceOptions = z.infer<typeof SilenceOptionsSchema>;

/** POST /api/ai/analyze/silences -> job analyze.silences (proposes cuts, never applies them). */
export const AnalyzeSilencesRequestSchema = z.object({
  projectId: IdSchema,
  clipId: IdSchema,
  options: SilenceOptionsSchema.default({
    minSilenceMs: 500,
    noiseDb: -35,
    paddingMs: 120,
    fillers: true,
  }),
});
export type AnalyzeSilencesRequest = z.infer<typeof AnalyzeSilencesRequestSchema>;

/** Result of analyze.silences: cuts inside [clip.in, clip.out], in source seconds. */
export const AnalyzeSilencesResultSchema = SilenceCutsSchema.extend({
  projectId: IdSchema,
  clipId: IdSchema,
  assetId: IdSchema,
  timeBase: z.literal("source"),
});
export type AnalyzeSilencesResult = z.infer<typeof AnalyzeSilencesResultSchema>;

export const CutRangeSchema = z.object({ start: SecondsSchema, end: SecondsSchema });
export type CutRange = z.infer<typeof CutRangeSchema>;

/** POST /api/ai/timeline/apply-cuts -> job timeline.apply-cuts (cuts in source seconds). */
export const ApplyCutsRequestSchema = z.object({
  projectId: IdSchema,
  clipId: IdSchema,
  cuts: z.array(CutRangeSchema).min(1),
});
export type ApplyCutsRequest = z.infer<typeof ApplyCutsRequestSchema>;

/** POST /api/ai/audio/denoise -> job audio.denoise (new asset). */
export const DenoiseRequestSchema = z.object({ assetId: IdSchema });
export type DenoiseRequest = z.infer<typeof DenoiseRequestSchema>;

export const PackDownloadPayloadSchema = z.object({ packId: z.string().min(1) });
export type PackDownloadPayload = z.infer<typeof PackDownloadPayloadSchema>;

export const PackDownloadResultSchema = z.object({ packId: z.string(), installed: z.boolean() });
export type PackDownloadResult = z.infer<typeof PackDownloadResultSchema>;

export const PerfRunPayloadSchema = z.object({}).default({});
export type PerfRunPayload = z.infer<typeof PerfRunPayloadSchema>;

/**
 * 409 body when a feature needs a model pack that is not installed (route answer, and `result` of
 * the failed job). The web opens the "Paquete requerido" dialog with it.
 */
export const PackRequiredBodySchema = z.object({
  error: z.literal("PACK_REQUIRED"),
  packId: z.string(),
  name_es: z.string(),
  size_bytes: z.number().nonnegative(),
  message: z.string().optional(),
});
export type PackRequiredBody = z.infer<typeof PackRequiredBodySchema>;

export const PACK_REQUIRED = "PACK_REQUIRED" as const;

/** Model pack each api feature needs (preflight before enqueueing; 409 PACK_REQUIRED). */
export const FEATURE_PACKS = {
  scenes: "scenes",
  denoise: "voz-limpia",
  rvc: "rvc-base",
  /** Not required: suggested (soft) when transcribing with CUDA and the pack is missing. */
  transcribeGpu: "whisper-turbo",
  /** Sprint 2 (vision). */
  matting: "matting",
  mattingImage: "matting-image",
  sam2: "sam2",
  reframe: "reframe",
} as const;

/** Soft pack suggestion in a job result (e.g. whisper-turbo when CUDA is there): never a 409. */
export const SuggestedPackSchema = z.object({
  packId: z.string(),
  name_es: z.string(),
  size_bytes: z.number().nonnegative(),
});
export type SuggestedPack = z.infer<typeof SuggestedPackSchema>;

/**
 * Estimated VRAM (MB) each GPU feature needs (decision 7: warn BEFORE starting when the job will
 * run on the CPU). Whisper large-v3-turbo float16 ~2.5 GB, RVC ~2 GB, DeepFilterNet ~1 GB.
 */
export const FEATURE_VRAM_MB = {
  transcribe: 2500,
  rvc: 2000,
  denoise: 1000,
  /** Sprint 2: RVM mobilenetv3 at 1080p ~1 GB, SAM 2.1 tiny ~1.5 GB (small > 3 GB). */
  matting: 1000,
  sam2: 1500,
  /** BiRefNet-lite (onnxruntime, 1024²) ~1.8 GB; also CPU when only the CPU onnxruntime is there. */
  birefnet: 1800,
} as const;
export type GpuFeature = keyof typeof FEATURE_VRAM_MB;

/**
 * True when `feature` will (probably) run on the CPU: workers in CPU mode, or less free VRAM than
 * the estimate. Unknown free VRAM in GPU mode is not a warning (the workers decide).
 */
export function willRunOnCpu(
  status:
    | (Pick<GpuStatus, "mode" | "vram_free_mb"> &
        Partial<Pick<GpuStatus, "cuda" | "onnx_provider">>)
    | undefined,
  feature: GpuFeature,
): boolean {
  if (!status) return false;
  if (status.mode === "cpu") return true;
  // CUDA machine whose onnxruntime is the CPU build: BiRefNet runs on the CPU whatever the VRAM.
  if (feature === "birefnet" && status.onnx_provider === "cpu") return true;
  return status.vram_free_mb != null && status.vram_free_mb < FEATURE_VRAM_MB[feature];
}

/** Result of timeline.apply-cuts: the saved project (undo = PUT the previous one). */
export interface ApplyCutsResult {
  project: Project;
  /** Timeline seconds removed from the clip (and rippled). */
  removedSec: number;
  /** Ids of the pieces the clip was split into (the first keeps the original id). */
  pieceIds: string[];
}
