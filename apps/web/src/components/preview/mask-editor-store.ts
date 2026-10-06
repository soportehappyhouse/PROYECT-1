import { create } from "zustand";

/**
 * Sprint 3b: which clip's shape mask is being edited on the preview (handles over the canvas).
 * Set by the inspector «Capa» section; the overlay shows the editor only for the selected clip.
 */
interface MaskEditorState {
  clipId: string | undefined;
  setEditing: (clipId: string | undefined) => void;
}

export const useMaskEditorStore = create<MaskEditorState>()((set) => ({
  clipId: undefined,
  setEditing: (clipId) => set({ clipId }),
}));
