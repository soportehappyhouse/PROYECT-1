import {
  buildRoute,
  ModelDownloadResultSchema,
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
} from "@studio/shared";
import http from "node:http";
import { z } from "zod";

/** Options for long synchronous worker calls. */
export interface WorkerCallOptions {
  signal?: AbortSignal;
  /**
   * Called with worker-side progress (0..1) while the call runs. Requires `jobId` in the request:
   * the client polls GET /jobs/:jobId on the workers every `pollMs`.
   */
  onProgress?: (progress: number, message?: string) => void;
  pollMs?: number;
}

/** Worker request bodies (shared contract, incl. the optional jobId/outputBase/provider/format). */
export type TranscribeCall = WorkerTranscribeRequest;
export type TtsCall = WorkerTtsRequest;
export type RvcCall = WorkerRvcRequest;

const TtsResultSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative(),
  wavPath: z.string().nullish(),
  sampleRate: z.number().int().nullish(),
});
const RvcResultSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative().nullish(),
  sampleRate: z.number().int().nullish(),
  device: z.string().nullish(),
});

/** HTTP client for apps/workers (FastAPI). All paths are relative to STORAGE_DIR. */
export interface WorkersClient {
  health(): Promise<WorkerHealth | undefined>;
  transcribe(req: TranscribeCall, opts?: WorkerCallOptions): Promise<TranscriptWithFiles>;
  ttsVoices(): Promise<TtsVoiceInfo[]>;
  ttsProviders(): Promise<TtsProviderInfo[]>;
  tts(req: TtsCall, opts?: WorkerCallOptions): Promise<z.infer<typeof TtsResultSchema>>;
  rvcModels(): Promise<RvcModel[]>;
  rvcConvert(req: RvcCall, opts?: WorkerCallOptions): Promise<z.infer<typeof RvcResultSchema>>;
  downloadModel(req: ModelDownloadRequest, opts?: WorkerCallOptions): Promise<ModelDownloadResult>;
  jobProgress(jobId: string): Promise<WorkerJobProgress | undefined>;
}

/** Non-2xx answer (or network failure) from the workers service. */
export class WorkersError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
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
    method: "GET" | "POST",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
    long = false,
  ): Promise<T> {
    let res: { status: number; text: string };
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
      if (signal?.aborted) throw err;
      throw new WorkersError(
        `Workers Python no disponibles en ${baseUrl} (¿está corriendo start.ps1?): ${String(err)}`,
        503,
        "WORKERS_UNAVAILABLE",
      );
    }
    let json: unknown = undefined;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = (json as { detail?: unknown; code?: string } | undefined) ?? {};
      const message =
        typeof detail.detail === "string"
          ? detail.detail
          : detail.detail !== undefined
            ? JSON.stringify(detail.detail)
            : res.text.slice(0, 300) || `HTTP ${res.status}`;
      throw new WorkersError(message, res.status, detail.code ?? `WORKERS_HTTP_${res.status}`);
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
        const res = await fetch(url(WORKER_ROUTES.health), { signal: AbortSignal.timeout(2000) });
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
        call("POST", WORKER_ROUTES.tts, TtsResultSchema, req, opts?.signal, true),
      ),
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
