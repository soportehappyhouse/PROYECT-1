import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  TMP_SUBDIR,
  type JobProgressDetail,
  type JobProgressUnit,
  type WorkerTask,
  type WorkerTaskArea,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import type { MediaAsset } from "@studio/shared";
import { resolveStoragePath } from "../../services/storage.js";
import { WorkersError, type WorkersClient } from "../../services/workers-client.js";
import { isAbortError } from "../state.js";
import type { JobContext } from "../types.js";

export function requireAsset(app: AppContext, id: string): MediaAsset {
  const asset = app.repos.media.get(id);
  if (!asset) throw new Error(`Asset ${id} no encontrado`);
  return asset;
}

export function absPath(app: AppContext, relative: string): string {
  return resolveStoragePath(app.config.storageDir, relative);
}

/** Per-job scratch dir storage/tmp/<jobId> (ffmpeg cwd); removed by the returned cleanup. */
export async function jobTmpDir(
  app: AppContext,
  jobId: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = path.join(app.config.storageDir, TMP_SUBDIR, jobId);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function fileSize(abs: string): Promise<number> {
  return (await stat(abs)).size;
}

/** Run an optional step: abort propagates; other errors are logged and swallowed. */
export async function optionalStep<T>(
  ctx: JobContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isAbortError(err) || ctx.signal.aborted) throw err;
    ctx.log(`${label} falló: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Throw AbortError if the job was canceled. */
export function checkAborted(ctx: JobContext): void {
  if (ctx.signal.aborted) throw Object.assign(new Error("Cancelado"), { name: "AbortError" });
}

// ---- Sprint 5 (M1): worker tasks with real progress and cancellation -------------------------

/**
 * When the job is canceled, also cancel the worker task (POST /<area>/tasks/{id}/cancel, 3 s,
 * errors ignored) so the GPU/Ollama stop working. Returns the disposer of the listener.
 */
export function cancelWorkerTaskOnAbort(
  workers: Pick<WorkersClient, "cancelWorkerTask">,
  area: WorkerTaskArea,
  taskId: string,
  ctx: Pick<JobContext, "signal" | "log">,
): () => void {
  const onAbort = () => {
    ctx.log(`Cancelando la tarea ${taskId} en los workers (${area})`);
    void workers.cancelWorkerTask(area, taskId).catch(() => undefined);
  };
  if (ctx.signal.aborted) {
    onAbort();
    return () => undefined;
  }
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  return () => ctx.signal.removeEventListener("abort", onAbort);
}

/** Like workerTaskDetail for task shapes parsed with older schemas (VisionTask, PackTask). */
export function looseTaskDetail(
  task: unknown,
  unit: JobProgressUnit = "items",
): Partial<JobProgressDetail> {
  const t = (task ?? {}) as Record<string, unknown>;
  return workerTaskDetail(
    {
      done: typeof t.done === "number" ? t.done : null,
      total: typeof t.total === "number" ? t.total : null,
      stage_es: typeof t.stage_es === "string" ? t.stage_es : null,
      cancellable: t.cancellable === false ? false : true,
    },
    unit,
  );
}

/** Progress fields of a worker task for `ctx.reportProgress(…, detail)`. */
export function workerTaskDetail(
  task: Pick<WorkerTask, "done" | "total" | "stage_es" | "cancellable">,
  unit: JobProgressUnit = "items",
): Partial<JobProgressDetail> {
  const hasItems = typeof task.total === "number" && task.total > 0;
  return {
    ...(hasItems && typeof task.done === "number" && { done: task.done, total: task.total!, unit }),
    ...(task.stage_es && { stage_es: task.stage_es }),
    ...(task.cancellable === false && { cancellable: false }),
  };
}

export interface PollWorkerTaskOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** Consecutive failed polls tolerated (workers restarting), default 10. */
  maxFailures?: number;
  /** Map the task to the job progress bar (default: from + p × (to − from)). */
  from?: number;
  to?: number;
  unit?: JobProgressUnit;
  /** Message for the Jobs panel (default: stage_es or current_file). */
  message?: (task: WorkerTask) => string | undefined;
  /** Called on every poll (after reportProgress). */
  onTask?: (task: WorkerTask) => void;
}

/** Error of a worker task that ended in `error` (keeps its `code`, e.g. PACK_REQUIRED). */
export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly task: WorkerTask,
  ) {
    super(message);
    this.name = "WorkerTaskError";
  }
}

/**
 * Poll GET /<area>/tasks/{id} every `pollMs` (1 s) → ctx.reportProgress(progress, stage, detail).
 * When ctx.signal aborts: POST …/cancel (3 s, ignored) and throw AbortError. `status:"error"` →
 * WorkerTaskError with `task.code`; `canceled` (canceled elsewhere) → AbortError.
 */
export async function pollWorkerTask(
  workers: Pick<WorkersClient, "workerTask" | "cancelWorkerTask">,
  area: WorkerTaskArea,
  taskId: string,
  ctx: JobContext,
  o: PollWorkerTaskOptions = {},
): Promise<WorkerTask> {
  const dispose = cancelWorkerTaskOnAbort(workers, area, taskId, ctx);
  const t0 = Date.now();
  const from = o.from ?? 0;
  const to = o.to ?? 1;
  let failures = 0;
  try {
    for (;;) {
      checkAborted(ctx);
      let task: WorkerTask | undefined;
      try {
        task = await workers.workerTask(area, taskId, ctx.signal);
        failures = 0;
      } catch (err) {
        checkAborted(ctx);
        if (err instanceof WorkersError && err.statusCode === 404) throw err;
        if (++failures >= (o.maxFailures ?? 10)) throw err;
      }
      if (task) {
        const message = o.message?.(task) ?? task.stage_es ?? task.current_file ?? undefined;
        ctx.reportProgress(
          from + Math.min(1, Math.max(0, task.progress)) * (to - from),
          message ?? undefined,
          workerTaskDetail(task, o.unit),
        );
        o.onTask?.(task);
        if (task.status === "done") return task;
        if (task.status === "canceled")
          throw Object.assign(new Error("Cancelado"), { name: "AbortError" });
        if (task.status === "error")
          throw new WorkerTaskError(
            task.error ?? task.message ?? "error desconocido en la IA local",
            task.code ?? undefined,
            task,
          );
      }
      if (Date.now() - t0 > (o.timeoutMs ?? 4 * 3600_000))
        throw new Error("La tarea de la IA local no terminó a tiempo");
      await abortableSleep(o.pollMs ?? 1000, ctx.signal);
    }
  } finally {
    dispose();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Cancelado"), { name: "AbortError" }));
    if (signal.aborted) return abort();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
