import { create } from "zustand";
import type { SceneRange } from "@/lib/ai-types";

interface ScenesState {
  /** assetId -> scenes (source time) from analyze.scenes in this session. */
  byAsset: Record<string, SceneRange[]>;
  /** Show the scene markers on the ruler (and snap to them). */
  visible: boolean;
  setScenes: (assetId: string, scenes: SceneRange[]) => void;
  toggleVisible: () => void;
}

export const useScenesStore = create<ScenesState>()((set) => ({
  byAsset: {},
  visible: true,
  setScenes: (assetId, scenes) =>
    set((s) => ({ byAsset: { ...s.byAsset, [assetId]: scenes }, visible: true })),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
}));
