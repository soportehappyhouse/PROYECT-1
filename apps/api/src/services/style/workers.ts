import http from "node:http";
import {
  PACK_REQUIRED,
  WORKER_STYLE_ROUTES,
  WorkerStyleInferResponseSchema,
  buildRoute,
  type WorkerStyleAnalyzeRequest,
  type WorkerStyleInferResponse,
} from "@studio/shared";
import { z } from "zod";
import { currentDiagnostics } from "../../jobs/diagnostics.js";
import { packRequiredFromBody, WorkersError, workersDownMessage } from "../workers-client.js";

/**
 * Sprint 3b: the workers' /style/* routes. Kept apart from services/workers-client.ts (shared by
 * every module) so this module only touches its own files; same error contract (WorkersError,
 * PACK_REQUIRED body). Long calls go through node:http (no 300 s undici headers timeout: a vision
 * LLM on CPU can take minutes); cancellation only through `signal`.
 */
export interface StyleWorkers {
  analyze(req: WorkerStyleAnalyzeRequest): Promise<{ task_id: string }>;
  task(taskId: string, signal?: AbortSignal): Promise<StyleTask>;
  infer(
    req: { analysis_path: string; contact_sheet_path: string; model?: string },
    signal?: AbortSignal,
  ): Promise<WorkerStyleInferResponse>;
}

export const StyleTaskSchema = z.object({
  task_id: z.string(),
  status: z.enum(["queued", "running", "done", "error"]),
  progress: z.number().default(0),
  message: z.string().nullish(),
  error: z.string().nullish(),
  result: z.unknown().optional(),
});
export type StyleTask = z.infer<typeof StyleTaskSchema>;

function request(
  target: string,
  method: "GET" | "POST",
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      target,
      {
        method,
        ...(signal && { signal }),
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

export function createStyleWorkers(baseUrl: string): StyleWorkers {
  async function call<T>(
    method: "GET" | "POST",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: { status: number; text: string };
    try {
      res = await request(new URL(route, baseUrl).toString(), method, body, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      currentDiagnostics()?.stderrLine(
        `[workers] ${method} ${route}: sin conexión (${String(err)})`,
      );
      throw new WorkersError(workersDownMessage(baseUrl), 503, "WORKERS_UNAVAILABLE", undefined, {
        url: baseUrl,
      });
    }
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const o = (json ?? {}) as { detail?: unknown; code?: string };
      const message =
        typeof o.detail === "string"
          ? o.detail
          : o.detail !== undefined
            ? JSON.stringify(o.detail)
            : res.text.slice(0, 300) || `HTTP ${res.status}`;
      const pack = packRequiredFromBody(json);
      if (pack) throw new WorkersError(message, res.status, PACK_REQUIRED, pack);
      throw new WorkersError(message, res.status, o.code ?? `WORKERS_HTTP_${res.status}`);
    }
    return schema.parse(json);
  }
  return {
    analyze: (req) =>
      call("POST", WORKER_STYLE_ROUTES.analyze, z.object({ task_id: z.string() }), req),
    task: (id, signal) =>
      call("GET", buildRoute(WORKER_STYLE_ROUTES.task, { id }), StyleTaskSchema, undefined, signal),
    infer: (req, signal) =>
      call("POST", WORKER_STYLE_ROUTES.infer, WorkerStyleInferResponseSchema, req, signal),
  };
}
