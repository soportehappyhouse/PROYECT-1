import { toast } from "sonner";
import { scenesLookup } from "@/hooks/use-scene-markers";
import type { SceneRange } from "@/lib/ai-types";
import { aiApi, ApiRequestError, errorMessage, isNotImplemented } from "@/lib/api";
import { runJob } from "@/lib/job-runner";
import { clipSceneTimes } from "@/lib/scenes";
import { findClip } from "@/lib/timeline";
import { useMediaStore } from "@/stores/media-store";
import { runWithPack } from "@/stores/packs-store";
import { useProjectStore } from "@/stores/project-store";
import { useScenesStore } from "@/stores/scenes-store";

function selectedVideoClip() {
  const { project, selectedClipId } = useProjectStore.getState();
  const found = selectedClipId ? findClip(project, selectedClipId) : undefined;
  if (!found || found.track.kind !== "video" || !found.clip.assetId) return undefined;
  return { ...found, assetId: found.clip.assetId };
}

function readScenes(result: unknown): SceneRange[] {
  const list = Array.isArray(result) ? result : (result as { scenes?: unknown } | null)?.scenes;
  return Array.isArray(list) ? (list as SceneRange[]) : [];
}

/** «Detectar escenas» (job analyze.scenes) on the selected video clip's asset. */
export async function detectScenes(): Promise<void> {
  const sel = selectedVideoClip();
  if (!sel) {
    toast.message("Selecciona un clip de video para detectar sus escenas");
    return;
  }
  const { assetId } = sel;
  try {
    await runWithPack(async () => {
      const id = toast.loading("Detectando escenas…");
      try {
        const scenes = readScenes(
          await runJob(() => aiApi.analyzeScenes(assetId), "analyze.scenes"),
        );
        useScenesStore.getState().setScenes(assetId, scenes);
        void useMediaStore.getState().refresh();
        const cuts = Math.max(0, scenes.length - 1);
        toast.success(
          cuts > 0 ? `${cuts} cambio(s) de escena marcados en la regla` : "No se detectaron cortes",
          { id },
        );
      } catch (err) {
        toast.dismiss(id);
        throw err;
      }
    });
  } catch (err) {
    if (isNotImplemented(err) || (err instanceof ApiRequestError && err.status === 404))
      toast.info("Detectar escenas: módulo en desarrollo");
    else toast.error("No se pudieron detectar las escenas", { description: errorMessage(err) });
  }
}

/** «Cortar en escenas»: split the selected video clip at its scene markers (one undo step). */
export function cutAtScenes(): void {
  const sel = selectedVideoClip();
  if (!sel) {
    toast.message("Selecciona un clip de video con escenas detectadas");
    return;
  }
  const scenes = scenesLookup()(sel.assetId);
  if (!scenes?.length) {
    toast.message("Primero usa «Detectar escenas» en este clip");
    return;
  }
  const times = clipSceneTimes(sel.clip, scenes);
  const n = useProjectStore.getState().splitAtTimes(sel.clip.id, times);
  if (n > 0) toast.success(`Clip cortado en ${n + 1} partes`);
  else toast.message("No hay cambios de escena dentro del clip");
}
