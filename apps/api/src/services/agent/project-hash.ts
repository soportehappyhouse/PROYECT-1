import { createHash } from "node:crypto";
import type { Project } from "@studio/shared";

/** JSON with object keys sorted (same content -> same text, whatever the key order). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Sprint 3 undo guard: hash of the project CONTENT (sha256 of the canonical JSON without
 * `updatedAt`), so re-saving the same project (autosave, the web adopting the api's copy) does not
 * count as a change, while any real edit after agent.apply does.
 */
export function projectContentHash(project: Project): string {
  const { updatedAt: _updatedAt, ...content } = project;
  return createHash("sha256").update(canonical(content)).digest("hex").slice(0, 32);
}
