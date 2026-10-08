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

const serialized = new WeakMap<Project, { json: string; bytes: number }>();

/**
 * JSON of a project and its UTF-8 size (`Blob.size`, not `string.length`: «ñ» or emoji count
 * twice or more). Cached by object identity: the store replaces the project object on every
 * change, so each version is stringified once for localStorage, the debounce and `pagehide`.
 */
export function serializeProject(project: Project): { json: string; bytes: number } {
  let hit = serialized.get(project);
  if (!hit) {
    const json = JSON.stringify(project);
    hit = { json, bytes: new Blob([json]).size };
    serialized.set(project, hit);
  }
  return hit;
}

/**
 * H22: save the project while the page goes away (`pagehide`). Returns false when the body is too
 * big for a keepalive request (the caller then relies on the short debounce).
 */
export function flushProjectOnHide(project: Project, fetchImpl: typeof fetch = fetch): boolean {
  const { json: body, bytes } = serializeProject(project);
  if (bytes > KEEPALIVE_MAX_BYTES) return false;
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
