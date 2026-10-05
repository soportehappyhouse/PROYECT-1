import { create } from "zustand";
import { DEFAULT_SILENCE_OPTIONS, type SilenceOptions } from "@/lib/ai-types";

interface SilencesState {
  /** Clip under review; undefined = dialog closed. */
  clipId: string | undefined;
  /** Last options used (kept between runs in this session). */
  options: SilenceOptions;
  open: (clipId: string) => void;
  close: () => void;
  setOptions: (patch: Partial<SilenceOptions>) => void;
}

/** «Quitar silencios y muletillas» dialog (opened from Subtítulos and the timeline toolbar). */
export const useSilencesStore = create<SilencesState>()((set) => ({
  clipId: undefined,
  options: DEFAULT_SILENCE_OPTIONS,
  open: (clipId) => set({ clipId }),
  close: () => set({ clipId: undefined }),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
}));
