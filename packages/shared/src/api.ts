import { z } from "zod";

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
  motionEngines: "/api/motion/engines", // GET [{id, available}]
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
} as const;

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
