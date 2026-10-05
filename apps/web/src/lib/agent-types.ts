import {
  AGENT_DEFAULT_MODEL,
  AGENT_LLM_PACK_ID,
  API_ROUTES,
  type AgentApplyRequest as SharedApplyRequest,
  type EditOp,
  type JobType,
} from "@studio/shared";

/**
 * Sprint 3 (docs/trabajo/sprint3-contratos.md): the local assistant contract lives in
 * @studio/shared (agent.ts). This module only adds web aliases, the routes and what the shared
 * contract does not cover yet (eval results, inline-edited ops).
 */
export type {
  AgentApplyResult,
  AgentEvalRequest,
  AgentBugreportRequest,
  AgentBugreportResponse,
  AgentPlanRecord,
  AgentPlanStatus,
  AgentStatus,
  ClipRef,
  EditOp,
  EditOpName,
  EditPlan,
  Time as AgentTime,
} from "@studio/shared";

/**
 * POST /api/agent/apply. `edited_ops` (additive): the ops with the params the user edited inline,
 * same order as plan.ops; the api validates them again before running.
 * TODO(integration): confirm the api honors `edited_ops` (AgentApplyRequestSchema strips it today).
 */
export interface AgentApplyRequest extends SharedApplyRequest {
  edited_ops?: EditOp[];
}

/** Per-model metrics of the eval (storage/run/agent-eval.json). */
export interface AgentEvalModelResult {
  model: string;
  valid_json_rate?: number;
  schema_valid_rate?: number;
  exact_ops_rate?: number;
  semantic_rate?: number;
  p50_latency_ms?: number;
  failures?: unknown[];
}

/** Sprint 3 routes (API_ROUTES.agent*). */
export const AGENT_ROUTES = {
  status: API_ROUTES.agentStatus,
  plan: API_ROUTES.agentPlan,
  apply: API_ROUTES.agentApply,
  plans: API_ROUTES.agentPlans,
  reject: API_ROUTES.agentPlanReject,
  undo: API_ROUTES.agentPlanUndo,
  eval: API_ROUTES.agentEval,
  bugreport: API_ROUTES.agentBugreport,
} as const;

/** Job types of the assistant. */
export const AGENT_APPLY_JOB: JobType = "agent.apply";
export const AGENT_EVAL_JOB: JobType = "agent.eval";

/** Pack id of the local LLM (Ollama model). */
export const AGENT_PACK_ID = AGENT_LLM_PACK_ID;

/** Models offered in Ajustes → «Asistente local» even before they are installed. */
export const DEFAULT_AGENT_MODELS = [AGENT_DEFAULT_MODEL, "hermes3:8b"] as const;
export const DEFAULT_AGENT_MODEL = AGENT_DEFAULT_MODEL;
export const DEFAULT_AGENT_TEMPERATURE = 0.2;
