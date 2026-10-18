import type { Job, MediaAsset } from "@studio/shared";
import { create } from "zustand";
import { api, errorMessage, isNotImplemented } from "@/lib/api";

export type LoadStatus = "idle" | "loading" | "ready" | "not-implemented" | "error";

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  error?: string;
}

interface MediaState {
  assets: Record<string, MediaAsset>;
  order: string[];
  status: LoadStatus;
  error: string | undefined;
  uploads: UploadItem[];
  refresh: () => Promise<void>;
  upsert: (asset: MediaAsset) => void;
  remove: (id: string) => void;
  setUpload: (item: UploadItem) => void;
  clearUpload: (id: string) => void;
  /** Fetch a single asset not yet in the cache (e.g. created by a job). */
  ensure: (id: string) => Promise<MediaAsset | undefined>;
  /**
   * MEJORAS B15 (Sprint 6 M3): media whose media.probe failed (assetId → cause), read from the
   * failed probe jobs so the mark survives a reload. Live failures come from the Jobs store.
   */
  unreadable: Record<string, string>;
  loadUnreadable: () => Promise<void>;
}

/** B15: the cause of the newest failed media.probe of each asset. */
export function unreadableFromJobs(
  jobs: readonly Pick<Job, "type" | "status" | "payload" | "error" | "createdAt">[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const sorted = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const j of sorted) {
    if (j.type !== "media.probe") continue;
    const id = (j.payload as { assetId?: unknown } | undefined)?.assetId;
    if (typeof id !== "string") continue;
    if (j.status === "failed") out[id] = j.error || "No se pudo leer el archivo";
    else if (j.status === "succeeded") delete out[id];
  }
  return out;
}

export const useMediaStore = create<MediaState>()((set, get) => ({
  assets: {},
  order: [],
  status: "idle",
  error: undefined,
  uploads: [],
  unreadable: {},
  loadUnreadable: async () => {
    try {
      const jobs = await api.listJobs({ type: "media.probe", limit: 500 });
      if (Array.isArray(jobs)) set({ unreadable: unreadableFromJobs(jobs) });
    } catch {
      // keep what we had (offline / older api)
    }
  },
  refresh: async () => {
    set({ status: get().status === "ready" ? "ready" : "loading" });
    try {
      const list = await api.listMedia();
      const assets: Record<string, MediaAsset> = {};
      for (const a of list) assets[a.id] = a;
      set({
        assets,
        order: list.map((a) => a.id),
        status: "ready",
        error: undefined,
      });
      void get().loadUnreadable();
    } catch (err) {
      set({
        status: isNotImplemented(err) ? "not-implemented" : "error",
        error: errorMessage(err),
      });
    }
  },
  upsert: (asset) =>
    set((s) => ({
      assets: { ...s.assets, [asset.id]: asset },
      order: s.order.includes(asset.id) ? s.order : [asset.id, ...s.order],
    })),
  remove: (id) =>
    set((s) => {
      const assets = { ...s.assets };
      delete assets[id];
      return { assets, order: s.order.filter((x) => x !== id) };
    }),
  setUpload: (item) =>
    set((s) => ({
      uploads: s.uploads.some((u) => u.id === item.id)
        ? s.uploads.map((u) => (u.id === item.id ? item : u))
        : [...s.uploads, item],
    })),
  clearUpload: (id) => set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) })),
  ensure: async (id) => {
    const cached = get().assets[id];
    if (cached) return cached;
    try {
      const asset = await api.getMedia(id);
      get().upsert(asset);
      return asset;
    } catch {
      return undefined;
    }
  },
}));

/** B15: live cause of the failed media.probe of `assetId` in the Jobs store (undefined = none). */
export function probeFailureOf(
  jobs: Readonly<Record<string, Pick<Job, "type" | "status" | "payload" | "error" | "createdAt">>>,
  assetId: string,
): string | undefined {
  const mine = Object.values(jobs).filter(
    (j) =>
      j.type === "media.probe" &&
      (j.payload as { assetId?: unknown } | undefined)?.assetId === assetId,
  );
  return mine.length ? unreadableFromJobs(mine)[assetId] : undefined;
}
