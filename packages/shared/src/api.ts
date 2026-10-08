import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";
import { START_CMD_ES } from "./texts-es.js";
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
  // Sprint 3 (agent.ts): local command agent.
  agentPlan: "/api/agent/plan", // POST AgentPlanRequest -> AgentPlanRecord (validated + resolved)
  agentApply: "/api/agent/apply", // POST AgentApplyRequest -> JobAccepted (agent.apply)
  agentPlans: "/api/agent/plans", // GET AgentPlanRecord[] (newest first; ?projectId=&limit=)
  agentPlanReject: "/api/agent/plans/:id/reject", // POST -> AgentPlanRecord (status rejected)
  agentPlanUndo: "/api/agent/plans/:id/undo", // POST -> {project, plan} (restores the undo snapshot)
  agentStatus: "/api/agent/status", // GET AgentStatus (workers proxy + pack agent-llm)
  agentEval: "/api/agent/eval", // POST AgentEvalRequest -> JobAccepted (agent.eval) | GET last result
  agentBugreport: "/api/agent/bugreport", // POST AgentBugreportRequest -> AgentBugreportResponse
  // Sprint 4 (consent.ts, face.ts, voice.ts): Personas + consent, licences, face swap, «Voz propia».
  persons: "/api/persons", // GET ?scope=face|voice -> PersonSummary[] | POST PersonCreate -> 201 Person
  person: "/api/persons/:id", // GET Person | PATCH PersonPatch -> Person | DELETE ?confirm=1 -> 204
  personPhotos: "/api/persons/:id/photos", // POST multipart `photo` -> Person
  personPhoto: "/api/persons/:id/photos/:photoId", // GET image | DELETE -> Person
  personVoiceSamples: "/api/persons/:id/voice-samples", // POST multipart `audio` -> Person
  personVoiceSample: "/api/persons/:id/voice-samples/:sampleId", // GET audio | DELETE -> Person
  personConsents: "/api/persons/:id/consents", // POST multipart ConsentCreateFields + `evidence` -> 201 Consent
  personConsentRevoke: "/api/persons/:id/consents/:consentId/revoke", // POST -> Consent (revoked_at)
  personConsentEvidence: "/api/persons/:id/consents/:consentId/evidence", // GET evidence file
  personConsentsRevoke: "/api/persons/:id/consents/revoke", // POST ConsentRevokeScopeRequest -> Person (every non-revoked consent of the scope)
  personAudit: "/api/persons/:id/audit", // GET AuditEntry[] (web only, HUMAN_ONLY)
  aiLicences: "/api/ai/licences", // GET LicenceStatus[]
  aiLicenceAccept: "/api/ai/licences/:id/accept", // POST LicenceAcceptRequest -> LicenceAcceptance
  aiLicenceRevoke: "/api/ai/licences/:id/revoke", // POST -> LicenceAcceptance
  faceDetect: "/api/face/detect", // POST FaceDetectRequest -> FaceDetectResult (sync)
  facePreview: "/api/face/preview", // POST FacePreviewRequest -> 202 JobAccepted (face.preview)
  faceSwap: "/api/face/swap", // POST FaceSwapRequest -> 202 JobAccepted (face.swap)
  faceUndo: "/api/face/undo", // POST FaceUndoRequest -> Project
  // Sprint 5 (api.ts ProjectSummary/ProjectPatch/ProjectDuplicate, export.ts).
  // GET projects?view=summary -> ProjectSummary[] (without view: Project[]); PATCH project
  // ProjectPatch -> ProjectSummary.
  projectDuplicate: "/api/projects/:id/duplicate", // POST ProjectDuplicate -> 201 Project
  systemReveal: "/api/system/reveal", // POST {path} -> {ok} (only under exports/)
  voiceSelfRefs: "/api/voice/self-refs", // GET MediaAsset[] (voice-ref) | POST multipart `audio` + attestSelf=true -> 201 MediaAsset
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
  ttsCancel: "/tts/cancel", // POST {jobId} -> {canceled, stopped} (Chatterbox: kills the bridge, frees the GPU)
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

/**
 * Sprint 4 error codes (docs/trabajo/sprint4-contratos.md «Códigos de error nuevos»): HTTP status
 * and Spanish message template (`{placeholder}` filled by formatErrorEs). Bodies are ApiError
 * (`details` per consent.ts: ConsentRequiredDetails, LicenceRequiredDetails, ToolMissingDetails;
 * TOOL_FAILED: `{logTail}`); workers answer `{detail, code}`. PACK_REQUIRED (flat body) and
 * CONFIRM_REQUIRED already exist.
 */
export const SPRINT4_ERRORS = {
  /** Placeholders: nombre, alcance («cara» | «voz»), motivo (CONSENT_REASON_ES). */
  CONSENT_REQUIRED: {
    status: 403,
    message_es:
      "{nombre} no tiene un consentimiento vigente para usar su {alcance} ({motivo}). " +
      "Registralo en Ajustes → Personas.",
  },
  LICENCE_REQUIRED: {
    status: 403,
    message_es:
      "Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no comerciales + " +
      "OpenRAIL-AS) en pantalla: Ajustes → Paquetes de IA.",
  },
  HUMAN_ONLY: {
    status: 403,
    message_es:
      "Esto solo se hace desde la pantalla de Studio, no desde la consola ni el asistente.",
  },
  /** Placeholders: herramienta (TOOL_NAME_ES), estado (TOOL_STATE_ES); state "python": TOOL_MISSING_PYTHON_ES. */
  TOOL_MISSING: {
    status: 409,
    message_es:
      "El entorno aislado de {herramienta} no está listo ({estado}). Volvé a descargar el paquete " +
      "en Ajustes → Paquetes de IA o corré scripts\\windows\\setup.ps1 -Update.",
  },
  /** Placeholders: herramienta, log (last useful log line; full tail in `details.logTail`). */
  TOOL_FAILED: { status: 502, message_es: "{herramienta} terminó con error: {log}." },
  TEXT_OUTDATED: {
    status: 409,
    message_es: "El texto del consentimiento/licencia cambió: volvé a leerlo y aceptarlo.",
  },
  /** Placeholder: nombre. */
  VOICE_SAMPLE_MISSING: {
    status: 409,
    message_es: "{nombre} no tiene una muestra de voz (5 a 60 s).",
  },
  CONTENT_BLOCKED: {
    status: 422,
    message_es:
      "El analizador de contenido de FaceFusion bloqueó este video o imagen: no se procesa.",
  },
  /** Placeholder: donde («la foto» | «el fotograma elegido»). */
  NO_FACE: { status: 422, message_es: "No se encontró una cara en {donde}." },
  /** Placeholder: id (RVC model id). */
  RVC_MODEL_INCOMPATIBLE: {
    status: 422,
    message_es: "El modelo RVC «{id}» no se puede cargar de forma segura (formato incompatible).",
  },
  CLIP_TOO_LONG: {
    status: 400,
    message_es: "Se procesan tramos de hasta 10 min y 4K: dividí el clip.",
  },
  VOICE_SAMPLE_INVALID: {
    status: 400,
    message_es: "La muestra tiene que durar entre 5 y 60 s y tener voz.",
  },
  PERSON_NOT_FOUND: { status: 404, message_es: "No existe esa Persona." },
} as const satisfies Record<string, { status: number; message_es: string }>;
export type Sprint4ErrorCode = keyof typeof SPRINT4_ERRORS;

/**
 * Sprint 5 error codes (docs/trabajo/sprint5-contratos.md «Códigos de error nuevos»). Same shape
 * as SPRINT4_ERRORS; formatErrorEs fills the placeholders. PACK_REQUIRED and PROJECT_NOT_FOUND
 * already exist and keep their bodies.
 */
export const SPRINT5_ERRORS = {
  /** Existing code, new text. Placeholder: host («127.0.0.1:8001»); `details.url`. Raw cause only to logs. */
  WORKERS_UNAVAILABLE: {
    status: 503,
    message_es: `La IA local está apagada (no responde en {host}). Cerrá Studio y abrilo con ${START_CMD_ES}.`,
  },
  JOB_NOT_CANCELLABLE: {
    status: 409,
    message_es: "Este trabajo termina en segundos y no se puede cancelar.",
  },
  /** Workers. Placeholder: id. */
  TASK_NOT_FOUND: {
    status: 404,
    message_es: "La tarea {id} ya no existe en la IA local (¿se reinició?).",
  },
  /**
   * Placeholders: orientacion («horizontal» | «vertical»), preset (name), aspecto («9:16»…).
   * `details`: AspectChoiceRequiredDetails.
   */
  ASPECT_CHOICE_REQUIRED: {
    status: 409,
    message_es:
      "El video es {orientacion} y «{preset}» es {aspecto}: elegí cómo encuadrarlo (seguir la " +
      "cara, al centro o con franjas borrosas).",
  },
  REFRAME_REQUIRED: {
    status: 409,
    message_es: "Primero reencuadrá el video (Vista previa → Reencuadrar) o pedíselo al Asistente.",
  },
  REVEAL_OUTSIDE_EXPORTS: {
    status: 400,
    message_es: "Solo se pueden mostrar archivos de la carpeta de exportaciones.",
  },
} as const satisfies Record<string, { status: number; message_es: string }>;
export type Sprint5ErrorCode = keyof typeof SPRINT5_ERRORS;

/** `details` of 409 ASPECT_CHOICE_REQUIRED. */
export const AspectChoiceRequiredDetailsSchema = z.object({
  canvas: z.object({ w: z.number().int(), h: z.number().int() }),
  preset: z.object({ id: z.string(), w: z.number().int(), h: z.number().int() }),
  options: z.array(z.enum(["reframe", "center", "blur"])),
  reframeReady: z.boolean(),
});
export type AspectChoiceRequiredDetails = z.infer<typeof AspectChoiceRequiredDetailsSchema>;

/** Sprint 5 job warnings (ExportJobResult.warnings): the job still succeeds. */
export const SPRINT5_WARNINGS = {
  /** Placeholder: causa. */
  LOUDNESS_MEASURE_FAILED: {
    message_es: "No se pudo medir la sonoridad de la mezcla ({causa}); se exportó sin normalizar.",
  },
} as const satisfies Record<string, { message_es: string }>;
export type Sprint5WarningCode = keyof typeof SPRINT5_WARNINGS;

const ERROR_MESSAGES_ES: Record<string, { message_es: string }> = {
  ...SPRINT5_WARNINGS,
  ...SPRINT5_ERRORS,
};

/** TOOL_MISSING message when the state is "python" (FaceFusion needs Python 3.12). */
export const TOOL_MISSING_PYTHON_ES =
  "Falta Python 3.12: corré scripts\\windows\\setup.ps1 -Update.";

/**
 * Spanish message of a Sprint 4/5 error (or Sprint 5 warning) code with its `{placeholders}`
 * replaced (unknown ones stay).
 */
export function formatErrorEs(
  code: Sprint4ErrorCode | Sprint5ErrorCode | Sprint5WarningCode,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const entry =
    (SPRINT4_ERRORS as Record<string, { message_es: string }>)[code] ?? ERROR_MESSAGES_ES[code]!;
  return entry.message_es.replace(/\{([a-z_]+)\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m,
  );
}

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  ffmpeg: z.object({ available: z.boolean(), version: z.string().optional() }),
  workers: z.object({
    reachable: z.boolean(),
    url: z.string(),
    /** Sprint 5: from the workers /health (timeout 1.5 s). */
    version: z.string().optional(),
    cuda: z.boolean().optional(),
  }),
  /** Sprint 5: when the api checked (web service-status-store). */
  checkedAt: TimestampSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Sprint 5: state of the web service-status-store (M1). */
export const ServiceStateSchema = z.object({
  api: z.enum(["up", "down"]),
  workers: z.enum(["up", "down", "unknown"]),
  since: TimestampSchema,
});
export type ServiceState = z.infer<typeof ServiceStateSchema>;

/** Sprint 5: GET /api/projects?view=summary item (thumbnail of the first video clip's asset). */
export const ProjectSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  durationS: z.number().nonnegative(),
  width: z.number().int(),
  height: z.number().int(),
  clips: z.number().int().nonnegative(),
  thumbnailPath: z.string().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** Sprint 5: PATCH /api/projects/:id (rename). */
export const ProjectPatchSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

/** Sprint 5: POST /api/projects/:id/duplicate (absent name = «{nombre} (copia)»). */
export const ProjectDuplicateSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional() })
  .strict();
export type ProjectDuplicate = z.infer<typeof ProjectDuplicateSchema>;

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
