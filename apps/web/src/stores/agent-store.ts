import type { Project } from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { saveProjectNow } from "@/hooks/use-project-sync";
import {
  appendAnswers,
  buildApplyRequest,
  destructiveIndexes,
  isDestructive,
  normalizeEvalResults,
  pushHistory,
  setOpParam,
} from "@/lib/agent";
import { agentApi, normalizePlanRecord } from "@/lib/agent-api";
import {
  AGENT_APPLY_JOB,
  AGENT_EVAL_JOB,
  DEFAULT_AGENT_TEMPERATURE,
  type AgentApplyResult,
  type AgentEvalModelResult,
  type AgentPlanRecord,
  type AgentStatus,
  type EditOp,
} from "@/lib/agent-types";
import { api, ApiRequestError, errorMessage, isNotImplemented, packInfoFromBody } from "@/lib/api";
import { JobFailedError, runJob, waitForJob } from "@/lib/job-runner";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";
import { addBreadcrumb } from "./breadcrumbs-store";
import type { LoadStatus } from "./media-store";
import { useMediaStore } from "./media-store";
import { runWithPack, usePacksStore } from "./packs-store";
import { useProjectStore } from "./project-store";

/** Ajustes → «Asistente local» (kept in this browser). */
export interface AgentSettings {
  /** undefined = the api default (qwen3:8b). */
  model: string | undefined;
  temperature: number;
}

/** The plan being reviewed: edited copy of plan.ops + checkboxes + answers to the questions. */
export interface PlanDraft {
  record: AgentPlanRecord;
  ops: EditOp[];
  enabled: boolean[];
  answers: string[];
  /**
   * Checked delete_clip / export ops the user confirmed with «Confirmar borrado/exportación» (a
   * separate click before «Aplicar»). Checking another destructive op asks again.
   */
  confirmed: number[];
}

/** «Deshacer todo» found later edits (409 PROJECT_CHANGED): the dialog asks to restore anyway. */
export interface UndoConflict {
  planId: string;
  message: string;
}

export type ApplyRunStatus = "starting" | "running" | "done" | "failed" | "undoing" | "undone";

export interface ApplyRun {
  planId: string;
  /** Plan indexes sent to the api (confirmed ops). */
  selected: number[];
  jobId?: string;
  status: ApplyRunStatus;
  result?: AgentApplyResult;
  error?: string;
}

interface Persisted {
  model?: string;
  temperature?: number;
  history?: string[];
}

function loadPersisted(): Persisted {
  const raw = readJson<Persisted>(STORAGE_KEYS.agent);
  return raw && typeof raw === "object" ? raw : {};
}

interface AgentState {
  status: AgentStatus | undefined;
  statusLoad: LoadStatus;
  statusError: string | undefined;
  settings: AgentSettings;
  /** Commands sent, oldest first (↑ walks back). */
  commandHistory: string[];
  command: string;
  /** Incremented to focus the command input (Ctrl+Shift+A, palette). */
  focusTick: number;
  proposing: boolean;
  proposeError: string | undefined;
  draft: PlanDraft | undefined;
  run: ApplyRun | undefined;
  undoConflict: UndoConflict | undefined;
  lastLatencyMs: number | undefined;
  lastModel: string | undefined;
  lastRoute: AgentPlanRecord["route"];
  /** Plans of this project, newest first. */
  plans: AgentPlanRecord[];
  /** Plan ids undone with «Deshacer todo» (the api status stays «applied»). */
  undone: Record<string, true>;
  evalResults: AgentEvalModelResult[];
  evalRunning: boolean;
  evalError: string | undefined;

  loadStatus: () => Promise<void>;
  setModel: (model: string | undefined) => void;
  setTemperature: (t: number) => void;
  setCommand: (command: string) => void;
  requestFocus: () => void;
  propose: (command?: string) => Promise<void>;
  receivePlan: (record: AgentPlanRecord) => void;
  toggleOp: (index: number, on?: boolean) => void;
  /** «Confirmar borrado/exportación»: confirms the checked destructive ops. */
  confirmDestructive: () => void;
  setParam: (index: number, key: string, value: unknown) => void;
  setAnswer: (index: number, value: string) => void;
  submitAnswers: () => Promise<void>;
  apply: () => Promise<void>;
  /** `force`: restore even if the project changed after the apply (dialog «¿restaurar igual?»). */
  undoAll: (force?: boolean) => Promise<void>;
  dismissUndoConflict: () => void;
  reject: () => Promise<void>;
  openPlan: (id: string) => void;
  loadHistory: () => Promise<void>;
  runEval: (models: string[]) => Promise<void>;
  loadLastEval: () => Promise<void>;
}

function persist(s: Pick<AgentState, "settings" | "commandHistory">): void {
  writeJson(STORAGE_KEYS.agent, {
    ...(s.settings.model && { model: s.settings.model }),
    temperature: s.settings.temperature,
    history: s.commandHistory,
  } satisfies Persisted);
}

function draftOf(record: AgentPlanRecord): PlanDraft {
  const ops = record.plan?.ops ?? [];
  return {
    record,
    ops: ops.map((op) => ({ ...op })),
    // An op the api could not resolve (resolved[i] === null) starts unchecked, and so do the
    // destructive ones (delete_clip / export): the user checks them and confirms them apart.
    enabled: ops.map((op, i) => record.resolved?.[i] !== null && !isDestructive(op)),
    answers: (record.plan?.questions ?? []).map(() => ""),
    confirmed: [],
  };
}

function upsertPlan(list: AgentPlanRecord[], record: AgentPlanRecord): AgentPlanRecord[] {
  return [record, ...list.filter((p) => p.id !== record.id)].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

/** Read the project the api just edited and adopt it (one local undo step), plus new media. */
async function reloadProject(label: string, given?: Project): Promise<void> {
  const id = useProjectStore.getState().project.id;
  try {
    const remote = given?.id === id ? given : await api.getProject(id);
    useProjectStore.getState().adoptServerProject(remote, label);
  } catch {
    toast.warning("No se pudo releer el proyecto", {
      description: "Recargá la página para ver los cambios del asistente.",
    });
  }
  void useMediaStore
    .getState()
    .refresh()
    .catch(() => undefined);
}

function applyResultOf(raw: unknown): AgentApplyResult | undefined {
  const r = raw as Partial<AgentApplyResult> | null | undefined;
  if (!r || typeof r !== "object" || typeof r.applied !== "number") return undefined;
  return {
    applied: r.applied,
    undoSnapshotId: r.undoSnapshotId ?? "",
    steps: r.steps ?? [],
    ...(r.failed && { failed: r.failed }),
  };
}

const persisted = typeof window === "undefined" ? {} : loadPersisted();

export const useAgentStore = create<AgentState>()((set, get) => ({
  status: undefined,
  statusLoad: "idle",
  statusError: undefined,
  settings: {
    model: persisted.model,
    temperature:
      typeof persisted.temperature === "number" ? persisted.temperature : DEFAULT_AGENT_TEMPERATURE,
  },
  commandHistory: Array.isArray(persisted.history) ? persisted.history : [],
  command: "",
  focusTick: 0,
  proposing: false,
  proposeError: undefined,
  draft: undefined,
  run: undefined,
  undoConflict: undefined,
  lastLatencyMs: undefined,
  lastModel: undefined,
  lastRoute: undefined,
  plans: [],
  undone: {},
  evalResults: [],
  evalRunning: false,
  evalError: undefined,

  loadStatus: async () => {
    set({ statusLoad: get().status ? "ready" : "loading" });
    try {
      const status = await agentApi.status();
      set({ status, statusLoad: "ready", statusError: undefined });
    } catch (err) {
      set({
        statusLoad: isNotImplemented(err) ? "not-implemented" : "error",
        statusError: errorMessage(err),
      });
    }
  },
  setModel: (model) => {
    addBreadcrumb("settings", `Asistente: modelo ${model ?? "por defecto"}`, { model });
    set({ settings: { ...get().settings, model } });
    persist(get());
  },
  setTemperature: (temperature) => {
    set({ settings: { ...get().settings, temperature } });
    persist(get());
  },
  setCommand: (command) => set({ command }),
  requestFocus: () => set({ focusTick: get().focusTick + 1 }),

  propose: async (commandArg) => {
    const command = (commandArg ?? get().command).trim();
    if (!command || get().proposing) return;
    addBreadcrumb("ui", "Asistente: proponer", { length: command.length });
    set({
      proposing: true,
      proposeError: undefined,
      command,
      commandHistory: pushHistory(get().commandHistory, command),
    });
    persist(get());
    try {
      await saveProjectNow();
      const { model, temperature } = get().settings;
      await runWithPack(async () => {
        const p = useProjectStore.getState();
        const record = await agentApi.plan({
          command,
          projectId: p.project.id,
          cursor: p.playhead,
          settings: { ...(model && { model }), temperature },
        });
        get().receivePlan(record);
      });
    } catch (err) {
      set({ proposeError: errorMessage(err) });
    } finally {
      set({ proposing: false });
    }
  },
  receivePlan: (record) => {
    const status = get().status;
    set({
      draft: draftOf(record),
      run: undefined,
      plans: upsertPlan(get().plans, record),
      ...(record.latency_ms != null && { lastLatencyMs: record.latency_ms }),
      ...(record.model && { lastModel: record.model }),
      lastRoute: record.route,
      // The LLM answered: Ollama has the model in memory now (no more «Cargando modelo…»).
      ...(record.route === "llm" && status && { status: { ...status, loaded: true } }),
    });
  },
  toggleOp: (index, on) => {
    const d = get().draft;
    if (!d) return;
    const enabled = d.enabled.map((v, i) => (i === index ? (on ?? !v) : v));
    // Checking or unchecking a delete/export op asks for the confirmation again.
    const confirmed = d.ops[index] && isDestructive(d.ops[index]) ? [] : d.confirmed;
    set({ draft: { ...d, enabled, confirmed } });
  },
  confirmDestructive: () => {
    const d = get().draft;
    if (!d) return;
    const confirmed = destructiveIndexes(d.ops, d.enabled);
    addBreadcrumb("ui", "Asistente: confirmar borrado/exportación", { ops: confirmed.length });
    set({ draft: { ...d, confirmed } });
  },
  setParam: (index, key, value) => {
    const d = get().draft;
    const op = d?.ops[index];
    if (!d || !op) return;
    set({
      draft: { ...d, ops: d.ops.map((o, i) => (i === index ? setOpParam(op, key, value) : o)) },
    });
  },
  setAnswer: (index, value) => {
    const d = get().draft;
    if (!d) return;
    set({ draft: { ...d, answers: d.answers.map((a, i) => (i === index ? value : a)) } });
  },
  submitAnswers: async () => {
    const d = get().draft;
    if (!d) return;
    const command = appendAnswers(d.record.command, d.record.plan?.questions ?? [], d.answers);
    await get().propose(command);
  },

  apply: async () => {
    const d = get().draft;
    if (!d || d.record.status !== "proposed") return;
    const req = buildApplyRequest(
      d.record.id,
      d.record.plan?.ops ?? [],
      d.ops,
      d.enabled,
      useProjectStore.getState().playhead,
      d.confirmed,
    );
    if (req.ops?.length === 0) {
      toast.message("Marcá al menos una operación para aplicar");
      return;
    }
    const pendingConfirm = destructiveIndexes(d.ops, d.enabled).filter(
      (i) => !d.confirmed.includes(i),
    );
    if (pendingConfirm.length > 0) {
      toast.message("Confirmá el borrado o la exportación antes de aplicar");
      return;
    }
    const planId = d.record.id;
    const selected = req.ops ?? [];
    addBreadcrumb("ui", "Asistente: aplicar", { planId, ops: selected.length });
    set({ run: { planId, selected, status: "starting" } });
    /** Keep the user's edits and checkboxes; take preview/risks/resolved from the api. */
    const adoptRecord = (record: AgentPlanRecord) => {
      const cur = get().draft;
      if (cur?.record.id !== planId) return;
      set({
        draft: { ...cur, record, ops: (record.plan?.ops ?? cur.ops).map((op) => ({ ...op })) },
        plans: upsertPlan(get().plans, record),
      });
    };
    const patchRun = (patch: Partial<ApplyRun>) => {
      const run = get().run;
      if (run?.planId === planId) set({ run: { ...run, ...patch } });
    };
    try {
      await saveProjectNow();
      const accepted = await runWithPack(() => agentApi.apply(req));
      if (!accepted) {
        set({ run: undefined }); // «Paquete requerido» is open; it re-runs the call.
        return;
      }
      patchRun({ jobId: accepted.jobId, status: "running" });
      // Inline edits: the api resolved them again; show its preview / risks for what runs now.
      if (accepted.plan) adoptRecord(normalizePlanRecord(accepted.plan));
      let raw: unknown;
      let failure: string | undefined;
      try {
        raw = (await waitForJob(accepted.jobId, AGENT_APPLY_JOB)).result;
      } catch (err) {
        if (!(err instanceof JobFailedError)) throw err;
        raw = err.job.result;
        failure = err.message;
      }
      const result = applyResultOf(raw);
      if (result?.failed) {
        failure = result.failed.error;
        // An op that needed a model pack: offer the download (the user applies again after).
        const pack = packInfoFromBody((result.failed as { packRequired?: unknown }).packRequired);
        if (pack) usePacksStore.getState().openRequest(pack);
      }
      if ((result?.applied ?? 0) > 0 || !failure) await reloadProject("Asistente: aplicó un plan");
      const latest = get().draft?.record.id === planId ? get().draft!.record : d.record;
      const applied: AgentPlanRecord = {
        ...latest,
        status: "applied",
        ...(result?.undoSnapshotId && { undoSnapshotId: result.undoSnapshotId }),
      };
      const undone = { ...get().undone };
      delete undone[planId];
      set({
        undone,
        plans: upsertPlan(get().plans, applied),
        draft:
          get().draft?.record.id === planId ? { ...get().draft!, record: applied } : get().draft,
      });
      patchRun({
        status: failure ? "failed" : "done",
        ...(result && { result }),
        ...(failure && { error: failure }),
      });
      if (failure)
        toast.error("El plan se detuvo", {
          description: `${result?.applied ?? 0} de ${selected.length} aplicadas. ${failure}`,
        });
      else toast.success(`Plan aplicado: ${result?.applied ?? selected.length} operación(es)`);
    } catch (err) {
      // PLAN_UNRESOLVED after inline edits: the api sends the re-resolved plan (new questions).
      const details = (err as ApiRequestError).body?.error.details as
        { plan?: unknown } | undefined;
      if (err instanceof ApiRequestError && details?.plan)
        adoptRecord(normalizePlanRecord(details.plan));
      patchRun({ status: "failed", error: errorMessage(err) });
    }
  },
  dismissUndoConflict: () => set({ undoConflict: undefined }),
  undoAll: async (force = false) => {
    const run = get().run;
    const d = get().draft;
    const planId = run?.planId ?? d?.record.id;
    if (!planId) return;
    const record = get().plans.find((p) => p.id === planId) ?? d?.record;
    const snapshotId = run?.result?.undoSnapshotId || record?.undoSnapshotId || undefined;
    addBreadcrumb("ui", "Asistente: deshacer todo", { planId, force });
    set({ undoConflict: undefined });
    if (run) set({ run: { ...run, status: "undoing" } });
    try {
      // The api compares the project with the state right after the apply: other edits since
      // then would be lost, so it answers 409 PROJECT_CHANGED and we ask (dialog).
      await saveProjectNow();
      const res = await agentApi.undo(planId, snapshotId ?? undefined, force);
      await reloadProject("Asistente: deshizo el plan", res?.project);
      // The api puts the plan back to «proposed»: it can be applied again.
      const back: AgentPlanRecord = res?.plan
        ? normalizePlanRecord(res.plan)
        : { ...(record ?? d!.record), status: "proposed" };
      set({
        undone: { ...get().undone, [planId]: true },
        plans: upsertPlan(get().plans, back),
        draft: get().draft?.record.id === planId ? { ...get().draft!, record: back } : get().draft,
      });
      if (get().run?.planId === planId) set({ run: { ...get().run!, status: "undone" } });
      toast.success("Plan deshecho: el proyecto volvió a como estaba");
    } catch (err) {
      if (get().run?.planId === planId) set({ run: { ...get().run!, status: "done" } });
      if (err instanceof ApiRequestError && err.code === "PROJECT_CHANGED" && !force) {
        set({ undoConflict: { planId, message: errorMessage(err) } });
        return;
      }
      toast.error("No se pudo deshacer", { description: errorMessage(err) });
    }
  },
  reject: async () => {
    const d = get().draft;
    if (!d) return;
    addBreadcrumb("ui", "Asistente: rechazar", { planId: d.record.id });
    const rejected: AgentPlanRecord = { ...d.record, status: "rejected" };
    set({ draft: undefined, run: undefined, plans: upsertPlan(get().plans, rejected) });
    try {
      await agentApi.reject(d.record.id);
    } catch (err) {
      // Not saved on the api (offline / 404): the plan is simply dropped here.
      if (!(err instanceof ApiRequestError)) throw err;
    }
  },
  openPlan: (id) => {
    const record = get().plans.find((p) => p.id === id);
    if (record) set({ draft: draftOf(record), run: undefined });
  },
  loadHistory: async () => {
    try {
      const projectId = useProjectStore.getState().project.id;
      const list = await agentApi.plans(projectId);
      const mine = list.filter((p) => !p.projectId || p.projectId === projectId);
      let plans = get().plans;
      const undone = { ...get().undone };
      for (const p of mine) {
        plans = upsertPlan(plans, p);
        if ((p as { undoneAt?: string }).undoneAt && p.status === "proposed") undone[p.id] = true;
      }
      set({ plans, undone });
    } catch {
      // keep the plans of this session
    }
  },

  runEval: async (models) => {
    set({ evalRunning: true, evalError: undefined });
    addBreadcrumb("ui", "Asistente: evaluar modelos", { models: models.join(",") });
    const fail = (err: unknown) =>
      set({
        evalError: isNotImplemented(err)
          ? "La evaluación todavía no está disponible en la API."
          : errorMessage(err),
      });
    // The whole action goes through runWithPack, so a pack download re-runs the eval and its UI.
    const evaluate = async () => {
      const raw = await runJob(
        () => agentApi.evaluate({ ...(models.length && { models }), dataset: "golden" }),
        AGENT_EVAL_JOB,
      );
      let results = normalizeEvalResults(raw);
      if (results.length === 0) results = normalizeEvalResults(await agentApi.lastEval());
      set({
        evalResults: results,
        evalError: results.length ? undefined : "La evaluación no devolvió resultados.",
      });
    };
    try {
      await runWithPack(evaluate);
    } catch (err) {
      fail(err);
    } finally {
      set({ evalRunning: false });
    }
  },
  loadLastEval: async () => {
    try {
      const results = normalizeEvalResults(await agentApi.lastEval());
      if (results.length) set({ evalResults: results });
    } catch {
      // never ran
    }
  },
}));

/** Show the assistant and focus its command input (Ctrl+Shift+A, command palette). */
export function focusAssistant(): void {
  useAgentStore.getState().requestFocus();
}
