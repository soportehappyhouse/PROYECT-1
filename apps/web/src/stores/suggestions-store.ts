import { visibleSuggestions, type ImportSuggestion, type SuggestionKind } from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { normalizePlanRecord } from "@/lib/agent-api";
import { errorMessage, isNotImplemented } from "@/lib/api";
import { suggestionsApi } from "@/lib/api-suggestions";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useAgentStore } from "./agent-store";
import { useJobsStore } from "./jobs-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 6 M3: cards «Sugerencias» of the Asistente. The api recomputes them from the import
 * analyses (suggest.analyze, background lane); «Aplicar» asks the api for a validated plan and
 * opens it in the Asistente (preview → apply → history / «Deshacer todo»). Nothing is applied
 * here. Background analyses never toast (one aggregated «Analizando N medios…» line instead).
 */
interface SuggestionsState {
  projectId: string | undefined;
  suggestions: ImportSuggestion[];
  /** Assets of the project with a suggest.analyze queued or running. */
  analyzing: string[];
  loading: boolean;
  error: string | undefined;
  /** Card whose plan is being requested («Aplicar»). */
  busy: string | undefined;
  load: (projectId?: string) => Promise<void>;
  apply: (sid: string) => Promise<void>;
  dismiss: (sid: string, muteKind?: boolean) => Promise<void>;
}

export const SUGGESTION_JOB = "suggest.analyze";

export const useSuggestionsStore = create<SuggestionsState>()((set, get) => ({
  projectId: undefined,
  suggestions: [],
  analyzing: [],
  loading: false,
  error: undefined,
  busy: undefined,

  load: async (projectIdArg) => {
    const projectId = projectIdArg ?? useProjectStore.getState().project.id;
    if (get().projectId !== projectId) set({ projectId, suggestions: [], analyzing: [] });
    set({ loading: true });
    try {
      const res = await suggestionsApi.list(projectId);
      if (get().projectId !== projectId) return;
      set({
        suggestions: Array.isArray(res?.suggestions) ? res.suggestions : [],
        analyzing: Array.isArray(res?.analyzing) ? res.analyzing : [],
        error: undefined,
      });
    } catch (err) {
      // 501 (api without M3) or offline: no cards, never a toast.
      set({ error: isNotImplemented(err) ? undefined : errorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  apply: async (sid) => {
    const projectId = get().projectId ?? useProjectStore.getState().project.id;
    const card = get().suggestions.find((s) => s.id === sid);
    addBreadcrumb("ui", "Sugerencias: aplicar", { kind: card?.kind });
    set({ busy: sid });
    try {
      await saveProjectNow();
      const record = await suggestionsApi.plan(projectId, sid);
      useAgentStore.getState().openPlan(normalizePlanRecord(record));
    } catch (err) {
      toast.error("No se pudo preparar la sugerencia", { description: errorMessage(err) });
      void get().load(projectId);
    } finally {
      set({ busy: undefined });
    }
  },

  dismiss: async (sid, muteKind = false) => {
    const projectId = get().projectId ?? useProjectStore.getState().project.id;
    const card = get().suggestions.find((s) => s.id === sid);
    addBreadcrumb("ui", muteKind ? "Sugerencias: no sugerir más" : "Sugerencias: ignorar", {
      kind: card?.kind,
    });
    const kind: SuggestionKind | undefined = card?.kind;
    // Optimistic: the card leaves now (and all of its kind with «No sugerir más»).
    set({
      suggestions: get().suggestions.map((s) =>
        s.id === sid || (muteKind && s.kind === kind) ? { ...s, status: "dismissed" } : s,
      ),
    });
    try {
      await suggestionsApi.dismiss(projectId, sid, muteKind);
      if (muteKind) void get().load(projectId);
    } catch (err) {
      toast.error("No se pudo ocultar la sugerencia", { description: errorMessage(err) });
      void get().load(projectId);
    }
  },
}));

/** Cards to show (max. 4, by impact; stale ones after the open ones). */
export function selectVisibleSuggestions(s: Pick<SuggestionsState, "suggestions">) {
  return visibleSuggestions(s.suggestions);
}

/** «Analizando 2 medios…» (null when nothing is being analyzed). */
export function analyzingText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "Analizando 1 medio…" : `Analizando ${n} medios…`;
}

// ---- wiring (browser only) ---------------------------------------------------------------------

if (typeof window !== "undefined") {
  // Background analyses finish silently (no toast per analysis, decision 11): mark them handled
  // as soon as the Jobs store sees them; reload the cards when one ends.
  useJobsStore.subscribe((state, prev) => {
    let ended = false;
    for (const [id, job] of Object.entries(state.jobs)) {
      if (job.type !== SUGGESTION_JOB) continue;
      if (!state.handled[id]) useJobsStore.getState().markHandled(id);
      const before = prev.jobs[id]?.status;
      if (before !== job.status) {
        if (["succeeded", "failed", "canceled"].includes(job.status)) ended = true;
        else if (!before) ended = true; // a new analysis: show «Analizando…»
      }
    }
    if (ended && useSuggestionsStore.getState().projectId)
      void useSuggestionsStore.getState().load();
  });
  // A plan applied or undone in the Asistente changes the cards (applied / open again).
  useAgentStore.subscribe((state, prev) => {
    const st = state.run?.status;
    if (st !== prev.run?.status && (st === "done" || st === "undone" || st === "failed"))
      if (useSuggestionsStore.getState().projectId) void useSuggestionsStore.getState().load();
  });
}
