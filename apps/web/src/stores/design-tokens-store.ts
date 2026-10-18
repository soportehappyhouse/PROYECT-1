import { DEFAULT_DESIGN_TOKENS, type DesignTokens } from "@studio/shared";
import { create } from "zustand";
import { designApi, ensureBundledFontFaces } from "@/lib/api-design";

/**
 * Tokens of the brand kit for the player preview (audit S6 E1): the burned captions use the kit
 * caption family and weight, so the preview draws the same face as the export. Loaded once from
 * GET /api/brand-kit and refreshed when the kit is saved (useBrandKit).
 */
interface DesignTokensState {
  tokens: DesignTokens;
  loaded: boolean;
  setTokens: (tokens: DesignTokens) => void;
  ensureLoaded: () => void;
}

export const useDesignTokensStore = create<DesignTokensState>()((set, get) => ({
  tokens: DEFAULT_DESIGN_TOKENS,
  loaded: false,
  setTokens: (tokens) => set({ tokens, loaded: true }),
  ensureLoaded: () => {
    if (get().loaded) return;
    set({ loaded: true });
    ensureBundledFontFaces();
    designApi
      .brandKit()
      .then((kit) => set({ tokens: kit.tokens }))
      .catch(() => set({ loaded: false }));
  },
}));
