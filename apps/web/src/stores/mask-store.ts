import type { SamPoint, VisionMaskResult } from "@studio/shared";
import { create } from "zustand";
import { errorMessage } from "@/lib/api";
import { warnIfCpu } from "@/lib/gpu-preflight";
import { maskImageUrl, visionApi } from "@/lib/vision-api";
import { runVisionJob } from "@/lib/vision-jobs";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useJobsStore } from "./jobs-store";
import { useMediaStore } from "./media-store";
import { runWithPack } from "./packs-store";

/**
 * «Máscara» tool (SAM 2): + / − clicks on the current frame → session/points → mask overlay;
 * «Propagar» → job vision.mask → mask/alpha/track assets offered as «Quitar fondo» or
 * «Seguir este objeto». State machine:
 *   idle → starting → ready ⇄ segmenting → propagating → done   (any → error; close → idle)
 */
export type MaskStatus =
  "idle" | "starting" | "ready" | "segmenting" | "propagating" | "done" | "error";

export interface MaskPoint extends SamPoint {
  frame: number;
}

interface MaskState {
  status: MaskStatus;
  clipId: string | undefined;
  assetId: string | undefined;
  sessionId: string | undefined;
  fps: number;
  frames: number;
  /** Next click label: 1 = incluir (+), 0 = excluir (−). */
  label: 1 | 0;
  points: MaskPoint[];
  /** Frame the current points / mask belong to. */
  frame: number | undefined;
  maskUrl: string | undefined;
  bbox: { x: number; y: number; w: number; h: number } | undefined;
  jobId: string | undefined;
  result: VisionMaskResult | undefined;
  error: string | undefined;
  start: (clipId: string, assetId: string) => Promise<boolean>;
  setLabel: (label: 1 | 0) => void;
  /** Click on the frame (source fractions). A click on another frame starts a new prompt. */
  addPoint: (frame: number, x: number, y: number, label?: 1 | 0) => Promise<void>;
  undoPoint: () => Promise<void>;
  clearPoints: () => void;
  propagate: () => Promise<VisionMaskResult | undefined>;
  close: () => Promise<void>;
}

const INITIAL = {
  status: "idle" as MaskStatus,
  clipId: undefined,
  assetId: undefined,
  sessionId: undefined,
  fps: 30,
  frames: 0,
  label: 1 as const,
  points: [] as MaskPoint[],
  frame: undefined,
  maskUrl: undefined,
  bbox: undefined,
  jobId: undefined,
  result: undefined,
  error: undefined,
};

/** Frame number of a source time in a session. */
export function frameAt(sourceTime: number, fps: number, frames: number): number {
  const f = Math.round(Math.max(0, sourceTime) * (fps || 30));
  return frames > 0 ? Math.min(frames - 1, f) : f;
}

export const useMaskStore = create<MaskState>()((set, get) => {
  /** Send the points of the current frame and show the mask. */
  const segment = async (points: MaskPoint[], frame: number) => {
    const { sessionId } = get();
    if (!sessionId) return;
    if (points.length === 0) {
      set({ points, frame, maskUrl: undefined, bbox: undefined, status: "ready" });
      return;
    }
    set({ points, frame, status: "segmenting", error: undefined });
    try {
      const res = await visionApi.samPoints(
        sessionId,
        frame,
        points.map(({ x, y, label }) => ({ x, y, label })),
      );
      if (get().sessionId !== sessionId) return;
      set({ status: "ready", maskUrl: maskImageUrl(res), bbox: res.bbox ?? undefined });
    } catch (err) {
      set({ status: "ready", error: errorMessage(err) });
    }
  };

  return {
    ...INITIAL,
    start: async (clipId, assetId) => {
      await get().close();
      set({ ...INITIAL, status: "starting", clipId, assetId });
      void warnIfCpu("sam2");
      try {
        const session = await runWithPack(() => visionApi.samSession(assetId));
        if (!session) {
          // «Paquete requerido» is open; the session starts again after the download.
          set({ ...INITIAL });
          return false;
        }
        if (get().clipId !== clipId) {
          void visionApi.samClose(session.sessionId).catch(() => undefined);
          return false;
        }
        addBreadcrumb("ui", "Abrió la herramienta Máscara (SAM 2)", { clipId, assetId });
        set({
          status: "ready",
          sessionId: session.sessionId,
          fps: session.fps,
          frames: session.frames,
        });
        return true;
      } catch (err) {
        set({ status: "error", error: errorMessage(err) });
        return false;
      }
    },
    setLabel: (label) => set({ label }),
    addPoint: async (frame, x, y, label) => {
      const s = get();
      if (!s.sessionId || s.status === "propagating" || s.status === "starting") return;
      const same = s.frame === frame ? s.points : [];
      const point: MaskPoint = {
        frame,
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        label: label ?? s.label,
      };
      await segment([...same, point], frame);
    },
    undoPoint: async () => {
      const { points, frame } = get();
      if (frame === undefined || points.length === 0) return;
      await segment(points.slice(0, -1), frame);
    },
    clearPoints: () => set({ points: [], maskUrl: undefined, bbox: undefined }),
    propagate: async () => {
      const { sessionId, assetId, points } = get();
      if (!sessionId || points.length === 0) return undefined;
      set({ status: "propagating", error: undefined, jobId: undefined });
      try {
        const result = await runVisionJob<VisionMaskResult>(
          () => visionApi.samPropagate(sessionId, assetId),
          "vision.mask",
          { gpu: "sam2", onJob: (jobId) => set({ jobId }) },
        );
        if (!result) {
          set({ status: "ready" });
          return undefined;
        }
        // New mask/alpha/track assets: refresh Media so they can be used right away.
        await useMediaStore.getState().refresh();
        set({ status: "done", result });
        return result;
      } catch (err) {
        set({ status: "error", error: errorMessage(err) });
        return undefined;
      }
    },
    close: async () => {
      const { sessionId } = get();
      set({ ...INITIAL });
      if (sessionId) await visionApi.samClose(sessionId).catch(() => undefined);
    },
  };
});

/** Progress 0..1 of the running propagation (jobs store, SSE/poll). */
export function useMaskProgress(): number {
  const jobId = useMaskStore((s) => s.jobId);
  return useJobsStore((s) => (jobId ? (s.jobs[jobId]?.progress ?? 0) : 0));
}
