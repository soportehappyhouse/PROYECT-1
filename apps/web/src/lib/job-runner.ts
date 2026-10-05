import type { Job } from "@studio/shared";
import { isTerminal, useJobsStore, type JobIntent } from "@/stores/jobs-store";
import type { AnyJobType } from "./ai-types";
import { api, ApiRequestError, packInfoFromBody, type Accepted } from "./api";

const POLL_MS = 2_000;

/** Error of a job that ended failed/canceled (message = job.error, Spanish from the api). */
export class JobFailedError extends Error {
  constructor(readonly job: Job) {
    super(job.error ?? job.message ?? (job.status === "canceled" ? "Cancelado" : "Falló"));
    this.name = "JobFailedError";
  }
}

/**
 * Track a job and resolve with its full record once it succeeds (SSE through the jobs store, plus
 * a slow GET poll in case the stream is down). Rejects with JobFailedError otherwise.
 */
export function waitForJob(
  jobId: string,
  type: AnyJobType,
  intent: JobIntent = { kind: "await" },
): Promise<Job> {
  const store = useJobsStore;
  store.getState().track(jobId, type, intent);
  return new Promise<Job>((resolve, reject) => {
    let done = false;
    const finish = (job: Job) => {
      if (done || !isTerminal(job)) return;
      done = true;
      unsubscribe();
      clearInterval(timer);
      // SSE events carry no `result`: read the full job once.
      void api
        .getJob(jobId)
        .catch(() => job)
        .then((full) => {
          store.getState().upsertJob(full);
          if (full.status === "succeeded") return resolve(full);
          // A job that needed a model pack fails with the PACK_REQUIRED body as `result`: surface
          // it as the same 409 the routes answer, so runWithPack opens «Paquete requerido».
          if (packInfoFromBody(full.result))
            return reject(new ApiRequestError(409, undefined, full.error, full.result));
          reject(new JobFailedError(full));
        });
    };
    const unsubscribe = store.subscribe((s) => {
      const job = s.jobs[jobId];
      if (job) finish(job);
    });
    const timer = setInterval(() => {
      void api
        .getJob(jobId)
        .then((job) => {
          if (!done && isTerminal(job)) {
            store.getState().upsertJob(job);
            finish(job);
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
  });
}

function isAccepted(value: unknown): value is { jobId: string } {
  return (
    !!value && typeof value === "object" && typeof (value as { jobId?: unknown }).jobId === "string"
  );
}

/** Run an api call that answers either `{jobId}` (then wait for the job) or the result itself. */
export async function runJob<T>(start: () => Promise<Accepted<T>>, type: AnyJobType): Promise<T> {
  const res = await start();
  if (!isAccepted(res)) return res;
  const job = await waitForJob(res.jobId, type);
  return job.result as T;
}
