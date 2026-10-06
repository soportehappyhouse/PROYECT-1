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
