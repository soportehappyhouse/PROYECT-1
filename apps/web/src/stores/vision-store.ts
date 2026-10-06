import {
  trackRefKeyframes,
  type Clip,
  type CropRect,
  type Keyframe,
  type MatteBackground,
  type MatteHalo,
  type MatteQuality,
  type MatteRefine,
  type ReframeTarget,
  type TrackAnchor,
  type TrackRequestMethod,
  type TrackToKeyframesResult,
  type Vec2,
  type VisionMatteResult,
  type VisionReframeResult,
  type VisionTrackResult,
} from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { errorMessage, isNotImplemented, ApiRequestError } from "@/lib/api";
import { findClip } from "@/lib/timeline";
import { cachedTrack, defaultTrackRef, loadTrack, visionApi } from "@/lib/vision-api";
import { JobFailedError } from "@/lib/job-runner";
import { trackMethodLabel } from "@/lib/vision-types";
import { runVisionJob } from "@/lib/vision-jobs";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useMediaStore } from "./media-store";
import { usePreviewStore } from "./preview-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 2 vision actions of the web (Quitar fondo, Seguir objeto, Reencuadrar, Convertir
 * seguimiento a keyframes) and the dialogs they open. Every server job reads the SAVED project,
 * so the project is saved first; results are applied to the local copy as one undo step.
 */

export type MatteDialog = {
  clipId: string;
  /** Alpha produced by the mask tool: apply it without a new job. */
  alphaAssetId?: string;
};

/** Sprint 3b «Quitar fondo» options: Rápido / Alta calidad, edge refinement, SAM mask guide. */
export type MatteOptions = {
  quality?: MatteQuality;
  refine?: MatteRefine;
  maskAssetId?: string;
};

/** Last before | after frame of a refined matte (shown by the «Quitar fondo» dialog). */
export type MatteCompare = {
  clipId: string;
  path: string;
  quality?: MatteQuality;
  halo?: MatteHalo;
};

export type TrackAssign = {
  trackAssetId: string;
  /** Video clip the track came from (time window suggestion). */
  sourceClipId: string | undefined;
};

interface VisionState {
  matteDialog: MatteDialog | undefined;
  matteCompare: MatteCompare | undefined;
  trackAssign: TrackAssign | undefined;
  /** Running job per action (buttons show a spinner + progress). */
  busy: Partial<Record<"matte" | "track" | "reframe" | "toKeyframes", string | true>>;
  /**
   * «Seguir objeto» → «Método»: "auto" (the api uses SAM 2 when its pack is installed, else the
   * fast OpenCV tracker), "sam2" or "csrt" («Rápido»: CSRT, template matching on headless OpenCV).
   */
  trackMethod: TrackRequestMethod;
  setTrackMethod: (method: TrackRequestMethod) => void;
  openMatte: (dialog: MatteDialog | undefined) => void;
  openTrackAssign: (assign: TrackAssign | undefined) => void;
  removeBackground: (
    clipId: string,
    background: MatteBackground | undefined,
    opts?: MatteOptions,
  ) => Promise<boolean>;
  applyAlpha: (
    clipId: string,
    alphaAssetId: string,
    background: MatteBackground | undefined,
  ) => void;
  /** Box drawn on the preview (source fractions) → job vision.track → «Asignar a…». */
  trackObject: (
    clipId: string,
    bbox: { x: number; y: number; w: number; h: number },
  ) => Promise<void>;
  assignTrack: (
    targetClipId: string,
    trackAssetId: string,
    anchor: TrackAnchor,
    offset: Vec2,
  ) => void;
  convertTrackToKeyframes: (clipId: string) => Promise<boolean>;
  analyzeReframe: (
    target: ReframeTarget,
    subject: "face" | "track",
    trackAssetId?: string,
  ) => Promise<boolean>;
  applyReframe: () => boolean;
}

function setBusy(key: keyof VisionState["busy"], value: string | true | undefined) {
  useVisionStore.setState((s) => {
    const busy = { ...s.busy };
    if (value === undefined) delete busy[key];
    else busy[key] = value;
    return { busy };
  });
}

function fail(title: string, err: unknown): void {
  // A failed job is already announced by the jobs listener (with «Reportar»).
  if (err instanceof JobFailedError) return;
  toast.error(title, {
    description: isNotImplemented(err)
      ? "Esta función de IA todavía no está disponible en la API local."
      : errorMessage(err),
  });
}

function isMissingRoute(err: unknown): boolean {
  return isNotImplemented(err) || (err instanceof ApiRequestError && err.status === 404);
}

export const useVisionStore = create<VisionState>()((set, get) => ({
  matteDialog: undefined,
  matteCompare: undefined,
  trackAssign: undefined,
  busy: {},
  trackMethod: "auto",
  setTrackMethod: (trackMethod) => set({ trackMethod }),
  openMatte: (matteDialog) => set({ matteDialog }),
  openTrackAssign: (trackAssign) => set({ trackAssign }),

  removeBackground: async (clipId, background, opts = {}) => {
    const project = useProjectStore.getState().project;
    const found = findClip(project, clipId);
    const asset = found?.clip.assetId
      ? useMediaStore.getState().assets[found.clip.assetId]
      : undefined;
    if (!found || !asset) {
      toast.message("Elegí un clip de video o imagen con medio");
      return false;
    }
    set({ matteDialog: undefined });
    setBusy("matte", true);
    const video = asset.kind !== "image";
    addBreadcrumb("ui", "Quitar fondo", {
      clipId,
      background: background?.type ?? "none",
      quality: (video && opts.quality) || "fast",
    });
    try {
      await saveProjectNow();
      const result = await runVisionJob<VisionMatteResult>(
        () =>
          visionApi.matte({
            assetId: asset.id,
            model: asset.kind === "image" ? "birefnet" : "rvm",
            ...(background && { background }),
            target: { projectId: project.id, clipId },
            ...(video && opts.quality && { quality: opts.quality }),
            ...(video && opts.refine && { refine: opts.refine }),
            ...(video && opts.maskAssetId && { maskAssetId: opts.maskAssetId }),
          }),
        "vision.matte",
        // image -> BiRefNet (onnxruntime: also warns when only the CPU build is installed)
        {
          gpu: asset.kind === "image" ? "birefnet" : "matting",
          onJob: (id) => setBusy("matte", id),
        },
      );
      if (!result?.assetId) return false;
      await useMediaStore.getState().ensure(result.assetId);
      get().applyAlpha(clipId, result.assetId, background);
      const compare = result.previewComparePath;
      if (compare)
        set({
          matteCompare: {
            clipId,
            path: compare,
            ...(result.quality && { quality: result.quality }),
            ...(result.halo && { halo: result.halo }),
          },
        });
      toast.success("Fondo quitado", {
        description: "La vista previa ya muestra el recorte.",
        ...(compare && {
          action: { label: "Antes / después", onClick: () => get().openMatte({ clipId }) },
        }),
      });
      return true;
    } catch (err) {
      fail("No se pudo quitar el fondo", err);
      return false;
    } finally {
      setBusy("matte", undefined);
    }
  },

  applyAlpha: (clipId, alphaAssetId, background) => {
    useProjectStore
      .getState()
      .updateClip(clipId, { matte: { assetId: alphaAssetId, ...(background && { background }) } });
    set({ matteDialog: undefined });
  },

  trackObject: async (clipId, bbox) => {
    const found = findClip(useProjectStore.getState().project, clipId);
    const assetId = found?.clip.assetId;
    if (!assetId) return;
    usePreviewStore.getState().setTool("none");
    setBusy("track", true);
    const requested = get().trackMethod;
    addBreadcrumb("ui", "Seguir objeto", { clipId, method: requested });
    try {
      const result = await runVisionJob<VisionTrackResult>(
        () => visionApi.track({ assetId, bbox, method: requested }),
        "vision.track",
        {
          ...(requested === "sam2" && { gpu: "sam2" as const }),
          onJob: (id) => setBusy("track", id),
        },
      );
      if (!result?.assetId) return;
      const asset = await useMediaStore.getState().ensure(result.assetId);
      void loadTrack(asset);
      const method = trackMethodLabel(result.method);
      toast.success(method ? `Seguimiento listo (${method})` : "Seguimiento listo", {
        description:
          result.method === "template"
            ? "Sin CSRT en este OpenCV: se usó template matching. Elegí qué texto o motion sigue al objeto."
            : "Elegí qué texto o motion sigue al objeto.",
      });
      set({ trackAssign: { trackAssetId: result.assetId, sourceClipId: clipId } });
    } catch (err) {
      fail("No se pudo seguir el objeto", err);
    } finally {
      setBusy("track", undefined);
    }
  },

  assignTrack: (targetClipId, trackAssetId, anchor, offset) => {
    useProjectStore.getState().updateClip(targetClipId, {
      trackRef: { ...defaultTrackRef(trackAssetId), anchor, offset },
    });
    void loadTrack(useMediaStore.getState().assets[trackAssetId]);
    set({ trackAssign: undefined });
  },

  convertTrackToKeyframes: async (clipId) => {
    const store = useProjectStore.getState();
    const found = findClip(store.project, clipId);
    const ref = found?.clip.trackRef;
    if (!found || !ref) return false;
    setBusy("toKeyframes", true);
    const adopt = (keyframes: Keyframe<Vec2>[]) => {
      const clip = findClip(useProjectStore.getState().project, clipId)?.clip;
      if (!clip) return;
      const patch: Partial<Clip> = {
        trackRef: undefined,
        keyframes: { ...clip.keyframes, position: keyframes },
      };
      useProjectStore.getState().updateClip(clipId, patch);
      toast.success(`Seguimiento convertido en ${keyframes.length} keyframes de posición`);
    };
    try {
      try {
        await saveProjectNow();
        const result = await runVisionJob<TrackToKeyframesResult>(
          () => visionApi.trackToKeyframes(store.project.id, clipId),
          "timeline.track-to-keyframes",
          { onJob: (id) => setBusy("toKeyframes", id) },
        );
        const remote = result
          ? findClip(result.project, clipId)?.clip.keyframes?.position
          : undefined;
        if (remote?.length) {
          adopt(remote as Keyframe<Vec2>[]);
          return true;
        }
        if (result) throw new Error("La API no devolvió keyframes");
        return false;
      } catch (err) {
        if (!isMissingRoute(err)) throw err;
        // Local fallback: same shared math as the export (trackRefKeyframes).
        const assets = useMediaStore.getState().assets;
        const file = cachedTrack(ref.assetId) ?? (await loadTrack(assets[ref.assetId]));
        if (!file) throw new Error("No se pudo leer el archivo de seguimiento");
        const keyframes = trackRefKeyframes(
          useProjectStore.getState().project,
          found.clip,
          file,
          (id) => {
            const a = assets[id];
            return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
          },
          2,
          0.001,
        );
        if (keyframes.length === 0) throw new Error("El seguimiento no cubre el clip");
        adopt(keyframes);
        return true;
      }
    } catch (err) {
      fail("No se pudo convertir el seguimiento", err);
      return false;
    } finally {
      setBusy("toKeyframes", undefined);
    }
  },

  analyzeReframe: async (target, subject, trackAssetId) => {
    const project = useProjectStore.getState().project;
    setBusy("reframe", true);
    addBreadcrumb("ui", `Reencuadrar a ${target}`, { target, subject });
    try {
      await saveProjectNow();
      const result = await runVisionJob<VisionReframeResult>(
        () =>
          visionApi.reframe({
            projectId: project.id,
            target,
            subject,
            ...(trackAssetId && { trackAssetId }),
          }),
        "vision.reframe",
        { onJob: (id) => setBusy("reframe", id) },
      );
      const keyframes = (result?.reframe?.keyframes ?? []) as Keyframe<CropRect>[];
      if (!result) return false;
      if (keyframes.length === 0) {
        toast.message("El análisis no devolvió recortes");
        return false;
      }
      usePreviewStore.getState().setReframeDraft({ target, keyframes });
      toast.success(`Reencuadre ${target} analizado`, {
        description: "Revisá el recorrido del recorte en la vista previa y tocá Aplicar.",
      });
      return true;
    } catch (err) {
      fail("No se pudo analizar el reencuadre", err);
      return false;
    } finally {
      setBusy("reframe", undefined);
    }
  },

  applyReframe: () => {
    const draft = usePreviewStore.getState().reframeDraft;
    if (!draft) return false;
    useProjectStore
      .getState()
      .setReframe({ target: draft.target, keyframes: draft.keyframes, mode: "auto" });
    usePreviewStore.getState().setReframeDraft(undefined);
    toast.success(`Reencuadre ${draft.target} aplicado`, {
      description:
        "Se usa al exportar en ese formato. Los keyframes de recorte se editan en Propiedades.",
    });
    return true;
  },
}));
