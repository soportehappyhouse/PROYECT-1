import { CAPTION_STYLE_IDS, CAPTION_STYLE_PRESETS, type CaptionStyle } from "@studio/shared";
import { create } from "zustand";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";
import { useProjectStore } from "./project-store";

/** Shared contract (Project.captionStyle): the api uses it to burn subtitles on export. */
export type { CaptionStyle };

/**
 * Built-in presets = the shared CAPTION_STYLE_PRESETS (one per CAPTION_STYLE_IDS entry, the same
 * ids the assistant's `add_captions {style}` uses): a single list, no divergence.
 */
export const CAPTION_STYLES: readonly CaptionStyle[] = CAPTION_STYLE_PRESETS;
export { CAPTION_STYLE_IDS };

interface CaptionStyleState {
  style: CaptionStyle;
  setStyle: (style: CaptionStyle) => void;
  patch: (patch: Partial<CaptionStyle>) => void;
}

function initial(): CaptionStyle {
  const saved = readJson<CaptionStyle>(STORAGE_KEYS.captionStyle);
  return saved && typeof saved === "object" && "fontSize" in saved
    ? { ...CAPTION_STYLES[0]!, ...saved }
    : CAPTION_STYLES[0]!;
}

export const useCaptionStyleStore = create<CaptionStyleState>()((set, get) => ({
  style: initial(),
  setStyle: (style) => {
    writeJson(STORAGE_KEYS.captionStyle, style);
    set({ style });
    useProjectStore.getState().setCaptionStyle(style);
  },
  patch: (patch) =>
    get().setStyle({ ...get().style, ...patch, id: "custom", name: "Personalizado" }),
}));
