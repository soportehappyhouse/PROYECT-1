import { create } from "zustand";
import { readJson, writeJson } from "@/lib/storage";
import type { CropBox, Keyframe, ReframeTarget } from "@/lib/vision-types";
import { addBreadcrumb } from "./breadcrumbs-store";

/** Preview tools drawn on top of the canvas. */
export type PreviewTool = "none" | "mask" | "track-box";

/** "auto" starts on the original media and drops to the proxy when the preview runs < 24 fps. */
export type PreviewQuality = "auto" | "original" | "proxy";

export const PREVIEW_SETTINGS_KEY = "studio.preview.v1";

export interface PreviewSettings {
  /** «Vista previa clásica»: the Sprint 1 single-clip renderer (safety switch). */
  classic: boolean;
  safeGuides: boolean;
  quality: PreviewQuality;
  /** Performance HUD (always available in development). */
  hud: boolean;
}

const DEFAULTS: PreviewSettings = {
  classic: false,
  safeGuides: false,
  quality: "auto",
  hud: false,
};

function loadSettings(): PreviewSettings {
  const raw = readJson<Partial<PreviewSettings>>(PREVIEW_SETTINGS_KEY) ?? {};
  return {
    classic: raw.classic === true,
    safeGuides: raw.safeGuides === true,
    quality: raw.quality === "original" || raw.quality === "proxy" ? raw.quality : "auto",
    hud: raw.hud === true,
  };
}

export interface PerfStats {
  fps: number;
  /** Average draw time per frame (ms). */
  drawMs: number;
  layers: number;
  clock: "driver" | "monotonic";
  /** Media actually used right now (auto may have switched to proxies). */
  usingProxy: boolean;
}

/** «Reencuadrar»: analysis result shown on the preview before «Aplicar». */
export interface ReframeDraft {
  target: ReframeTarget;
  keyframes: Keyframe<CropBox>[];
}

interface PreviewState extends PreviewSettings {
  tool: PreviewTool;
  /** Clip the active tool works on (mask / tracking box). */
  toolClipId: string | undefined;
  /** Auto quality fell back to proxies (reset when the quality setting changes). */
  autoProxy: boolean;
  perf: PerfStats;
  reframeOpen: boolean;
  reframeDraft: ReframeDraft | undefined;
  set: (patch: Partial<PreviewSettings>) => void;
  setTool: (tool: PreviewTool, clipId?: string) => void;
  setAutoProxy: (on: boolean) => void;
  setPerf: (perf: PerfStats) => void;
  setReframeOpen: (open: boolean) => void;
  setReframeDraft: (draft: ReframeDraft | undefined) => void;
}

export const usePreviewStore = create<PreviewState>()((set, get) => ({
  ...(typeof window === "undefined" ? DEFAULTS : loadSettings()),
  tool: "none",
  toolClipId: undefined,
  autoProxy: false,
  perf: { fps: 0, drawMs: 0, layers: 0, clock: "monotonic", usingProxy: false },
  reframeOpen: false,
  reframeDraft: undefined,
  set: (patch) => {
    const next = { ...pick(get()), ...patch };
    writeJson(PREVIEW_SETTINGS_KEY, next);
    addBreadcrumb("settings", "Cambió las opciones de la vista previa", { ...patch });
    set({ ...patch, ...(patch.quality !== undefined && { autoProxy: false }) });
  },
  setTool: (tool, clipId) => set({ tool, toolClipId: tool === "none" ? undefined : clipId }),
  setAutoProxy: (autoProxy) => set({ autoProxy }),
  setPerf: (perf) => set({ perf }),
  setReframeOpen: (reframeOpen) => set({ reframeOpen }),
  setReframeDraft: (reframeDraft) => set({ reframeDraft }),
}));

function pick(s: PreviewSettings): PreviewSettings {
  return { classic: s.classic, safeGuides: s.safeGuides, quality: s.quality, hud: s.hud };
}

/** True when the preview should load proxies instead of the original media. */
export function wantsProxy(s: Pick<PreviewState, "quality" | "autoProxy">): boolean {
  return s.quality === "proxy" || (s.quality === "auto" && s.autoProxy);
}

/**
 * Auto quality: fps measured over 1 s windows; two consecutive windows below the target switch to
 * proxies. The target is 24 fps, or 90 % of the source fps when the video itself is slower.
 */
export function shouldDropToProxy(windows: readonly number[], sourceFps: number): boolean {
  const target = Math.min(24, sourceFps * 0.9);
  const last = windows.slice(-2);
  return last.length === 2 && last.every((f) => f > 0 && f < target);
}
