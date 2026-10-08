/** Safe localStorage helpers (SSR / private mode / quota errors never throw). */
export function readJson<T = unknown>(key: string): T | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / privacy errors: the api copy is the durable one
  }
}

/** True for the browser's «storage full» errors (Chrome/Edge/Safari and Firefox names). */
export function isQuotaError(err: unknown): boolean {
  if (
    !(err instanceof Error) &&
    !(typeof DOMException !== "undefined" && err instanceof DOMException)
  )
    return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

/** Store an already serialized value: "ok", "quota" (storage full) or "error" (blocked…). */
export function writeRaw(key: string, raw: string): "ok" | "quota" | "error" {
  try {
    if (typeof window === "undefined") return "error";
    window.localStorage.setItem(key, raw);
    return "ok";
  } catch (err) {
    return isQuotaError(err) ? "quota" : "error";
  }
}

export function removeKey(key: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export const STORAGE_KEYS = {
  settings: "studio.settings.v1",
  project: "studio.project.v1",
  exportPresets: "studio.export-presets.v1",
  captionStyle: "studio.caption-style.v1",
  agent: "studio.agent.v1",
} as const;
