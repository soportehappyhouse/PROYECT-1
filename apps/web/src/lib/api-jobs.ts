import { API_ROUTES, HealthResponseSchema, type HealthResponse, type Job } from "@studio/shared";
import { apiFetch, ApiRequestError, apiUrl } from "./api";

/**
 * Sprint 5 (M1) clients: jobs center and service status. Kept out of lib/api.ts (shared file).
 */

/** GET /api/health with a short timeout (the service-status-store polls it). */
export async function fetchHealth(timeoutMs = 4000): Promise<HealthResponse> {
  const res = await fetch(apiUrl(API_ROUTES.health), {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new ApiRequestError(res.status, undefined, `HTTP ${res.status}`);
  const raw: unknown = await res.json();
  const parsed = HealthResponseSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Older api without checkedAt: keep the fields we need.
  const r = raw as Partial<HealthResponse>;
  return {
    status: r.status ?? "degraded",
    version: r.version ?? "",
    ffmpeg: r.ffmpeg ?? { available: false },
    workers: r.workers ?? { reachable: false, url: "" },
    checkedAt: new Date().toISOString(),
  };
}

/** POST /api/jobs/:id/cancel (409 JOB_NOT_CANCELLABLE is thrown as ApiRequestError). */
export function cancelJob(id: string): Promise<Job> {
  return apiFetch<Job>(API_ROUTES.jobCancel, { method: "POST", params: { id } });
}

/** True when an api error means the local AI (workers) is down. */
export function isWorkersUnavailable(err: unknown): boolean {
  return err instanceof ApiRequestError && err.code === "WORKERS_UNAVAILABLE";
}
