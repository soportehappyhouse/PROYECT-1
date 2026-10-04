import {
  API_ROUTES,
  ApiErrorSchema,
  buildRoute,
  type ApiError,
  type AppConfig,
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
  type MotionEngineId,
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
  type TtsVoice,
} from "@studio/shared";

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
  ) {
    super(
      message ??
        body?.error.message ??
        (status === 0 ? "Sin conexión con la API" : `HTTP ${status}`),
    );
    this.name = "ApiRequestError";
  }

  get code(): string | undefined {
    return this.body?.error.code;
  }
}

/** True when the endpoint exists in the contract but its module is not implemented yet (501). */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 501 || err.code === "NOT_IMPLEMENTED");
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

/** Typed fetch wrapper for the local API. */
export async function apiFetch<T>(route: string, options: RequestOptions = {}): Promise<T> {
  const { params, query, json, body, headers, ...rest } = options;
  let res: Response;
  try {
    res = await fetch(apiUrl(route, params, query), {
      ...rest,
      body: json !== undefined ? JSON.stringify(json) : body,
      headers: json !== undefined ? { "content-type": "application/json", ...headers } : headers,
    });
  } catch (err) {
    throw new ApiRequestError(0, undefined, err instanceof Error ? undefined : String(err));
  }
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => undefined);
    const parsed = ApiErrorSchema.safeParse(raw);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data : undefined);
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
    xhr.onerror = () => reject(new ApiRequestError(0, undefined));
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
        reject(new ApiRequestError(xhr.status, parsed.success ? parsed.data : undefined));
      }
    };
    const form = new FormData();
    form.append(field, file, file.name);
    xhr.send(form);
  });
}

export interface MotionEngineStatus {
  id: MotionEngineId;
  displayName: string;
  available: boolean;
  reason?: string;
}

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
  deleteMedia: (id: string) =>
    apiFetch<void>(API_ROUTES.mediaItem, { method: "DELETE", params: { id } }),
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

  ttsVoices: () => apiFetch<TtsVoice[]>(API_ROUTES.ttsVoices),
  tts: (body: TtsRequestInput) =>
    apiFetch<JobAccepted>(API_ROUTES.tts, { method: "POST", json: body }),
  /** `format` is optional (api default: wav). */
  voiceEffects: (body: VoiceEffectRequest | Omit<VoiceEffectRequest, "format">) =>
    apiFetch<JobAccepted>(API_ROUTES.voiceEffects, { method: "POST", json: body }),
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
};

export type { JobEvent };
