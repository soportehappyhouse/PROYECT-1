import { WORKER_FACE_ROUTES, buildRoute, type FaceDetectResult } from "@studio/shared";
import { z } from "zod";
import { currentDiagnostics } from "../../jobs/diagnostics.js";
import { HttpError, PackRequiredError } from "../../lib/errors.js";
import { packRequiredFromBody, workersDownMessage } from "../workers-client.js";

/**
 * Client of the workers face routes (WORKER_FACE_ROUTES, snake_case, studio_workers/face): kept
 * here instead of services/workers-client.ts (shared file) so the M1 module owns it. Errors keep
 * the workers code: PACK_REQUIRED -> PackRequiredError (flat 409 body), {detail, code, details}
 * -> HttpError with the same status/code (CONSENT/LICENCE_REQUIRED, CONTENT_BLOCKED, TOOL_*...).
 * Request bodies are never recorded in the job diagnostics: they carry storage/consent/ paths.
 */

export interface WorkerFaceSelector {
  mode: "reference" | "one";
  t?: number;
  face_index?: number;
  distance?: number;
}

/** POST /face/swap (FaceSwapWorkerRequest in studio_workers/face/schemas.py). */
export interface WorkerFaceSwapRequest {
  source_paths: string[];
  target_path: string;
  output_base: string;
  range?: [number, number];
  preview_t?: number;
  selector: WorkerFaceSelector;
  model: string;
  enhancer: boolean;
  enhancer_blend: number;
  strength: number;
  consent_id: string;
  licence_ids: "faceswap"[];
}

export const WorkerFaceTaskResultSchema = z.object({
  output_path: z.string(),
  before_path: z.string().nullish(),
  frames: z.number().int().nonnegative().default(0),
  fps: z.number().nonnegative().default(0),
  proc_fps: z.number().nonnegative().default(0),
  device: z.enum(["cuda", "cpu"]).default("cpu"),
  model: z.string().default(""),
  timings: z.record(z.string(), z.number()).default({}),
  warnings: z.array(z.string()).default([]),
  log_tail: z.array(z.string()).default([]),
});
export type WorkerFaceTaskResult = z.infer<typeof WorkerFaceTaskResultSchema>;

export const WorkerFaceTaskSchema = z.object({
  task_id: z.string().optional(),
  status: z.enum(["queued", "running", "done", "error"]),
  progress: z.number().default(0),
  message: z.string().nullish(),
  error: z.string().nullish(),
  code: z.string().nullish(),
  details: z.unknown().optional(),
  result: z.unknown().optional(),
});
export type WorkerFaceTask = z.infer<typeof WorkerFaceTaskSchema>;

const DetectSchema = z.object({
  t: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  frame_path: z.string(),
  faces: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      score: z.number(),
    }),
  ),
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface FaceWorkers {
  detect(path: string, t: number, signal?: AbortSignal): Promise<FaceDetectResult>;
  swap(req: WorkerFaceSwapRequest, signal?: AbortSignal): Promise<{ task_id: string }>;
  task(taskId: string, signal?: AbortSignal): Promise<WorkerFaceTask>;
  cancel(taskId: string): Promise<void>;
}

/** Workers error body -> PackRequiredError | HttpError (status/code of the workers). */
export function faceWorkersError(status: number, json: unknown, text: string): Error {
  const pack = packRequiredFromBody(json);
  if (pack) return new PackRequiredError(pack.packId, pack.name_es, pack.size_bytes);
  const body = (json ?? {}) as { detail?: unknown; code?: unknown; details?: unknown };
  const message =
    typeof body.detail === "string"
      ? body.detail
      : body.detail !== undefined
        ? JSON.stringify(body.detail)
        : text.slice(0, 300) || `HTTP ${status}`;
  const code = typeof body.code === "string" ? body.code : `WORKERS_HTTP_${status}`;
  return new HttpError(status >= 400 ? status : 502, code, message, body.details);
}

export function createFaceWorkers(baseUrl: string): FaceWorkers {
  const url = (route: string) => new URL(route, baseUrl).toString();
  async function call<T>(
    method: "GET" | "POST",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
    label?: string,
  ): Promise<T> {
    const record =
      method === "POST"
        ? currentDiagnostics()?.command("http", `${method} ${url(route)} ${label ?? ""}`.trim())
        : undefined;
    let res: Response;
    try {
      res = await fetch(url(route), {
        method,
        signal: signal ?? AbortSignal.timeout(30_000),
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    } catch (err) {
      record?.end(null, String(err));
      if (signal?.aborted) throw err;
      currentDiagnostics()?.stderrLine(
        `[workers] ${method} ${route}: sin conexión (${String(err)})`,
      );
      throw new HttpError(503, "WORKERS_UNAVAILABLE", workersDownMessage(baseUrl), {
        url: baseUrl,
      });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    record?.end(res.status);
    if (!res.ok) throw faceWorkersError(res.status, json, text);
    return schema.parse(json);
  }

  return {
    async detect(path, t, signal) {
      const r = await call("POST", WORKER_FACE_ROUTES.detect, DetectSchema, { path, t }, signal);
      return {
        t: r.t,
        width: r.width,
        height: r.height,
        framePath: r.frame_path,
        faces: r.faces.map((f) => ({
          index: f.index,
          score: f.score,
          box: {
            x: clamp01(f.box.x),
            y: clamp01(f.box.y),
            w: clamp01(f.box.w),
            h: clamp01(f.box.h),
          },
        })),
      };
    },
    swap: (req, signal) =>
      call(
        "POST",
        WORKER_FACE_ROUTES.swap,
        z.object({ task_id: z.string() }),
        req,
        signal,
        `(${req.preview_t !== undefined ? "vista previa" : "video"}, ${req.source_paths.length} foto(s) de la Persona, modelo ${req.model})`,
      ),
    task: (taskId, signal) =>
      call(
        "GET",
        buildRoute(WORKER_FACE_ROUTES.task, { id: taskId }),
        WorkerFaceTaskSchema,
        undefined,
        signal,
      ),
    async cancel(taskId) {
      await call(
        "POST",
        buildRoute(WORKER_FACE_ROUTES.cancel, { id: taskId }),
        z.unknown(),
        {},
      ).catch(() => undefined);
    },
  };
}
