import type { AgentPlanRequest, JobAccepted, Project } from "@studio/shared";
import {
  AGENT_ROUTES,
  type AgentApplyRequest,
  type AgentBugreportRequest,
  type AgentBugreportResponse,
  type AgentEvalRequest,
  type AgentPlanRecord,
  type AgentStatus,
} from "./agent-types";
import { apiFetch, type Accepted } from "./api";

/** Some list routes answer `{items}` / `{plans}`, others a bare array. */
function listOf<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const r = raw as { items?: unknown; plans?: unknown } | null | undefined;
  const list = r?.items ?? r?.plans;
  return Array.isArray(list) ? (list as T[]) : [];
}

/**
 * `POST /api/agent/plan` may answer the AgentPlan record flat or as `{plan: AgentPlan, ...}`
 * (with the validation fields next to it): both become one AgentPlanRecord.
 */
export function normalizePlanRecord(raw: unknown): AgentPlanRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inner = r.plan as Record<string, unknown> | undefined;
  // {plan: AgentPlanRecord}: the inner object has its own `plan` (the EditPlan).
  const record =
    inner && typeof inner === "object" && "plan" in inner && "id" in inner ? { ...r, ...inner } : r;
  const id = (record.id ?? record.planId) as string;
  const arr = (k: string) => (Array.isArray(record[k]) ? (record[k] as unknown[]) : []);
  return {
    ...(record as unknown as AgentPlanRecord),
    id,
    ok: record.ok !== false,
    resolved: arr("resolved") as AgentPlanRecord["resolved"],
    preview_es: arr("preview_es") as string[],
    risks: arr("risks") as string[],
    unresolved: arr("unresolved") as string[],
    errors: arr("errors") as string[],
    warnings: arr("warnings") as string[],
    status: (record.status as AgentPlanRecord["status"]) ?? "proposed",
    created_at: (record.created_at as string) ?? new Date().toISOString(),
  };
}

/** Sprint 3 routes (docs/trabajo/sprint3-contratos.md, «API»). */
export const agentApi = {
  status: () => apiFetch<AgentStatus>(AGENT_ROUTES.status),
  plan: async (body: AgentPlanRequest) =>
    normalizePlanRecord(await apiFetch<unknown>(AGENT_ROUTES.plan, { method: "POST", json: body })),
  /** Job agent.apply (lane edit); result {applied, failed?, undoSnapshotId}. */
  apply: (body: AgentApplyRequest) =>
    apiFetch<JobAccepted>(AGENT_ROUTES.apply, { method: "POST", json: body }),
  plans: async (projectId?: string) =>
    listOf<unknown>(
      await apiFetch<unknown>(AGENT_ROUTES.plans, { query: { projectId, limit: 50 } }),
    ).map(normalizePlanRecord),
  reject: (id: string) =>
    apiFetch<unknown>(AGENT_ROUTES.reject, { method: "POST", params: { id } }),
  /** «Deshacer todo»: restores the undo snapshot taken before agent.apply -> {project, plan}. */
  undo: (id: string, undoSnapshotId?: string) =>
    apiFetch<{ project?: Project; plan?: unknown } | undefined>(AGENT_ROUTES.undo, {
      method: "POST",
      params: { id },
      json: undoSnapshotId ? { undoSnapshotId } : {},
    }),
  /** Job agent.eval -> storage/run/agent-eval.json. */
  evaluate: (body: AgentEvalRequest) =>
    apiFetch<Accepted<unknown>>(AGENT_ROUTES.eval, { method: "POST", json: body }),
  /** Last eval results (404 when it never ran). */
  lastEval: () => apiFetch<unknown>(AGENT_ROUTES.eval),
  bugreport: (body: AgentBugreportRequest) =>
    apiFetch<AgentBugreportResponse>(AGENT_ROUTES.bugreport, { method: "POST", json: body }),
};
