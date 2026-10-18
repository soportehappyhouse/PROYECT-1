import {
  fmtS,
  planWordCuts,
  SCRIPT_PANEL_TEXTS_ES,
  SCRIPT_TEXTS_ES,
  type FitDurationPreview,
  type ScriptCutsRequest,
  type ScriptCutsResponse,
} from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { showPanel } from "@/components/dashboard/dock-controller";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { ApiRequestError, errorCode, errorMessage } from "@/lib/api";
import { isDestructive } from "@/lib/agent";
import { scriptApi, type ScriptTranscribeResult } from "@/lib/api-script";
import { createId } from "@/lib/ids";
import { waitForJob } from "@/lib/job-runner";
import {
  acousticFromScript,
  cutProject,
  fitChoices,
  fitPlanFor,
  localScript,
  type FitChoice,
  type ScriptAudioMeta,
  type SourceGap,
} from "@/lib/script";
import { useAgentStore } from "./agent-store";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 6 M1 «Guion» panel state. The Script itself is never stored: the panel derives it from
 * the project (`localScript`). Here: the audio artifact (acoustic gaps in source seconds), the word
 * selection, the «Dejalo en N s» preview and the running transcription.
 */

export interface FitState {
  target_s: number;
  preview: FitDurationPreview;
  enabled: FitChoice[];
}

export interface CutOutcome {
  cuts: number;
  removed_s: number;
  skipped: number;
}

interface ScriptState {
  projectId: string | undefined;
  acoustic: SourceGap[];
  meta: ScriptAudioMeta | undefined;
  loading: boolean;
  /** Job id of the running script.transcribe. */
  transcribing: string | undefined;
  selected: string[];
  anchor: string | undefined;
  /** Word with the keyboard focus (roving tabindex). */
  active: string | undefined;
  editing: string | undefined;
  busy: boolean;
  fit: FitState | undefined;
  /** Words skipped by the last cut («evitar cortes bruscos»), shown with ⚠. */
  harshSkipped: string[];

  /** Read the audio artifact of the saved project (acoustic gaps). */
  refresh: () => Promise<void>;
  select: (id: string, mode?: "replace" | "range" | "toggle" | "extend") => void;
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;
  setActive: (id: string | undefined) => void;
  setEditing: (id: string | undefined) => void;
  /** Cut a request (api: energy-refined edges; offline: same cuts without energy). One undo step. */
  cut: (req: Partial<ScriptCutsRequest>, label: string) => Promise<CutOutcome | undefined>;
  deleteSelection: () => Promise<CutOutcome | undefined>;
  removeSafe: () => Promise<CutOutcome | undefined>;
  shortenPauses: () => Promise<CutOutcome | undefined>;
  transcribe: (clipId: string) => Promise<void>;
  previewFit: (target_s: number) => Promise<void>;
  toggleFit: (id: FitChoice, on: boolean) => void;
  closeFit: () => void;
  /** «Aplicar»: the plan goes through the Assistant (history + «Deshacer todo»). */
  applyFit: (confirmed?: boolean) => Promise<boolean>;
}

function project() {
  return useProjectStore.getState().project;
}

/** Make sure the api has the same subtitles the panel shows (word ids must match). */
async function syncProject(): Promise<boolean> {
  try {
    await saveProjectNow();
    return useProjectStore.getState().saveState === "saved";
  } catch {
    return false;
  }
}

export const useScriptStore = create<ScriptState>()((set, get) => ({
  projectId: undefined,
  acoustic: [],
  meta: undefined,
  loading: false,
  transcribing: undefined,
  selected: [],
  anchor: undefined,
  active: undefined,
  editing: undefined,
  busy: false,
  fit: undefined,
  harshSkipped: [],

  refresh: async () => {
    const p = project();
    if (get().projectId !== p.id)
      set({ projectId: p.id, acoustic: [], meta: undefined, fit: undefined });
    if (p.subtitles.length === 0) return;
    set({ loading: true });
    try {
      const script = await scriptApi.get(p.id);
      set({
        meta: script.audio,
        acoustic: acousticFromScript(script, project()),
      });
    } catch {
      // Offline / project not saved yet: the Script is still built locally, without acoustic gaps.
    } finally {
      set({ loading: false });
    }
  },

  select: (id, mode = "replace") => {
    const { selected, anchor } = get();
    if (mode === "toggle") {
      set({
        selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
        anchor: id,
        active: id,
      });
      return;
    }
    if ((mode === "range" || mode === "extend") && anchor) {
      const script = localScript(project(), get().acoustic, get().meta);
      const i = script.words.findIndex((w) => w.id === anchor);
      const j = script.words.findIndex((w) => w.id === id);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        set({ selected: script.words.slice(lo, hi + 1).map((w) => w.id), active: id });
        return;
      }
    }
    set({ selected: [id], anchor: id, active: id });
  },
  setSelection: (ids) => set({ selected: [...ids], anchor: ids[0], active: ids[ids.length - 1] }),
  clearSelection: () => set({ selected: [], anchor: undefined }),
  setActive: (id) => set({ active: id }),
  setEditing: (id) => set({ editing: id }),

  cut: async (req, label) => {
    if (get().busy) return undefined;
    const p = project();
    const script = localScript(p, get().acoustic, get().meta);
    if (script.words.length === 0) {
      toast.message(SCRIPT_TEXTS_ES.empty);
      return undefined;
    }
    if (script.stale) {
      toast.warning(SCRIPT_TEXTS_ES.stale);
      return undefined;
    }
    set({ busy: true });
    try {
      const full: ScriptCutsRequest = { avoidHarsh: true, ...req };
      let res: ScriptCutsResponse;
      if (await syncProject()) {
        try {
          res = await scriptApi.cuts(project().id, full);
        } catch (err) {
          if (errorCode(err) === "SCRIPT_NOTHING_TO_CUT") {
            const details = (err as ApiRequestError).body?.error.details as
              { skipped?: { wordId: string }[] } | undefined;
            const skipped = details?.skipped;
            set({ harshSkipped: (skipped ?? []).map((s) => s.wordId) });
            toast.message(errorMessage(err));
            return { cuts: 0, removed_s: 0, skipped: skipped?.length ?? 0 };
          }
          if (err instanceof ApiRequestError && err.status > 0 && err.status < 500) {
            toast.warning(errorMessage(err));
            return undefined;
          }
          res = planWordCuts(script, full); // api down: same plan, no energy refinement
        }
      } else res = planWordCuts(script, full);
      set({ harshSkipped: res.skipped.map((s) => s.wordId) });
      if (res.cuts.length === 0) {
        toast.message(SCRIPT_PANEL_TEXTS_ES.nothingToCut);
        return { cuts: 0, removed_s: 0, skipped: res.skipped.length };
      }
      const store = useProjectStore.getState();
      const out = cutProject(store.project, res.cuts, () => createId("clip"));
      addBreadcrumb("clip", label, { cuts: res.cuts.length, removed: out.removed_s });
      store.applyServerEdit(out.project, label);
      set({ selected: [], anchor: undefined, editing: undefined });
      const n = res.cuts.length;
      toast.success(`${label}: −${fmtS(out.removed_s)} s`, {
        description:
          res.skipped.length > 0
            ? SCRIPT_TEXTS_ES.harshSkipped.replace("{n}", String(res.skipped.length))
            : undefined,
      });
      return { cuts: n, removed_s: out.removed_s, skipped: res.skipped.length };
    } finally {
      set({ busy: false });
    }
  },
  deleteSelection: async () => {
    const ids = get().selected;
    if (ids.length === 0) return undefined;
    return get().cut({ wordIds: ids }, `Borró ${ids.length} palabra${ids.length === 1 ? "" : "s"}`);
  },
  removeSafe: () => get().cut({ fillers: "safe" }, "Quitó las muletillas seguras"),
  shortenPauses: () => get().cut({ shortenLongPauses: true }, "Acortó las pausas largas"),

  transcribe: async (clipId) => {
    if (get().transcribing) return;
    if (!(await syncProject())) {
      toast.error("No se pudo guardar el proyecto antes de transcribir");
      return;
    }
    try {
      const { jobId } = await scriptApi.transcribe(project().id, { clipId });
      set({ transcribing: jobId });
      toast.info("Transcribiendo palabras…");
      const job = await waitForJob(jobId, "script.transcribe");
      const res = job.result as ScriptTranscribeResult;
      const store = useProjectStore.getState();
      const kept = store.project.subtitles.filter(
        (s) => s.end <= res.range.start + 1e-6 || s.start >= res.range.end - 1e-6,
      );
      store.setSubtitles([...kept, ...res.segments]);
      await get().refresh();
      toast.success(`Guion listo: ${res.words} palabras`);
    } catch (err) {
      toast.error("No se pudo transcribir el guion", { description: errorMessage(err) });
    } finally {
      set({ transcribing: undefined });
    }
  },

  previewFit: async (target_s) => {
    if (!(await syncProject())) {
      toast.warning("Para la propuesta hace falta la API: guardá el proyecto y probá de nuevo.");
      return;
    }
    set({ busy: true });
    try {
      const preview = await scriptApi.fit(project().id, { target_s });
      set({ fit: { target_s, preview, enabled: fitChoices(preview).map((c) => c.id) } });
    } catch (err) {
      toast.warning(errorMessage(err));
    } finally {
      set({ busy: false });
    }
  },
  toggleFit: (id, on) => {
    const fit = get().fit;
    if (!fit) return;
    const enabled = on ? [...new Set([...fit.enabled, id])] : fit.enabled.filter((x) => x !== id);
    set({ fit: { ...fit, enabled } });
  },
  closeFit: () => set({ fit: undefined }),
  applyFit: async (confirmed = false) => {
    const fit = get().fit;
    if (!fit) return false;
    const enabled = new Set(fit.enabled);
    if (enabled.has("sentence") && !confirmed) return false; // the panel asks first
    const plan = fitPlanFor(fit.preview, enabled, { target_s: fit.target_s });
    if (!plan) {
      toast.message("Marcá al menos un grupo para aplicar");
      return false;
    }
    try {
      const record = await scriptApi.proposePlan(
        project().id,
        plan,
        `Dejalo en ${fmtS(fit.target_s)} s`,
      );
      const agent = useAgentStore.getState();
      agent.receivePlan(record);
      if (!record.ok) {
        showPanel("assistant");
        agent.requestFocus();
        toast.message("Revisá la propuesta en el Asistente");
        return false;
      }
      // Integration S6: ops the resolver marked confirm:true (sentences or > 20 % of the video)
      // need the separate confirmation, here and in the Asistente.
      const ops = record.plan?.ops ?? [];
      const mustConfirm = ops
        .map((op, i) => (isDestructive(op, record.resolved[i]) ? i : -1))
        .filter((i) => i >= 0);
      if (mustConfirm.length > 0) {
        if (!confirmed) {
          showPanel("assistant");
          agent.requestFocus();
          toast.message("Quita una parte grande del video: confirmalo en el Asistente");
          return false;
        }
        for (const i of mustConfirm) agent.toggleOp(i, true);
        useAgentStore.getState().confirmDestructive();
      }
      await useAgentStore.getState().apply();
      set({ fit: undefined });
      return true;
    } catch (err) {
      toast.error("No se pudo aplicar la propuesta", { description: errorMessage(err) });
      return false;
    }
  },
}));
