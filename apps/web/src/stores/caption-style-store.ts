import { create } from "zustand";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";

export interface CaptionStyle {
  id: string;
  name: string;
  fontFamily: string;
  /** In project pixels (relative to a 1080p frame height). */
  fontSize: number;
  color: string;
  /** Box behind the text; empty = none. */
  background: string;
  /** Color of the active word for word-by-word animation. */
  highlightColor: string;
  position: "top" | "center" | "bottom";
  uppercase: boolean;
  /** Animation hint for the `animated-captions` template. */
  animation: "none" | "pop" | "karaoke" | "fade";
}

export const CAPTION_STYLES: readonly CaptionStyle[] = [
  {
    id: "clasico",
    name: "Clásico",
    fontFamily: "Inter",
    fontSize: 54,
    color: "#ffffff",
    background: "rgba(0,0,0,0.6)",
    highlightColor: "#ffd60a",
    position: "bottom",
    uppercase: false,
    animation: "fade",
  },
  {
    id: "reels",
    name: "Reels (palabra a palabra)",
    fontFamily: "Inter",
    fontSize: 72,
    color: "#ffffff",
    background: "",
    highlightColor: "#22d3ee",
    position: "center",
    uppercase: true,
    animation: "pop",
  },
  {
    id: "karaoke",
    name: "Karaoke",
    fontFamily: "Inter",
    fontSize: 60,
    color: "#e5e5e5",
    background: "",
    highlightColor: "#f43f5e",
    position: "bottom",
    uppercase: false,
    animation: "karaoke",
  },
  {
    id: "minimal",
    name: "Minimal",
    fontFamily: "Georgia",
    fontSize: 44,
    color: "#ffffff",
    background: "",
    highlightColor: "#ffffff",
    position: "bottom",
    uppercase: false,
    animation: "none",
  },
  {
    id: "titular",
    name: "Titular arriba",
    fontFamily: "Inter",
    fontSize: 64,
    color: "#111111",
    background: "#ffd60a",
    highlightColor: "#111111",
    position: "top",
    uppercase: true,
    animation: "pop",
  },
];

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
  },
  patch: (patch) =>
    get().setStyle({ ...get().style, ...patch, id: "custom", name: "Personalizado" }),
}));
