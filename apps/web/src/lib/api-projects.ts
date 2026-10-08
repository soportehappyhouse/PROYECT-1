import {
  API_ROUTES,
  type Project,
  type ProjectDuplicate,
  type ProjectPatch,
  type ProjectSummary,
} from "@studio/shared";
import { apiFetch, apiUrl } from "./api";

/**
 * Sprint 5 (M2) client: project list (summaries with thumbnail), rename, duplicate, delete and
 * the `pagehide` flush of the autosave.
 */
export const projectsApi = {
  /** GET /api/projects?view=summary (newest first). */
  list: () => apiFetch<ProjectSummary[]>(API_ROUTES.projects, { query: { view: "summary" } }),
  rename: (id: string, body: ProjectPatch) =>
    apiFetch<ProjectSummary>(API_ROUTES.project, { method: "PATCH", params: { id }, json: body }),
  duplicate: (id: string, body: ProjectDuplicate = {}) =>
    apiFetch<Project>(API_ROUTES.projectDuplicate, { method: "POST", params: { id }, json: body }),
  remove: (id: string) => apiFetch<void>(API_ROUTES.project, { method: "DELETE", params: { id } }),
  get: (id: string) => apiFetch<Project>(API_ROUTES.project, { params: { id } }),
};

/** Max body that `fetch(..., {keepalive: true})` accepts (browsers cap in-flight keepalive at 64 KB). */
export const KEEPALIVE_MAX_BYTES = 64 * 1024;

/**
 * H22: save the project while the page goes away (`pagehide`). Returns false when the body is too
 * big for a keepalive request (the caller then relies on the short debounce).
 */
export function flushProjectOnHide(project: Project, fetchImpl: typeof fetch = fetch): boolean {
  const body = JSON.stringify(project);
  if (new Blob([body]).size > KEEPALIVE_MAX_BYTES) return false;
  try {
    void fetchImpl(apiUrl(API_ROUTES.project, { id: project.id }), {
      method: "PUT",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
