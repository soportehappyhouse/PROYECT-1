import {
  DEFAULT_STYLE_PRESET,
  STYLE_API_ROUTES,
  validateStylePreset,
  type JobAccepted,
  type StyleAnalysisRecord,
  type StyleAnalyzeJobResult,
  type StyleApplyResponse,
  type StyleInferJobResult,
  type StylePreset,
  type StylePresetDraft,
  type StylePresetSaveRequest,
  type StylePresetSource,
} from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { showPanel } from "@/components/dashboard/dock-controller";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { apiFetch, errorMessage, isNotImplemented } from "@/lib/api";
import { waitForJob } from "@/lib/job-runner";
import { focusAssistant, useAgentStore } from "./agent-store";
import { addBreadcrumb } from "./breadcrumbs-store";
import { runWithPack } from "./packs-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 3b «Perfil de estilo» (docs/trabajo/sprint3b-contratos.md B): analyze a reference video,
 * deduce a StylePreset (local vision model or the Claude console), keep presets and apply one to
 * the open project as an Assistant plan.
 */

/** Window event the Claude console listens to (ConsolePanel / console-store). */
export const CONSOLE_PASTE_EVENT = "studio:console:paste";

export const styleApi = {
  analyze: (assetId: string) =>
    apiFetch<JobAccepted>(STYLE_API_ROUTES.analyze, { method: "POST", json: { assetId } }),
  analyses: (assetId?: string) =>
    apiFetch<StyleAnalysisRecord[]>(STYLE_API_ROUTES.analyses, { query: { assetId } }),
  analysis: (id: string) =>
    apiFetch<StyleAnalysisRecord>(STYLE_API_ROUTES.analysis, { params: { id } }),
  infer: (analysisId: string) =>
    apiFetch<JobAccepted>(STYLE_API_ROUTES.infer, { method: "POST", json: { analysisId } }),
  presets: () => apiFetch<StylePreset[]>(STYLE_API_ROUTES.presets),
  save: (preset: StylePresetSaveRequest) =>
    apiFetch<StylePreset>(STYLE_API_ROUTES.presets, { method: "POST", json: preset }),
  remove: (id: string) =>
    apiFetch<void>(STYLE_API_ROUTES.preset, { method: "DELETE", params: { id } }),
  apply: (id: string, projectId: string) =>
    apiFetch<StyleApplyResponse>(STYLE_API_ROUTES.apply, {
      method: "POST",
      params: { id },
      json: { projectId },
    }),
};

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)} %`);

/**
 * Prompt pasted into the Claude console: where the contact sheet and the analysis are, a short
 * summary, and how to answer (studio_style_save_preset). STORAGE_DIR defaults to <repo>/storage,
 * the console's working directory is the repo root.
 */
export function claudeStylePrompt(record: StyleAnalysisRecord, referenceName?: string): string {
  const a = record.analysis;
  const s = a.shot_stats;
  const texts = (a.text_on_screen ?? [])
    .slice(0, 6)
    .map((t) => `«${t.text}»`)
    .join(", ");
  const lines = [
    `Analizá el video de referencia${referenceName ? ` «${referenceName}»` : ""} y proponé un perfil de estilo (StylePreset) para copiarlo.`,
    `- Hoja de contactos (24 cuadros con la hora): storage/${a.contact_sheet_path}`,
    `- Análisis automático (JSON): storage/${record.path}`,
    `(rutas relativas a STORAGE_DIR; también por HTTP en http://127.0.0.1:3001/files/…)`,
    `Resumen: ${a.duration_s.toFixed(1)} s, lienzo ${a.canvas.aspect}, ${s.count} planos (mediana ${s.median_s.toFixed(1)} s, ${s.cuts_per_min.toFixed(1)} cortes/min), ` +
      `voz ${pct(a.audio.speech_ratio)}, silencio ${pct(a.audio.silence_ratio)}, música ${
        a.audio.music_detected == null ? "?" : a.audio.music_detected ? "sí" : "no"
      }, ${a.audio.loudness_lufs ?? "?"} LUFS, zooms ${a.motion.zoom_events.length}` +
      `${texts ? `, textos: ${texts}` : ""}.`,
    `Mirá la hoja de contactos, decidí canvas, ritmo de cortes, subtítulos, título, rótulo, transiciones, música, zoom y preset de exportación,`,
    `y guardalo con la herramienta studio_style_save_preset (source: {assetId: "${record.sourceAssetId ?? ""}", analysisId: "${record.id}", via: "claude"}).`,
    `No apliques nada todavía: el usuario lo aplica desde «Perfil de estilo».`,
  ];
  return lines.join("\n");
}

/** Dispatch the console paste event (the console panel opens and pastes; the user sends it). */
export function pasteToConsole(text: string): void {
  window.dispatchEvent(new CustomEvent(CONSOLE_PASTE_EVENT, { detail: { text } }));
}

export type StyleDraftOrigin = NonNullable<StylePresetSource["via"]>;

interface StyleState {
  referenceId: string | undefined;
  analysis: StyleAnalysisRecord | undefined;
  analyzeJobId: string | undefined;
  analyzing: boolean;
  analyzeError: string | undefined;
  inferJobId: string | undefined;
  inferring: boolean;
  inferError: string | undefined;
  /** Preset being edited before saving (from the local model, Claude or by hand). */
  draft: StylePresetDraft | undefined;
  draftOrigin: StyleDraftOrigin | undefined;
  /** Id of the stored preset the draft overwrites. */
  draftId: string | undefined;
  presets: StylePreset[];
  presetsLoad: "idle" | "loading" | "ready" | "not-implemented" | "error";
  applyingId: string | undefined;
  lastApply: StyleApplyResponse | undefined;

  setReference: (assetId: string | undefined) => Promise<void>;
  analyze: () => Promise<void>;
  inferLocal: () => Promise<void>;
  askClaude: (referenceName?: string) => void;
  newDraft: () => void;
  editPreset: (preset: StylePreset) => void;
  updateDraft: (fn: (d: StylePresetDraft) => StylePresetDraft) => void;
  discardDraft: () => void;
  saveDraft: () => Promise<StylePreset | undefined>;
  loadPresets: () => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  applyPreset: (id: string) => Promise<void>;
}

export const useStyleStore = create<StyleState>()((set, get) => ({
  referenceId: undefined,
  analysis: undefined,
  analyzeJobId: undefined,
  analyzing: false,
  analyzeError: undefined,
  inferJobId: undefined,
  inferring: false,
  inferError: undefined,
  draft: undefined,
  draftOrigin: undefined,
  draftId: undefined,
  presets: [],
  presetsLoad: "idle",
  applyingId: undefined,
  lastApply: undefined,

  setReference: async (assetId) => {
    set({ referenceId: assetId, analysis: undefined, analyzeError: undefined });
    if (!assetId) return;
    try {
      const list = await styleApi.analyses(assetId);
      const latest = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest && get().referenceId === assetId) set({ analysis: latest });
    } catch {
      // no previous analysis (or old api): the user presses «Analizar»
    }
  },

  analyze: async () => {
    const assetId = get().referenceId;
    if (!assetId || get().analyzing) return;
    set({ analyzing: true, analyzeError: undefined });
    addBreadcrumb("ui", "Analizar video de referencia", { assetId });
    try {
      const { jobId } = await styleApi.analyze(assetId);
      set({ analyzeJobId: jobId });
      const job = await waitForJob(jobId, "style.analyze");
      const result = job.result as StyleAnalyzeJobResult;
      const record = await styleApi.analysis(result.analysisId).catch((): StyleAnalysisRecord => ({
        id: result.analysisId,
        name: "Análisis",
        path: result.path,
        sourceAssetId: assetId,
        createdAt: new Date().toISOString(),
        analysis: result.analysis,
      }));
      if (get().referenceId === assetId) set({ analysis: record });
    } catch (err) {
      set({ analyzeError: errorMessage(err) });
    } finally {
      set({ analyzing: false, analyzeJobId: undefined });
    }
  },

  inferLocal: async () => {
    const analysis = get().analysis;
    if (!analysis || get().inferring) return;
    set({ inferring: true, inferError: undefined });
    try {
      // 409 PACK_REQUIRED (vision-llm) opens «Paquete requerido» and retries after the download.
      const result = await runWithPack(async () => {
        const { jobId } = await styleApi.infer(analysis.id);
        set({ inferJobId: jobId });
        const job = await waitForJob(jobId, "style.infer");
        return job.result as StyleInferJobResult;
      });
      if (result)
        set({
          draft: { ...result.preset },
          draftOrigin: "local-llm",
          draftId: undefined,
        });
    } catch (err) {
      set({ inferError: errorMessage(err) });
    } finally {
      set({ inferring: false, inferJobId: undefined });
    }
  },

  askClaude: (referenceName) => {
    const analysis = get().analysis;
    if (!analysis) return;
    pasteToConsole(claudeStylePrompt(analysis, referenceName));
    addBreadcrumb("ui", "Pegó el pedido de estilo en la Consola Claude", {
      analysisId: analysis.id,
    });
    toast.info("Pedido pegado en la Consola Claude", {
      description:
        "Revisalo y apretá Enter. Cuando Claude guarde el perfil, tocá «Actualizar» en Perfiles.",
    });
  },

  newDraft: () =>
    set({
      draft: structuredClone(DEFAULT_STYLE_PRESET),
      draftOrigin: "manual",
      draftId: undefined,
    }),

  editPreset: (preset) => {
    const { id, source, created_at: _c, updated_at: _u, ...draft } = preset;
    set({ draft: draft as StylePresetDraft, draftOrigin: source?.via ?? "manual", draftId: id });
  },

  updateDraft: (fn) => {
    const d = get().draft;
    if (d) set({ draft: fn(structuredClone(d)) });
  },

  discardDraft: () => set({ draft: undefined, draftOrigin: undefined, draftId: undefined }),

  saveDraft: async () => {
    const { draft, draftOrigin, draftId, analysis, referenceId } = get();
    if (!draft) return undefined;
    const v = validateStylePreset(draft);
    if (!v.ok) {
      toast.error("El perfil tiene datos inválidos", { description: v.errors.join(" · ") });
      return undefined;
    }
    const source: StylePresetSource = {
      ...(draftOrigin && { via: draftOrigin }),
      ...(analysis && { analysisId: analysis.id, analysis_path: analysis.path }),
      ...((analysis?.sourceAssetId ?? referenceId) && {
        assetId: analysis?.sourceAssetId ?? referenceId,
      }),
    };
    try {
      const saved = await styleApi.save({
        ...v.preset,
        ...(draftId && { id: draftId }),
        ...(Object.keys(source).length > 0 && { source }),
      });
      set((s) => ({
        presets: [saved, ...s.presets.filter((p) => p.id !== saved.id)],
        draft: undefined,
        draftOrigin: undefined,
        draftId: undefined,
      }));
      toast.success(`Perfil guardado: ${saved.name}`);
      return saved;
    } catch (err) {
      toast.error("No se pudo guardar el perfil", { description: errorMessage(err) });
      return undefined;
    }
  },

  loadPresets: async () => {
    set({ presetsLoad: get().presetsLoad === "ready" ? "ready" : "loading" });
    try {
      set({ presets: await styleApi.presets(), presetsLoad: "ready" });
    } catch (err) {
      set({ presetsLoad: isNotImplemented(err) ? "not-implemented" : "error" });
    }
  },

  deletePreset: async (id) => {
    try {
      await styleApi.remove(id);
      set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
    } catch (err) {
      toast.error("No se pudo borrar el perfil", { description: errorMessage(err) });
    }
  },

  applyPreset: async (id) => {
    if (get().applyingId) return;
    set({ applyingId: id });
    try {
      await saveProjectNow(); // the api compiles against the saved project
      const projectId = useProjectStore.getState().project.id;
      const res = await styleApi.apply(id, projectId);
      set({ lastApply: res });
      useAgentStore.getState().receivePlan(res.plan);
      showPanel("assistant");
      focusAssistant();
      addBreadcrumb("ui", "Aplicó un perfil de estilo (plan propuesto)", {
        presetId: id,
        planId: res.planId,
      });
      toast.success("Plan del estilo listo en el Asistente", {
        description: "Revisá las operaciones y confirmá con «Aplicar».",
      });
    } catch (err) {
      toast.error("No se pudo aplicar el perfil", { description: errorMessage(err) });
    } finally {
      set({ applyingId: undefined });
    }
  },
}));
