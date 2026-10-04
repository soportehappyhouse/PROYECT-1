import type { MediaAsset } from "@studio/shared";
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
}

export const useMediaStore = create<MediaState>()((set, get) => ({
  assets: {},
  order: [],
  status: "idle",
  error: undefined,
  uploads: [],
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
