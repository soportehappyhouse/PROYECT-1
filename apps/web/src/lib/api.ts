import {
  API_ROUTES,
  ApiErrorSchema,
  buildRoute,
  type ApiError,
  type AppConfig,
  type CreateReportRequestInput,
  type CreateReportResponse,
  type JobDiagnostics,
  type ReportSummary,
  type VoiceEffectRequest,
  type CreateProject,
  type DashboardSettings,
  type ExportPreset,
  type ExportRequest,
  type HealthResponse,
  type Job,
  type JobAccepted,
  type JobEvent,
  type JobStatus,
  type JobType,
  type LibraryItem,
  type LibraryItemDetails,
  type LibraryScanResult,
  type LibrarySearchQuery,
  type MediaAsset,
  type ModelDownloadProgress,
  type ModelDownloadRequestInput,
  type ModelDownloadResult,
  type MotionEngineInfo,
  type MotionRenderRequestInput,
  type MotionRenderTarget,
  type MotionSpecInput,
  type MotionTemplateInfo,
  type Paginated,
  type Project,
  type RvcModel,
  type RvcRequest,
  type TranscribeRequest,
  type TtsRequestInput,
  type TtsVoiceInfo,
} from "@studio/shared";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";
import type { ApplyCutsResult } from "@studio/shared";
import {
  AI_ROUTES,
  type CutRange,
  type GpuStatus,
  type PackInfo,
  type PackRequiredInfo,
  type PerfResult,
  type SceneRange,
  type SilenceCut,
  type SilenceOptions,
} from "./ai-types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);

/** Every non-2xx answer (and network failures, status 0) becomes an ApiRequestError. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | undefined,
    message?: string,
    /** Unparsed JSON body (extra fields such as the PACK_REQUIRED info). */
    readonly raw?: unknown,
  ) {
    super(
      message ??
        body?.error.message ??
        rawMessage(raw) ??
        (status === 0 ? "Sin conexión con la API" : `HTTP ${status}`),
    );
    this.name = "ApiRequestError";
  }

  get code(): string | undefined {
    return this.body?.error.code ?? rawCode(this.raw);
  }
}

/** True when the endpoint exists in the contract but its module is not implemented yet (501). */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 501 || err.code === "NOT_IMPLEMENTED");
}

function rawMessage(raw: unknown): string | undefined {
  const m = (raw as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : undefined;
}

/** Code of a raw error body: `{error: {code}}` (ApiError) or `{error: "CODE"}` (PACK_REQUIRED). */
function rawCode(raw: unknown): string | undefined {
  const r = raw as { error?: unknown; code?: unknown } | null | undefined;
  if (typeof r?.error === "string") return r.error;
  if (typeof r?.code === "string") return r.code;
  return undefined;
}

/**
 * Pack info inside a PACK_REQUIRED body. The api answers `{error: "PACK_REQUIRED", packId,
 * name_es, size_bytes, message}` (route 409 and failed job `result`); `error.details` also works.
 */
export function packInfoFromBody(raw: unknown): PackRequiredInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const candidates = [(r.error as { details?: unknown } | undefined)?.details, r.error, r];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const packId = o.packId ?? o.pack_id;
    if (typeof packId !== "string") continue;
    return {
      packId,
      ...(typeof o.name_es === "string" && { name_es: o.name_es }),
      ...(typeof o.size_bytes === "number" && { size_bytes: o.size_bytes }),
      ...(typeof (o.message ?? r.message) === "string" && {
        message: (o.message ?? r.message) as string,
      }),
    };
  }
  return undefined;
}

/** True for `409 PACK_REQUIRED` (a model pack must be downloaded first). */
export function isPackRequired(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 409 && err.code === "PACK_REQUIRED";
}

/** Pack info of a PACK_REQUIRED error. */
export function packRequiredInfo(err: unknown): PackRequiredInfo | undefined {
  return isPackRequired(err) ? packInfoFromBody(err.raw) : undefined;
}

type PackRequiredListener = (info: PackRequiredInfo) => void;
const packRequiredListeners = new Set<PackRequiredListener>();

/** Every `409 PACK_REQUIRED` answer is announced here (the «Paquete requerido» dialog listens). */
export function onPackRequired(listener: PackRequiredListener): () => void {
  packRequiredListeners.add(listener);
  return () => packRequiredListeners.delete(listener);
}

/** True when the API could not be reached at all. */
export function isOffline(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 0;
}

/** Spanish, user-facing message for any error thrown by the client. */
export function errorMessage(err: unknown): string {
  if (isNotImplemented(err)) return "Módulo en desarrollo";
  if (isOffline(err)) return "No se pudo conectar con la API local (¿está iniciada en :3001?)";
  if (err instanceof Error) return err.message;
  return "Error desconocido";
}

type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;
  query?: Query;
  /** JSON body (serialized) — use `body` for FormData. */
  json?: unknown;
  body?: BodyInit;
}

export function apiUrl(route: string, params?: Record<string, string>, query?: Query): string {
  const url = `${API_URL}${buildRoute(route, params)}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

/** URL of a file under STORAGE_DIR served by GET /files/*. */
export function fileUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `${API_URL}/files/${clean}`;
}

/** Streaming URL of the original media (HTTP Range). */
export function mediaFileUrl(assetId: string): string {
  return apiUrl(API_ROUTES.mediaFile, { id: assetId });
}

/** Best URL to preview an asset: proxy when available, original otherwise. */
export function assetPreviewUrl(asset: Pick<MediaAsset, "id" | "proxyPath">): string {
  return asset.proxyPath ? fileUrl(asset.proxyPath) : mediaFileUrl(asset.id);
}

/** Breadcrumb for error reports: method + route template + status (never bodies). */
function recordApiError(method: string, route: string, err: ApiRequestError): ApiRequestError {
  addBreadcrumb(
    "api",
    `${method} ${route} → ${err.status === 0 ? "sin conexión" : err.status}: ${err.message}`,
    { method, route, status: err.status, ...(err.code && { code: err.code }) },
    `api:${method}:${route}:${err.status}`,
  );
  return err;
}

/** Typed fetch wrapper for the local API. */
export async function apiFetch<T>(route: string, options: RequestOptions = {}): Promise<T> {
  const { params, query, json, body, headers, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  let res: Response;
  try {
    res = await fetch(apiUrl(route, params, query), {
      ...rest,
      body: json !== undefined ? JSON.stringify(json) : body,
      headers: json !== undefined ? { "content-type": "application/json", ...headers } : headers,
    });
  } catch (err) {
    throw recordApiError(
      method,
      route,
      new ApiRequestError(0, undefined, err instanceof Error ? undefined : String(err)),
    );
  }
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => undefined);
    const parsed = ApiErrorSchema.safeParse(raw);
    const err = new ApiRequestError(
      res.status,
      parsed.success ? parsed.data : undefined,
      undefined,
      raw,
    );
    const pack = packRequiredInfo(err);
    if (pack) for (const listener of packRequiredListeners) listener(pack);
    throw recordApiError(method, route, err);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Multipart upload with progress (XHR, fetch has no upload progress). */
export function uploadFile<T>(
  route: string,
  file: File,
  onProgress?: (ratio: number) => void,
  field = "file",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(route));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(recordApiError("POST", route, new ApiRequestError(0, undefined)));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const parsed = ApiErrorSchema.safeParse(data);
        reject(
          recordApiError(
            "POST",
            route,
            new ApiRequestError(xhr.status, parsed.success ? parsed.data : undefined),
          ),
        );
      }
    };
    const form = new FormData();
    form.append(field, file, file.name);
    xhr.send(form);
  });
}

/** GET /api/motion/engines item; the contract (with `ok`, not `available`) lives in @studio/shared. */
export type MotionEngineStatus = MotionEngineInfo;

export interface LibraryProviderStatus {
  id: string;
  enabled: boolean;
}

export interface JobListQuery {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
}

/** One typed client for every route in API_ROUTES. */
export const api = {
  health: () => apiFetch<HealthResponse>(API_ROUTES.health),
  config: () => apiFetch<AppConfig>(API_ROUTES.config),

  getSettings: () => apiFetch<DashboardSettings>(API_ROUTES.settings),
  putSettings: (settings: DashboardSettings) =>
    apiFetch<DashboardSettings>(API_ROUTES.settings, { method: "PUT", json: settings }),

  listProjects: () => apiFetch<Project[]>(API_ROUTES.projects),
  createProject: (body: CreateProject) =>
    apiFetch<Project>(API_ROUTES.projects, { method: "POST", json: body }),
  getProject: (id: string) => apiFetch<Project>(API_ROUTES.project, { params: { id } }),
  saveProject: (project: Project) =>
    apiFetch<Project>(API_ROUTES.project, {
      method: "PUT",
      params: { id: project.id },
      json: project,
    }),
  deleteProject: (id: string) =>
    apiFetch<void>(API_ROUTES.project, { method: "DELETE", params: { id } }),
  exportProject: (id: string, body: ExportRequest) =>
    apiFetch<JobAccepted>(API_ROUTES.projectExport, { method: "POST", params: { id }, json: body }),

  listMedia: () => apiFetch<MediaAsset[]>(API_ROUTES.media),
  uploadMedia: (file: File, onProgress?: (ratio: number) => void) =>
    uploadFile<MediaAsset>(API_ROUTES.media, file, onProgress),
  getMedia: (id: string) => apiFetch<MediaAsset>(API_ROUTES.mediaItem, { params: { id } }),
  /** 409 MEDIA_IN_USE when a project uses it, unless `force` (feedback 11). */
  deleteMedia: (id: string, force = false) =>
    apiFetch<void>(API_ROUTES.mediaItem, {
      method: "DELETE",
      params: { id },
      ...(force && { query: { force: 1 } }),
    }),
  createProxy: (id: string) =>
    apiFetch<JobAccepted>(API_ROUTES.mediaProxy, { method: "POST", params: { id } }),

  listJobs: (query: JobListQuery = {}) => apiFetch<Job[]>(API_ROUTES.jobs, { query: { ...query } }),
  getJob: (id: string) => apiFetch<Job>(API_ROUTES.job, { params: { id } }),
  cancelJob: (id: string) =>
    apiFetch<Job>(API_ROUTES.jobCancel, { method: "POST", params: { id } }),
  jobEventsUrl: () => apiUrl(API_ROUTES.jobEvents),

  listExportPresets: () => apiFetch<ExportPreset[]>(API_ROUTES.exportPresets),
  createExportPreset: (preset: ExportPreset) =>
    apiFetch<ExportPreset>(API_ROUTES.exportPresets, { method: "POST", json: preset }),
  updateExportPreset: (preset: ExportPreset) =>
    apiFetch<ExportPreset>(API_ROUTES.exportPreset, {
      method: "PUT",
      params: { id: preset.id },
      json: preset,
    }),
  deleteExportPreset: (id: string) =>
    apiFetch<void>(API_ROUTES.exportPreset, { method: "DELETE", params: { id } }),

  motionEngines: () => apiFetch<MotionEngineStatus[]>(API_ROUTES.motionEngines),
  motionTemplates: () => apiFetch<MotionTemplateInfo[]>(API_ROUTES.motionTemplates),
  /** With `target`, the api links the render to that clip (`renderedAssetId`) in the saved project. */
  renderMotion: (spec: MotionSpecInput, target?: MotionRenderTarget) =>
    apiFetch<JobAccepted>(API_ROUTES.motionRender, {
      method: "POST",
      json: { ...spec, ...(target && { target }) } satisfies MotionRenderRequestInput,
    }),

  ttsVoices: () => apiFetch<TtsVoiceInfo[]>(API_ROUTES.ttsVoices),
  tts: (body: TtsRequestInput) =>
    apiFetch<JobAccepted>(API_ROUTES.tts, { method: "POST", json: body }),
  /** `format` is optional (api default: wav). */
  voiceEffects: (body: VoiceEffectRequest | Omit<VoiceEffectRequest, "format">) =>
    apiFetch<JobAccepted>(API_ROUTES.voiceEffects, { method: "POST", json: body }),
  /** Download a model through the workers (synchronous: resolves when the files are in place). */
  downloadModel: (body: ModelDownloadRequestInput) =>
    apiFetch<ModelDownloadResult>(API_ROUTES.voiceModelDownload, { method: "POST", json: body }),
  modelDownloadProgress: (id: string) =>
    apiFetch<ModelDownloadProgress>(API_ROUTES.voiceModelDownloadProgress, {
      query: { kind: "piper", id },
    }),
  rvcModels: () => apiFetch<RvcModel[]>(API_ROUTES.rvcModels),
  rvc: (body: Partial<RvcRequest> & Pick<RvcRequest, "assetId" | "modelId">) =>
    apiFetch<JobAccepted>(API_ROUTES.rvc, { method: "POST", json: body }),

  transcribe: (body: Partial<TranscribeRequest> & Pick<TranscribeRequest, "assetId">) =>
    apiFetch<JobAccepted>(API_ROUTES.transcribe, { method: "POST", json: body }),

  searchLibrary: (query: Partial<LibrarySearchQuery>) =>
    apiFetch<Paginated<LibraryItem>>(API_ROUTES.library, { query: { ...query } }),
  /** JSON import of an indexed/remote item -> MediaAsset ready for the timeline. */
  importLibraryItem: (provider: string, remoteId: string) =>
    apiFetch<MediaAsset>(API_ROUTES.libraryImport, {
      method: "POST",
      json: { provider, remoteId },
    }),
  /** Multipart upload of a file into storage/library -> indexed library item (not a MediaAsset). */
  uploadLibraryFile: (file: File, onProgress?: (ratio: number) => void) =>
    uploadFile<LibraryItemDetails>(API_ROUTES.libraryImport, file, onProgress),
  /** Re-index storage/library (new/changed/removed files). */
  scanLibrary: () => apiFetch<LibraryScanResult>(API_ROUTES.libraryScan, { method: "POST" }),
  libraryProviders: () => apiFetch<LibraryProviderStatus[]>(API_ROUTES.libraryProviders),

  jobDiagnostics: (id: string) =>
    apiFetch<JobDiagnostics>(API_ROUTES.jobDiagnostics, { params: { id } }),
  /** Build storage/reports/<id>/ + .zip (docs/REPORTAR-ERRORES.md). */
  createReport: (body: CreateReportRequestInput) =>
    apiFetch<CreateReportResponse>(API_ROUTES.reports, { method: "POST", json: body }),
  listReports: () => apiFetch<ReportSummary[]>(API_ROUTES.reports),
  reportDownloadUrl: (id: string) => apiUrl(API_ROUTES.reportDownload, { id }),
};

/** Some api routes answer a job id, others the result directly: both are accepted. */
export type Accepted<T> = JobAccepted | T;

/** Sprint 1 local-AI routes (docs/trabajo/sprint1-contratos.md). */
export const aiApi = {
  gpu: () => apiFetch<GpuStatus>(AI_ROUTES.gpu),
  releaseGpu: () => apiFetch<GpuStatus>(AI_ROUTES.gpuRelease, { method: "POST" }),
  packs: () => apiFetch<PackInfo[]>(AI_ROUTES.packs),
  /** Sequential in the workers; downloading an installed pack re-verifies its files. */
  downloadPack: (id: string) =>
    apiFetch<JobAccepted>(AI_ROUTES.packDownload, { method: "POST", params: { id } }),
  analyzeScenes: (assetId: string, opts: { threshold?: number; minSceneLenSec?: number } = {}) =>
    apiFetch<Accepted<{ scenes: SceneRange[] }>>(AI_ROUTES.analyzeScenes, {
      method: "POST",
      json: { assetId, ...opts },
    }),
  analyzeSilences: (body: { projectId: string; clipId: string; options: SilenceOptions }) =>
    apiFetch<Accepted<{ cuts: SilenceCut[] }>>(AI_ROUTES.analyzeSilences, {
      method: "POST",
      json: body,
    }),
  /** Cuts in source seconds (as analyze.silences returned them); result {project, removedSec}. */
  applyCuts: (body: { projectId: string; clipId: string; cuts: CutRange[] }) =>
    apiFetch<Accepted<ApplyCutsResult>>(AI_ROUTES.applyCuts, { method: "POST", json: body }),
  denoise: (assetId: string) =>
    apiFetch<JobAccepted>(AI_ROUTES.denoise, { method: "POST", json: { assetId } }),
  runPerf: () => apiFetch<Accepted<PerfResult>>(AI_ROUTES.perfRun, { method: "POST", json: {} }),
  lastPerf: () => apiFetch<PerfResult>(AI_ROUTES.perf),
};

export type { JobEvent };
