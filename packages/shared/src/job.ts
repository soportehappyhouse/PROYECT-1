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
]);
export type JobType = z.infer<typeof JobTypeSchema>;

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
});
export type JobEvent = z.infer<typeof JobEventSchema>;

/** Response for any endpoint that enqueues work. */
export const JobAcceptedSchema = z.object({ jobId: IdSchema });
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;
