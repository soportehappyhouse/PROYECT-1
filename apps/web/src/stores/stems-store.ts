import {
  STEMS_JOB_TYPE,
  STEMS_MODE_LABELS_ES,
  type Project,
  type StemsMode,
  type StemsResult,
} from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { warnIfCpu } from "@/lib/gpu-preflight";
import { waitForJob } from "@/lib/job-runner";
import { stemsApi } from "@/lib/stems-api";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useMediaStore } from "./media-store";
import { runWithPack } from "./packs-store";
import { useProjectStore } from "./project-store";

export type StemsRunStatus = "starting" | "running" | "done" | "failed" | "undoing" | "undone";

export interface StemsRun {
  clipId: string;
  mode: StemsMode;
  status: StemsRunStatus;
  jobId?: string;
  result?: StemsResult;
  error?: string;
}

interface StemsState {
  mode: StemsMode;
  run: StemsRun | undefined;
  /** 409 PROJECT_CHANGED of the last undo: the panel offers «Deshacer igual». */
  undoConflict: string | undefined;
  setMode: (mode: StemsMode) => void;
  /** «Separar audio» on a timeline clip (saved first; the api edits the saved project). */
  separate: (clipId: string) => Promise<void>;
  /** «Deshacer separación» (force = restore even if the project changed since). */
  undo: (force?: boolean) => Promise<void>;
  reset: () => void;
}

/** Read the project the api just edited and adopt it (one local undo step), plus new media. */
async function adoptRemote(label: string, given?: Project): Promise<void> {
  const id = useProjectStore.getState().project.id;
  try {
    const remote = given?.id === id ? given : await api.getProject(id);
    useProjectStore.getState().adoptServerProject(remote, label);
  } catch {
    toast.warning("No se pudo releer el proyecto", {
      description: "Recargá la página para ver las pistas separadas.",
    });
  }
  void useMediaStore
    .getState()
    .refresh()
    .catch(() => undefined);
}

/** Spanish summary of a finished separation (toast description). */
export function stemsSummary(result: Pick<StemsResult, "stems" | "sourceClipId">): string {
  const names = result.stems.map((s) => `«${s.label}»`).join(", ");
  return result.sourceClipId
    ? `Pistas nuevas: ${names}. El clip original quedó silenciado.`
    : `Audios nuevos en Media: ${names}.`;
}

export const useStemsStore = create<StemsState>()((set, get) => ({
  mode: "two",
  run: undefined,
  undoConflict: undefined,
  setMode: (mode) => set({ mode }),
  reset: () => set({ run: undefined, undoConflict: undefined }),
  separate: async (clipId) => {
    const current = get().run;
    if (current && (current.status === "starting" || current.status === "running")) return;
    const mode = get().mode;
    set({ run: { clipId, mode, status: "starting" }, undoConflict: undefined });
    addBreadcrumb("ui", "Separar audio", { clipId, mode });
    try {
      await saveProjectNow();
      await warnIfCpu("stems");
      // Wrapped whole: after a «Paquete requerido» download the same request runs again.
      const done = await runWithPack(async () => {
        const projectId = useProjectStore.getState().project.id;
        const { jobId } = await stemsApi.separate({ clipId, mode, target: { projectId } });
        set({ run: { clipId, mode, status: "running", jobId } });
        toast.info(`Separando audio (${STEMS_MODE_LABELS_ES[mode]})…`);
        const job = await waitForJob(jobId, STEMS_JOB_TYPE);
        const result = job.result as StemsResult;
        set({ run: { clipId, mode, status: "done", jobId, result } });
        if (result.undoSnapshotId) await adoptRemote("Separó el audio en pistas");
        else
          void useMediaStore
            .getState()
            .refresh()
            .catch(() => undefined);
        toast.success("Audio separado", {
          description: stemsSummary(result),
          ...(result.undoSnapshotId && {
            action: { label: "Deshacer separación", onClick: () => void get().undo() },
          }),
        });
        // gpu_fallback_cpu: the generic job follow-up (use-job-events) already warns.
        return true;
      });
      if (done === undefined) set({ run: undefined }); // «Paquete requerido» dialog is open
    } catch (err) {
      const message = errorMessage(err);
      set({ run: { clipId, mode, status: "failed", error: message } });
      toast.error("Separar audio", { description: message });
    }
  },
  undo: async (force = false) => {
    const run = get().run;
    const snapshotId = run?.result?.undoSnapshotId;
    if (!run || !snapshotId || run.status === "undoing") return;
    set({ run: { ...run, status: "undoing" }, undoConflict: undefined });
    try {
      const res = await stemsApi.undo(snapshotId, force);
      await adoptRemote("Deshizo la separación de audio", res.project);
      set({ run: { ...run, status: "undone" } });
      toast.success("Separación deshecha", {
        description: "Volvió el audio original (los audios separados quedan en Media).",
      });
    } catch (err) {
      set({ run: { ...run, status: "done" } });
      if (err instanceof ApiRequestError && err.code === "PROJECT_CHANGED")
        set({ undoConflict: errorMessage(err) });
      else toast.error("Deshacer separación", { description: errorMessage(err) });
    }
  },
}));
