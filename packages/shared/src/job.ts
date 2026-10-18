import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";

/**
 * Job lifecycle:
 *   queued -> running -> succeeded | failed
 *   queued | running -> canceled (POST /api/jobs/:id/cancel)
 * Progress is 0..1 and only meaningful while running.
 */
export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "canceled"];

/** Every long-running operation is a job. Handler owner in parentheses. */
export const JobTypeSchema = z.enum([
  "media.probe", // (api/ffmpeg) ffprobe metadata
  "media.proxy", // (api/ffmpeg) low-res proxy + thumbnail + waveform
  "motion.render", // (motion-engines) render MotionSpec to storage/renders
  "voice.tts", // (workers /tts or cloud provider)
  "voice.effect", // (api/ffmpeg) audio filter chain
  "voice.rvc", // (workers /rvc/convert)
  "subtitles.transcribe", // (workers /transcribe)
  "project.export", // (api/ffmpeg) final timeline render with ExportPreset
  "packs.download", // (workers /packs/{id}/download + polling /packs/tasks/{id})
  "analyze.scenes", // (workers /analyze/scenes) stores scenes on the asset
  "analyze.silences", // (workers /analyze/silences) proposes cuts, never applies them
  "timeline.apply-cuts", // (api) split a clip, remove ranges, ripple; returns the saved project
  "audio.denoise", // (workers /audio/denoise) new audio asset
  "perf.run", // (workers /perf/run) AI performance test -> storage/run/perf.json
  "vision.matte", // (workers /vision/matte | /vision/matte-image) alpha asset (+ clip.matte)
  "vision.mask", // (workers /vision/sam/session/{id}/propagate) mask/track/alpha assets
  "vision.track", // (workers /vision/track) asset kind "track" (+ clip.trackRef)
  "vision.reframe", // (workers /vision/reframe) project.reframe
  "timeline.track-to-keyframes", // (api) clip.trackRef -> clip.keyframes.position
  "agent.apply", // (api) runs a confirmed EditPlan op by op (sub-jobs), undo snapshot
  "agent.eval", // (workers /agent/eval) model evaluation -> storage/run/agent-eval.json
  "audio.stems", // (workers /audio/stems + /audio/tasks/{id}) stem assets (+ tracks, undo snapshot)
  "style.analyze", // (workers /style/analyze) StyleAnalysis JSON + contact sheet -> asset "analysis"
  "style.infer", // (workers /style/infer, Ollama qwen2.5vl:3b) StylePreset draft from an analysis
  "face.preview", // (workers /face/swap with preview_t) before/after PNGs of one frame
  "face.swap", // (workers /face/swap + /face/tasks/{id}) face-swapped video asset (+ clip.faceSwap)
]);
export type JobType = z.infer<typeof JobTypeSchema>;

/** Sprint 5: unit of `JobProgressDetail.done/total`. */
export const JobProgressUnitSchema = z.enum([
  "items",
  "blocks",
  "frames",
  "seconds",
  "bytes",
  "commands",
]);
export type JobProgressUnit = z.infer<typeof JobProgressUnitSchema>;

/**
 * Sprint 5: one progress contract for every job (in `Job.detail` and in every SSE event).
 * `progress` (0..1) stays the bar; this adds counts, ETA, stage text and cancellability.
 */
export const JobProgressDetailSchema = z.object({
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  unit: JobProgressUnitSchema.optional(),
  /** How many of `done` were skipped from a cache (export blocks): left out of the ETA rate. */
  cached: z.number().int().nonnegative().optional(),
  /** null = «calculando…». */
  eta_s: z.number().nonnegative().nullable().optional(),
  /** «qwen3:8b · 17/80», «Bloque 3 de 12», «Midiendo sonoridad». */
  stage_es: z.string().max(120).optional(),
  cancellable: z.boolean().default(true),
  /** No progress change for >= JOB_STALL_S. */
  stalled: z.boolean().optional(),
  /** Last progress change. */
  progressAt: TimestampSchema.optional(),
});
export type JobProgressDetail = z.infer<typeof JobProgressDetailSchema>;

/** ETA by progress fraction only after this many seconds... */
export const JOB_ETA_MIN_ELAPSED_S = 10;
/** ...and with at least this progress. */
export const JOB_ETA_MIN_PROGRESS = 0.02;
/** Seconds without progress change before `stalled = true`. */
export const JOB_STALL_S = 120;

export const JobSchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(1).default(0),
  /** Human-readable current step (Spanish, shown in Jobs panel). */
  message: z.string().optional(),
  projectId: IdSchema.optional(),
  /** Validated request payload (schema depends on type). */
  payload: z.unknown(),
  /** Result on success, e.g. { assetId, path }. */
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** Sprint 5: machine code of the failure (ApiError/WorkersError code), e.g. PACK_REQUIRED. */
  errorCode: z.string().optional(),
  /** Sprint 5: progress detail (counts, ETA, stage, cancellable). */
  detail: JobProgressDetailSchema.optional(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

/** Standard success result for jobs that produce a file. */
export const FileJobResultSchema = z.object({
  assetId: IdSchema.optional(),
  /** Relative to STORAGE_DIR. */
  path: z.string(),
});
export type FileJobResult = z.infer<typeof FileJobResultSchema>;

/** Server-sent event payload on GET /api/jobs/:id/events and GET /api/jobs/events. */
export const JobEventSchema = z.object({
  jobId: IdSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(1),
  message: z.string().optional(),
  /** Sprint 5: full error text and code when status is failed. */
  error: z.string().optional(),
  errorCode: z.string().optional(),
  detail: JobProgressDetailSchema.optional(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

/** Response for any endpoint that enqueues work. */
export const JobAcceptedSchema = z.object({ jobId: IdSchema });
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;
