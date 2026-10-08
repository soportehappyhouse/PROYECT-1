import {
  AgentWorkerStatusSchema,
  BugreportResponseSchema,
  WORKER_AGENT_ROUTES,
  WORKER_STEMS_ROUTES,
  type WorkerStemsRequest,
  WorkerAgentPlanResponseSchema,
  type AgentWorkerStatus,
  type BugreportResponse,
  type WorkerAgentPlanRequest,
  type WorkerAgentPlanResponse,
  type WorkerBugreportRequest,
  buildRoute,
  GpuStatusSchema,
  ModelDownloadResultSchema,
  PACK_REQUIRED,
  PackSchema,
  PackTaskSchema,
  SceneListSchema,
  SilenceCutsSchema,
  WORKER_AI_ROUTES,
  WorkerTaskAcceptedSchema,
  VisionTaskSchema,
  WorkerSamPointsResultSchema,
  WorkerSamSessionSchema,
  type BBox,
  type SamPoint,
  type VisionTask,
  type WorkerSamSession,
  type GpuStatus,
  type Pack,
  type PackRequiredBody,
  type PackTask,
  type SceneList,
  type SilenceCuts,
  type WorkerTaskAccepted,
  RvcModelSchema,
  TranscriptWithFilesSchema,
  TtsProviderInfoSchema,
  TtsVoiceInfoSchema,
  WORKER_ROUTES,
  WorkerHealthSchema,
  WorkerJobProgressSchema,
  type ModelDownloadRequest,
  type ModelDownloadResult,
  type RvcModel,
  type TranscriptWithFiles,
  type TtsProviderInfo,
  type TtsVoiceInfo,
  type WorkerHealth,
  type WorkerJobProgress,
  type WorkerRvcRequest,
  type WorkerTranscribeRequest,
  type WorkerTtsRequest,
  type WorkerChatterboxFields,
  WorkerTtsResultSchema,
  type WorkerTtsResult,
  START_CMD_ES,
  WORKER_TASK_ROUTES,
  WORKER_TRANSCRIBE_CANCEL,
  WorkerTaskCancelSchema,
  WorkerTaskSchema,
  WorkerTaskStatusSchema,
  workerTaskCancelRoute,
  type WorkerTask,
  type WorkerTaskArea,
  type WorkerTaskCancel,
} from "@studio/shared";
import http from "node:http";
import { z } from "zod";
import { currentDiagnostics } from "../jobs/diagnostics.js";
import { hideConsentPaths } from "../lib/consent-paths.js";

/**
 * Sprint 5 (H4): Spanish text of WORKERS_UNAVAILABLE. The raw cause (`TypeError: fetch failed`,
 * `ECONNREFUSED`) goes only to the job log/diagnostics, never to the user.
 */
export function workersDownMessage(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep the raw value
  }
  return `La IA local está apagada (no responde en ${host}). Cerrá Studio y abrilo con ${START_CMD_ES}.`;
}

/**
 * VisionTask keeping the Sprint 5 fields (done/total/stage_es/cancellable) and accepting the
 * `canceled` status (pollers treat it as an abort).
 */
const LooseVisionTaskSchema = VisionTaskSchema.extend({ status: WorkerTaskStatusSchema })
  .loose()
  .transform((t) => t as unknown as VisionTask);

/** PackTask keeping the Sprint 5 fields (see LooseVisionTaskSchema). */
const LoosePackTaskSchema = PackTaskSchema.extend({ status: WorkerTaskStatusSchema })
  .loose()
  .transform((t) => t as unknown as PackTask);

/** Options for long synchronous worker calls. */
export interface WorkerCallOptions {
  signal?: AbortSignal;
  /**
   * Called with worker-side progress (0..1) while the call runs. Requires `jobId` in the request:
   * the client polls GET /jobs/:jobId on the workers every `pollMs`.
   */
  onProgress?: (progress: number, message?: string) => void;
  pollMs?: number;
  /**
   * Long calls (node:http) have no timeout by default (0 = none): a CPU synthesis of 5000
   * characters can take long. > 0 aborts the call after that many ms.
   */
  timeoutMs?: number;
}

/** Worker request bodies (shared contract, incl. the optional jobId/outputBase/provider/format). */
export type TranscribeCall = WorkerTranscribeRequest;
/** Piper / cloud body, or Chatterbox with its Sprint 4 fields (one `/tts` call for all). */
export type TtsCall = WorkerTtsRequest & WorkerChatterboxFields;
export type RvcCall = WorkerRvcRequest;

const DenoiseResultSchema = z.object({
  path: z.string(),
  warnings: z.array(z.string()).optional(),
});

/** Workers POST /analyze/silences body (snake_case, contract). Times in source seconds. */
export interface WorkerSilencesRequest {
  path: string;
  min_silence_ms?: number;
  noise_db?: number;
  padding_ms?: number;
  fillers?: boolean;
  transcript?: { words: { w: string; s: number; e: number }[] };
  /** Whisper VAD when the workers transcribe (no transcript sent); workers default false. */
  vad?: boolean;
}

const RvcResultSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative().nullish(),
  sampleRate: z.number().int().nullish(),
  device: z.string().nullish(),
  warnings: z.array(z.string()).nullish(),
});

const MatteImageResultSchema = z.object({
  path: z.string(),
  warnings: z.array(z.string()).optional(),
});

/** Workers POST /vision/matte body (snake_case contract, paths relative to STORAGE_DIR). */
export interface WorkerMatteRequest {
  path: string;
  model: "rvm" | "birefnet";
  output_base: string;
  downsample?: number;
  chunk_frames?: number;
  /** Sprint 3b: fast (mobilenetv3) | high (resnet50 + refinement, pack matting-hq). */
  quality?: "fast" | "high";
  refine?: {
    erode?: number;
    feather?: number;
    despill?: boolean;
    temporal?: number;
    mask_dilate?: number;
  };
  /** SAM mask guide (STORAGE_DIR-relative PNG or folder of %05d.png). */
  mask_path?: string;
}

/** Workers POST /vision/track body: `bbox` (fractions of the source) or `mask_png` (path). */
export interface WorkerTrackRequest {
  path: string;
  bbox?: BBox;
  mask_png?: string;
  method: "sam2" | "csrt";
  frame_range?: [number, number];
}

/** Workers POST /vision/reframe body. `scenes` in source seconds. */
export interface WorkerReframeRequest {
  path: string;
  target: "9:16" | "1:1" | "4:5";
  subject: "face" | "track";
  scenes?: { start: number; end: number }[];
  track_path?: string;
}

/** HTTP client for apps/workers (FastAPI). All paths are relative to STORAGE_DIR. */
export interface WorkersClient {
  health(): Promise<WorkerHealth | undefined>;
  transcribe(req: TranscribeCall, opts?: WorkerCallOptions): Promise<TranscriptWithFiles>;
  ttsVoices(): Promise<TtsVoiceInfo[]>;
  ttsProviders(): Promise<TtsProviderInfo[]>;
  /** POST /tts (Piper, cloud, Chatterbox): WorkerTtsResult keeps device/warnings/rtf/model. */
  tts(req: TtsCall, opts?: WorkerCallOptions): Promise<WorkerTtsResult>;
  /** POST /tts/cancel: stops a running Chatterbox synthesis of `jobId` (kills the bridge). */
  ttsCancel(jobId: string): Promise<unknown>;
  rvcModels(): Promise<RvcModel[]>;
  rvcConvert(req: RvcCall, opts?: WorkerCallOptions): Promise<z.infer<typeof RvcResultSchema>>;
  downloadModel(req: ModelDownloadRequest, opts?: WorkerCallOptions): Promise<ModelDownloadResult>;
  jobProgress(jobId: string): Promise<WorkerJobProgress | undefined>;
  // ---- Sprint 1 (WORKER_AI_ROUTES) ----
  gpuStatus(): Promise<GpuStatus>;
  gpuRelease(): Promise<unknown>;
  packs(): Promise<Pack[]>;
  packDownload(packId: string): Promise<WorkerTaskAccepted>;
  packTask(taskId: string, signal?: AbortSignal): Promise<PackTask>;
  /** GET /perf/tasks/{id}: the perf test task (same shape as a pack task). */
  perfTask(taskId: string, signal?: AbortSignal): Promise<PackTask>;
  analyzeScenes(
    req: { path: string; threshold?: number; min_scene_len_s?: number },
    opts?: WorkerCallOptions,
  ): Promise<SceneList>;
  analyzeSilences(req: WorkerSilencesRequest, opts?: WorkerCallOptions): Promise<SilenceCuts>;
  audioDenoise(
    req: { path: string; output_base: string },
    opts?: WorkerCallOptions,
  ): Promise<z.infer<typeof DenoiseResultSchema>>;
  /** Sprint 4: `face_source_path` (gate.benchFaceSource) and accepted `licences` for FaceFusion. */
  perfRun(body?: {
    face_source_path?: string;
    face_consent_id?: string;
    licences?: string[];
  }): Promise<WorkerTaskAccepted>;
  // ---- Sprint 2 (vision) ----
  visionMatte(req: WorkerMatteRequest): Promise<WorkerTaskAccepted>;
  visionMatteImage(
    req: { path: string; output_base: string },
    opts?: WorkerCallOptions,
  ): Promise<z.infer<typeof MatteImageResultSchema>>;
  /** GET /vision/tasks/{id}. */
  visionTask(taskId: string, signal?: AbortSignal): Promise<VisionTask>;
  samSession(
    req: { path: string; frame_range?: [number, number] },
    opts?: WorkerCallOptions,
  ): Promise<WorkerSamSession>;
  samPoints(
    sessionId: string,
    req: { frame: number; points: SamPoint[]; obj_id: number },
    opts?: WorkerCallOptions,
  ): Promise<z.infer<typeof WorkerSamPointsResultSchema>>;
  samPropagate(sessionId: string, req: { chunk_frames?: number }): Promise<WorkerTaskAccepted>;
  samDelete(sessionId: string): Promise<unknown>;
  visionTrack(req: WorkerTrackRequest): Promise<WorkerTaskAccepted>;
  visionReframe(req: WorkerReframeRequest): Promise<WorkerTaskAccepted>;
  // ---- Sprint 3 (WORKER_AGENT_ROUTES) ----
  agentStatus(): Promise<AgentWorkerStatus>;
  /** LLM call: no timeout besides `signal` (a cold 8B model can take a minute to load). */
  agentPlan(req: WorkerAgentPlanRequest, signal?: AbortSignal): Promise<WorkerAgentPlanResponse>;
  agentBugreport(req: WorkerBugreportRequest, signal?: AbortSignal): Promise<BugreportResponse>;
  agentEval(req: {
    models?: string[];
    dataset?: string;
    mode?: "quick" | "full";
  }): Promise<WorkerTaskAccepted>;
  // ---- Sprint 5 (M1): generic task polling and cancellation ----
  /** GET /<area>/tasks/{id} parsed as WorkerTask (done/total/stage_es/eta_s). */
  workerTask(area: WorkerTaskArea, taskId: string, signal?: AbortSignal): Promise<WorkerTask>;
  /** POST /<area>/tasks/{id}/cancel (timeout 3 s); undefined when it failed (ignored). */
  cancelWorkerTask(area: WorkerTaskArea, taskId: string): Promise<WorkerTaskCancel | undefined>;
  /** POST /transcribe/cancel {job_id} -> {stopped} (timeout 3 s; false when it failed). */
  transcribeCancel(jobId: string): Promise<boolean>;
  // ---- Sprint 3b (WORKER_STEMS_ROUTES) ----
  /** POST /audio/stems (Demucs htdemucs, pack stems) -> {task_id}; 409 PACK_REQUIRED first. */
  audioStems(req: WorkerStemsRequest): Promise<WorkerTaskAccepted>;
  /** GET /audio/tasks/{id} (VisionTask shape; result = WorkerStemsResult). */
  audioTask(taskId: string, signal?: AbortSignal): Promise<VisionTask>;
}

/**
 * Find a PACK_REQUIRED payload in a workers error body: top level, in FastAPI's `detail`, or in an
 * `error` object; `code` or `error` may carry the marker and ids may be camel or snake case.
 */
export function packRequiredFromBody(json: unknown): PackRequiredBody | undefined {
  const candidates: unknown[] = [json];
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    candidates.push(o.detail, o.error, (o.error as Record<string, unknown> | undefined)?.details);
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (o.error !== PACK_REQUIRED && o.code !== PACK_REQUIRED) continue;
    const details = (o.details && typeof o.details === "object" ? o.details : o) as Record<
      string,
      unknown
    >;
    const packId = details.packId ?? details.pack_id ?? o.packId ?? o.pack_id;
    if (typeof packId !== "string") continue;
    const name = details.name_es ?? details.nameEs ?? o.name_es;
    const size = Number(details.size_bytes ?? details.sizeBytes ?? o.size_bytes ?? 0);
    return {
      error: PACK_REQUIRED,
      packId,
      name_es: typeof name === "string" ? name : packId,
      size_bytes: Number.isFinite(size) ? size : 0,
    };
  }
  return undefined;
}

/** Non-2xx answer (or network failure) from the workers service. */
export class WorkersError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    /** Set when the workers answered PACK_REQUIRED (code is then "PACK_REQUIRED"). */
    readonly packRequired?: PackRequiredBody,
    /** `details` of a coded workers error (TOOL_FAILED logTail, CONSENT_REQUIRED reason…). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkersError";
  }
}

const SHORT_TIMEOUT_MS = 10_000;

/** Python serializes `None` as null; the shared zod schemas use optional (undefined) fields. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [[k, stripNulls(v)]])),
    );
  return value;
}

async function fetchText(
  target: string,
  method: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  const res = await fetch(target, {
    method,
    signal,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Long synchronous calls (transcription, RVC on CPU, model downloads) can take far longer than
 * undici's 300 s headers timeout used by global fetch, so they go through node:http, which has no
 * default timeout. Cancellation is driven only by `signal`.
 */
function rawRequest(
  target: string,
  method: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      target,
      {
        method,
        signal,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createWorkersClient(baseUrl: string): WorkersClient {
  const url = (route: string) => new URL(route, baseUrl).toString();

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
    long = false,
    timeoutMs = 0,
  ): Promise<T> {
    let res: { status: number; text: string };
    // Only POST calls are recorded: GET progress polling would flood the job diagnostics. Paths
    // under consent/ (Person photos / voice samples) are never written there (audit fix 22).
    const diag = method !== "GET" ? currentDiagnostics() : undefined;
    const record = diag?.command(
      "http",
      hideConsentPaths(
        `${method} ${url(route)}${body === undefined ? "" : ` ${JSON.stringify(body).slice(0, 2000)}`}`,
      ),
    );
    if (long && timeoutMs > 0) {
      const timeout = AbortSignal.timeout(timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    try {
      res = long
        ? await rawRequest(url(route), method, body, signal)
        : await fetchText(
            url(route),
            method,
            body,
            signal ?? AbortSignal.timeout(SHORT_TIMEOUT_MS),
          );
    } catch (err) {
      record?.end(null, String(err));
      if (signal?.aborted) throw err;
      diag?.stderrLine(`[workers] ${method} ${route}: sin conexión (${String(err)})`);
      throw new WorkersError(workersDownMessage(baseUrl), 503, "WORKERS_UNAVAILABLE", undefined, {
        url: baseUrl,
      });
    }
    let json: unknown = undefined;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    record?.end(res.status);
    if (res.status < 200 || res.status >= 300) {
      // FastAPI error bodies (detail + traceback when available) are the worker-side "stderr".
      diag?.stderrLine(
        hideConsentPaths(
          `[workers] HTTP ${res.status} ${method} ${route}: ${res.text.slice(0, 4000)}`,
        ),
      );
      const detail =
        (json as { detail?: unknown; code?: string; details?: unknown } | undefined) ?? {};
      const message =
        typeof detail.detail === "string"
          ? detail.detail
          : detail.detail !== undefined
            ? JSON.stringify(detail.detail)
            : res.text.slice(0, 300) || `HTTP ${res.status}`;
      const pack = packRequiredFromBody(json);
      if (pack) throw new WorkersError(message, res.status, PACK_REQUIRED, pack);
      throw new WorkersError(
        message,
        res.status,
        detail.code ?? `WORKERS_HTTP_${res.status}`,
        undefined,
        detail.details,
      );
    }
    return schema.parse(stripNulls(json));
  }

  async function withProgress<T>(
    jobId: string | undefined,
    opts: WorkerCallOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!jobId || !opts?.onProgress) return run();
    const onProgress = opts.onProgress;
    let last = -1;
    const timer = setInterval(() => {
      void client.jobProgress(jobId).then((p) => {
        if (p && p.status === "running" && p.progress !== last) {
          last = p.progress;
          onProgress(p.progress, p.message ?? undefined);
        }
      });
    }, opts.pollMs ?? 1000);
    try {
      return await run();
    } finally {
      clearInterval(timer);
    }
  }

  const client: WorkersClient = {
    async health() {
      try {
        const res = await fetch(url(WORKER_ROUTES.health), { signal: AbortSignal.timeout(1500) });
        return res.ok ? WorkerHealthSchema.parse(await res.json()) : undefined;
      } catch {
        return undefined;
      }
    },
    transcribe: (req, opts) =>
      withProgress(req.jobId, opts, () =>
        call("POST", WORKER_ROUTES.transcribe, TranscriptWithFilesSchema, req, opts?.signal, true),
      ),
    ttsVoices: () => call("GET", WORKER_ROUTES.ttsVoices, z.array(TtsVoiceInfoSchema)),
    ttsProviders: () => call("GET", WORKER_ROUTES.ttsProviders, z.array(TtsProviderInfoSchema)),
    tts: (req, opts) =>
      withProgress(req.jobId, opts, () =>
        call(
          "POST",
          WORKER_ROUTES.tts,
          WorkerTtsResultSchema,
          req,
          opts?.signal,
          true,
          opts?.timeoutMs ?? 0,
        ),
      ),
    ttsCancel: (jobId) => call("POST", WORKER_ROUTES.ttsCancel, z.unknown(), { jobId }),
    rvcModels: () =>
      call(
        "GET",
        WORKER_ROUTES.rvcModels,
        z.array(RvcModelSchema.extend({ indexPath: z.string().nullish() })),
      ).then((models) =>
        models.map(({ indexPath, ...m }) => (indexPath ? { ...m, indexPath } : m)),
      ),
    rvcConvert: (req, opts) =>
      withProgress(req.jobId, opts, () =>
        call("POST", WORKER_ROUTES.rvcConvert, RvcResultSchema, req, opts?.signal, true),
      ),
    downloadModel: (req, opts) =>
      call(
        "POST",
        WORKER_ROUTES.modelsDownload,
        ModelDownloadResultSchema,
        req,
        opts?.signal,
        true,
      ),
    gpuStatus: () => call("GET", WORKER_AI_ROUTES.gpuStatus, GpuStatusSchema),
    gpuRelease: () => call("POST", WORKER_AI_ROUTES.gpuRelease, z.unknown()),
    packs: () => call("GET", WORKER_AI_ROUTES.packs, z.array(PackSchema)),
    packDownload: (packId) =>
      call(
        "POST",
        buildRoute(WORKER_AI_ROUTES.packDownload, { id: packId }),
        WorkerTaskAcceptedSchema,
        {},
      ),
    packTask: (taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_AI_ROUTES.packTask, { id: taskId }),
        LoosePackTaskSchema,
        undefined,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]) : undefined,
      ),
    perfTask: (taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_AI_ROUTES.perfTask, { id: taskId }),
        LoosePackTaskSchema,
        undefined,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]) : undefined,
      ),
    analyzeScenes: (req, opts) =>
      call("POST", WORKER_AI_ROUTES.analyzeScenes, SceneListSchema, req, opts?.signal, true),
    analyzeSilences: (req, opts) =>
      call("POST", WORKER_AI_ROUTES.analyzeSilences, SilenceCutsSchema, req, opts?.signal, true),
    audioDenoise: (req, opts) =>
      call("POST", WORKER_AI_ROUTES.audioDenoise, DenoiseResultSchema, req, opts?.signal, true),
    perfRun: (body = {}) => call("POST", WORKER_AI_ROUTES.perfRun, WorkerTaskAcceptedSchema, body),
    visionMatte: (req) =>
      call("POST", WORKER_AI_ROUTES.visionMatte, WorkerTaskAcceptedSchema, req, undefined, true),
    visionMatteImage: (req, opts) =>
      call(
        "POST",
        WORKER_AI_ROUTES.visionMatteImage,
        MatteImageResultSchema,
        req,
        opts?.signal,
        true,
      ),
    visionTask: (taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_AI_ROUTES.visionTask, { id: taskId }),
        LooseVisionTaskSchema,
        undefined,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]) : undefined,
      ),
    samSession: (req, opts) =>
      call("POST", WORKER_AI_ROUTES.samSession, WorkerSamSessionSchema, req, opts?.signal, true),
    samPoints: (sessionId, req, opts) =>
      call(
        "POST",
        buildRoute(WORKER_AI_ROUTES.samPoints, { id: sessionId }),
        WorkerSamPointsResultSchema,
        req,
        opts?.signal,
        true,
      ),
    samPropagate: (sessionId, req) =>
      call(
        "POST",
        buildRoute(WORKER_AI_ROUTES.samPropagate, { id: sessionId }),
        WorkerTaskAcceptedSchema,
        req,
        undefined,
        true,
      ),
    samDelete: (sessionId) =>
      call("DELETE", buildRoute(WORKER_AI_ROUTES.samSessionItem, { id: sessionId }), z.unknown()),
    visionTrack: (req) =>
      call("POST", WORKER_AI_ROUTES.visionTrack, WorkerTaskAcceptedSchema, req, undefined, true),
    visionReframe: (req) =>
      call("POST", WORKER_AI_ROUTES.visionReframe, WorkerTaskAcceptedSchema, req, undefined, true),
    agentStatus: () => call("GET", WORKER_AGENT_ROUTES.status, AgentWorkerStatusSchema),
    agentPlan: (req, signal) =>
      call("POST", WORKER_AGENT_ROUTES.plan, WorkerAgentPlanResponseSchema, req, signal, true),
    agentBugreport: (req, signal) =>
      call("POST", WORKER_AGENT_ROUTES.bugreport, BugreportResponseSchema, req, signal, true),
    agentEval: (req) =>
      call("POST", WORKER_AGENT_ROUTES.evaluate, WorkerTaskAcceptedSchema, req, undefined, true),
    workerTask: (area, taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_TASK_ROUTES[area], { id: taskId }),
        WorkerTaskSchema,
        undefined,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]) : undefined,
      ),
    async cancelWorkerTask(area, taskId) {
      try {
        return await call(
          "POST",
          buildRoute(workerTaskCancelRoute(area), { id: taskId }),
          WorkerTaskCancelSchema,
          {},
          AbortSignal.timeout(3000),
        );
      } catch {
        return undefined;
      }
    },
    async transcribeCancel(jobId) {
      try {
        const r = await call(
          "POST",
          WORKER_TRANSCRIBE_CANCEL,
          z.object({ stopped: z.boolean() }),
          { job_id: jobId },
          AbortSignal.timeout(3000),
        );
        return r.stopped;
      } catch {
        return false;
      }
    },
    audioStems: (req) =>
      call("POST", WORKER_STEMS_ROUTES.stems, WorkerTaskAcceptedSchema, req, undefined, true),
    audioTask: (taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_STEMS_ROUTES.task, { id: taskId }),
        LooseVisionTaskSchema,
        undefined,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]) : undefined,
      ),
    async jobProgress(jobId) {
      try {
        return await call(
          "GET",
          buildRoute(WORKER_ROUTES.jobProgress, { id: jobId }),
          WorkerJobProgressSchema,
        );
      } catch {
        return undefined;
      }
    },
  };
  return client;
}
