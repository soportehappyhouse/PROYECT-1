import {
  WorkerSuggestAnalyzeRequestSchema,
  type WorkerSuggestAnalyzeRequest,
  type WorkerTask,
  type WorkerTaskCancel,
} from "@studio/shared";
import type { WorkersClient } from "../workers-client.js";
import { WorkersError, workersDownMessage } from "../workers-client.js";

/**
 * Sprint 6 M3: POST /analyze/suggest of the workers (kept apart from services/workers-client.ts,
 * shared by every module). Polling and cancel use the generic WORKER_TASK_ROUTES (area analyze).
 */
export interface SuggestWorkers extends Pick<WorkersClient, "workerTask" | "cancelWorkerTask"> {
  suggest(req: WorkerSuggestAnalyzeRequest, signal?: AbortSignal): Promise<{ task_id: string }>;
}

export function createSuggestWorkers(
  baseUrl: string,
  client: Pick<WorkersClient, "workerTask" | "cancelWorkerTask">,
): SuggestWorkers {
  return {
    async suggest(req, signal) {
      const body = WorkerSuggestAnalyzeRequestSchema.parse(req);
      let res: Response;
      try {
        res = await fetch(new URL("/analyze/suggest", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new WorkersError(workersDownMessage(baseUrl), 503, "WORKERS_UNAVAILABLE", undefined, {
          url: baseUrl,
        });
      }
      const text = await res.text();
      let json: { task_id?: unknown; detail?: unknown; code?: unknown } = {};
      try {
        json = text ? (JSON.parse(text) as typeof json) : {};
      } catch {
        json = {};
      }
      if (!res.ok || typeof json.task_id !== "string")
        throw new WorkersError(
          typeof json.detail === "string" ? json.detail : `HTTP ${res.status}`,
          res.status,
          typeof json.code === "string" ? json.code : `WORKERS_HTTP_${res.status}`,
        );
      return { task_id: json.task_id };
    },
    workerTask: (area, taskId, signal): Promise<WorkerTask> =>
      client.workerTask(area, taskId, signal),
    cancelWorkerTask: (area, taskId): Promise<WorkerTaskCancel | undefined> =>
      client.cancelWorkerTask(area, taskId),
  };
}
