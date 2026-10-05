import type { GpuFeature } from "@studio/shared";
import { runWithPack } from "@/stores/packs-store";
import type { AnyJobType } from "./ai-types";
import type { Accepted } from "./api";
import { warnIfCpu } from "./gpu-preflight";
import { waitForJob } from "./job-runner";

function acceptedId(value: unknown): string | undefined {
  const id = (value as { jobId?: unknown } | null | undefined)?.jobId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Run a Sprint 2 vision action: CPU pre-warning (as in sprint 1), PACK_REQUIRED → «Paquete
 * requerido» (the whole action is re-run after the download; resolves undefined meanwhile), and
 * the job is awaited. `onJob` receives the job id (progress lives in the jobs store).
 */
export async function runVisionJob<T>(
  start: () => Promise<Accepted<T>>,
  type: AnyJobType,
  opts: { gpu?: GpuFeature; onJob?: (jobId: string) => void } = {},
): Promise<T | undefined> {
  if (opts.gpu) void warnIfCpu(opts.gpu);
  return runWithPack(async () => {
    const res = await start();
    const jobId = acceptedId(res);
    if (!jobId) return res as T;
    opts.onJob?.(jobId);
    const job = await waitForJob(jobId, type);
    return job.result as T;
  });
}
