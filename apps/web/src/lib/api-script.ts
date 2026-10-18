import {
  API_ROUTES,
  type AgentPlanRecord,
  type EditPlan,
  type FitDurationPreview,
  type FitDurationRequest,
  type JobAccepted,
  type Script,
  type ScriptCutsRequest,
  type ScriptCutsResponse,
  type ScriptTranscribeRequest,
  type SubtitleSegment,
} from "@studio/shared";
import { normalizePlanRecord } from "./agent-api";
import { apiFetch } from "./api";

/**
 * Sprint 6 M1 «Guion» client (lib/api.ts is not touched: docs/trabajo/sprint6-contratos.md).
 * The script routes read the SAVED project: call `saveProjectNow()` first.
 */

/** `result` of the job script.transcribe (apps/api jobs/handlers/script.ts). */
export interface ScriptTranscribeResult {
  projectId: string;
  clipId: string;
  assetId: string;
  range: { start: number; end: number };
  segments: SubtitleSegment[];
  words: number;
  noise_floor_db: number;
  gaps: number;
  voiced_gaps: number;
  audioPath: string;
  warnings?: string[];
}

/** POST /api/console/plans: validate + resolve + store an EditPlan (same as studio_validate_plan). */
const CONSOLE_PLANS_ROUTE = "/api/console/plans";

export const scriptApi = {
  get: (projectId: string) => apiFetch<Script>(API_ROUTES.script, { params: { id: projectId } }),
  transcribe: (projectId: string, body: Partial<ScriptTranscribeRequest> & { clipId: string }) =>
    apiFetch<JobAccepted>(API_ROUTES.scriptTranscribe, {
      method: "POST",
      params: { id: projectId },
      json: body,
    }),
  cuts: (projectId: string, body: Partial<ScriptCutsRequest>) =>
    apiFetch<ScriptCutsResponse>(API_ROUTES.scriptCuts, {
      method: "POST",
      params: { id: projectId },
      json: body,
    }),
  fit: (projectId: string, body: Partial<FitDurationRequest> & { target_s: number }) =>
    apiFetch<FitDurationPreview>(API_ROUTES.scriptFit, {
      method: "POST",
      params: { id: projectId },
      json: body,
    }),
  /** The Guion «Aplicar» goes through the Assistant: stored plan → history + «Deshacer todo». */
  proposePlan: async (projectId: string, plan: EditPlan, command: string) =>
    normalizePlanRecord(
      await apiFetch<unknown>(CONSOLE_PLANS_ROUTE, {
        method: "POST",
        json: { projectId, plan, command, save: true },
      }),
    ) as AgentPlanRecord,
};
