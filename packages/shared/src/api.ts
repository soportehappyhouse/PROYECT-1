import { z } from "zod";
import type { TtsProvider } from "./voice.js";

/** Default local ports (overridable via .env). */
export const DEFAULT_PORTS = { web: 3000, api: 3001, workers: 8001 } as const;

/**
 * REST contract exposed by apps/api (prefix /api). `:id` params are path params.
 * Owner module in brackets: (b) api, (c) motion, (d) workers-backed.
 */
export const API_ROUTES = {
  health: "/api/health", // GET
  config: "/api/config", // GET  public feature flags (never secrets)
  settings: "/api/settings", // GET | PUT  DashboardSettings
  projects: "/api/projects", // GET | POST
  project: "/api/projects/:id", // GET | PUT | DELETE
  projectExport: "/api/projects/:id/export", // POST ExportRequest -> JobAccepted
  media: "/api/media", // GET list | POST multipart upload
  mediaItem: "/api/media/:id", // GET | DELETE
  mediaFile: "/api/media/:id/file", // GET stream original (Range support)
  mediaProxy: "/api/media/:id/proxy", // POST -> JobAccepted
  jobs: "/api/jobs", // GET list (?status=&type=)
  job: "/api/jobs/:id", // GET
  jobCancel: "/api/jobs/:id/cancel", // POST
  jobEvents: "/api/jobs/events", // GET SSE stream of JobEvent (all jobs)
  exportPresets: "/api/export-presets", // GET | POST
  exportPreset: "/api/export-presets/:id", // PUT | DELETE
  motionEngines: "/api/motion/engines", // GET MotionEngineInfo[] ({id, displayName, ok, reason})
  motionTemplates: "/api/motion/templates", // GET MotionTemplateInfo[]
  motionRender: "/api/motion/render", // POST MotionSpec -> JobAccepted
  ttsVoices: "/api/voice/tts/voices", // GET TtsVoice[]
  tts: "/api/voice/tts", // POST TtsRequest -> JobAccepted
  voiceEffects: "/api/voice/effects", // POST VoiceEffectRequest -> JobAccepted
  rvcModels: "/api/voice/rvc/models", // GET RvcModel[]
  rvc: "/api/voice/rvc", // POST RvcRequest -> JobAccepted
  transcribe: "/api/subtitles/transcribe", // POST TranscribeRequest -> JobAccepted
  library: "/api/library", // GET LibrarySearchQuery -> Paginated<LibraryItem>
  libraryImport: "/api/library/import", // POST multipart or {provider, remoteId}
  libraryProviders: "/api/library/providers", // GET [{id, enabled}]
  libraryScan: "/api/library/scan", // POST -> LibraryScanResult (re-index storage/library)
  libraryItem: "/api/library/:id", // GET | PATCH LibraryItemUpdate | DELETE (local item)
  libraryPeaks: "/api/library/:id/peaks", // GET WaveformPeaks of a local library item
  projectAutosave: "/api/projects/:id/autosave", // GET latest snapshot | PUT Project -> ProjectAutosaveInfo
  jobLog: "/api/jobs/:id/log", // GET { lines: string[] } (last stderr/log lines)
  systemEncoders: "/api/system/encoders", // GET EncoderInfo (detected H.264 encoders)
  voiceEffectPresets: "/api/voice/effects/presets", // GET named voice effect presets
  ttsProviders: "/api/voice/tts/providers", // GET TtsProviderInfo[]
  voiceModelDownload: "/api/voice/models/download", // POST ModelDownloadRequest -> ModelDownloadResult
  voiceModelDownloadProgress: "/api/voice/models/download/progress", // GET ?kind=piper&id= -> ModelDownloadProgress
  jobDiagnostics: "/api/jobs/:id/diagnostics", // GET JobDiagnostics (commands, stderr tail, timings)
  reports: "/api/reports", // GET ReportSummary[] | POST CreateReportRequest -> CreateReportResponse
  reportDownload: "/api/reports/:id/download", // GET the report .zip
  aiGpu: "/api/ai/gpu", // GET GpuStatus (proxy of workers /gpu/status)
  aiGpuRelease: "/api/ai/gpu/release", // POST -> GpuStatus after releasing the resident model
  aiPacks: "/api/ai/packs", // GET Pack[]
  aiPackDownload: "/api/ai/packs/:id/download", // POST -> JobAccepted (job packs.download)
  aiAnalyzeScenes: "/api/ai/analyze/scenes", // POST AnalyzeScenesRequest -> JobAccepted
  aiAnalyzeSilences: "/api/ai/analyze/silences", // POST AnalyzeSilencesRequest -> JobAccepted
  aiApplyCuts: "/api/ai/timeline/apply-cuts", // POST ApplyCutsRequest -> JobAccepted
  aiDenoise: "/api/ai/audio/denoise", // POST DenoiseRequest -> JobAccepted
  aiPerf: "/api/ai/perf", // GET last PerfResult (404 = never ran) | POST -> JobAccepted (perf.run)
  aiPerfRun: "/api/ai/perf/run", // POST -> JobAccepted (perf.run), alias of POST aiPerf
  aiVisionMatte: "/api/ai/vision/matte", // POST VisionMatteRequest -> JobAccepted (vision.matte)
  aiVisionSamSession: "/api/ai/vision/sam/session", // POST SamSessionRequest -> SamSessionResponse
  aiVisionSamPoints: "/api/ai/vision/sam/session/:id/points", // POST SamPointsRequest -> SamPointsResponse
  aiVisionSamPropagate: "/api/ai/vision/sam/session/:id/propagate", // POST SamPropagateRequest -> JobAccepted (vision.mask)
  aiVisionSamSessionItem: "/api/ai/vision/sam/session/:id", // DELETE -> {deleted: boolean} (false: unknown/expired)
  aiVisionTrack: "/api/ai/vision/track", // POST VisionTrackRequest -> JobAccepted (vision.track)
  aiVisionReframe: "/api/ai/vision/reframe", // POST VisionReframeRequest -> JobAccepted (vision.reframe)
  aiTrackToKeyframes: "/api/ai/timeline/track-to-keyframes", // POST TrackToKeyframesRequest -> JobAccepted
  files: "/files/*", // GET static files from STORAGE_DIR (renders/exports/proxies)
} as const;
export type ApiRouteKey = keyof typeof API_ROUTES;

/**
 * Internal contract exposed by apps/workers (Python, FastAPI). Only the api calls these.
 * All file paths are RELATIVE to STORAGE_DIR.
 */
export const WORKER_ROUTES = {
  health: "/health", // GET WorkerHealth
  transcribe: "/transcribe", // POST {inputPath, language, model, wordTimestamps} -> Transcript
  ttsVoices: "/tts/voices", // GET TtsVoice[]
  tts: "/tts", // POST {text, voice, speed, outputPath} -> {path, durationSec}
  rvcModels: "/rvc/models", // GET RvcModel[]
  rvcConvert: "/rvc/convert", // POST {inputPath, modelId, pitchShift, indexRate, f0Method, device, outputPath} -> {path}
  ttsProviders: "/tts/providers", // GET TtsProviderInfo[]
  modelsDownload: "/models/download", // POST ModelDownloadRequest -> ModelDownloadResult
  jobProgress: "/jobs/:id", // GET WorkerJobProgress for calls sent with the same `jobId`
} as const;

/**
 * Optional fields shared by the long worker calls (transcribe / tts / rvc/convert):
 * `jobId` enables progress polling (GET /jobs/:id) and names the worker-side job.
 */
export interface WorkerCallFields {
  jobId?: string;
}

/** POST /transcribe body. `outputBase` ("renders/<jobId>") writes .json/.srt/.ass side by side. */
export interface WorkerTranscribeRequest extends WorkerCallFields {
  inputPath: string;
  language: string;
  model?: string;
  wordTimestamps: boolean;
  outputBase?: string;
  /** Whisper VAD filter (workers default true). */
  vad?: boolean;
}

/** POST /tts body. `provider` defaults to piper; `format` to wav. */
export interface WorkerTtsRequest extends WorkerCallFields {
  text: string;
  voice: string;
  speed: number;
  outputPath: string;
  provider?: TtsProvider;
  format?: "wav" | "mp3";
}

/** POST /rvc/convert body. */
export interface WorkerRvcRequest extends WorkerCallFields {
  inputPath: string;
  modelId: string;
  pitchShift: number;
  indexRate: number;
  f0Method: string;
  device?: string;
  outputPath: string;
}

/** Uniform error body for every non-2xx response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
  workers: z.object({ reachable: z.boolean(), url: z.string() }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const WorkerHealthSchema = z.object({
  status: z.literal("ok"),
  cuda: z.boolean(),
  capabilities: z.object({
    whisper: z.boolean(),
    piper: z.boolean(),
    rvc: z.boolean(),
  }),
});
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

/** Public, non-secret configuration exposed to the dashboard. */
export const AppConfigSchema = z.object({
  useCuda: z.boolean(),
  providers: z.object({
    elevenlabs: z.boolean(),
    openai: z.boolean(),
    anthropic: z.boolean(),
    freesound: z.boolean(),
    pixabay: z.boolean(),
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });
}
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Replace `:param` placeholders in an API route. */
export function buildRoute(route: string, params: Record<string, string> = {}): string {
  return route.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing route param "${key}" for ${route}`);
    return encodeURIComponent(value);
  });
}
