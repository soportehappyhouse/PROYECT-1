import {
  AGENT_PLAN_CHOOSE_ROUTE,
  API_ROUTES,
  AspectChoiceRequiredDetailsSchema,
  ExportJobResultSchema,
  type AgentPlanRecord,
  type AspectChoiceRequiredDetails,
  type AspectFit,
  type ExportJobResult,
  type Job,
} from "@studio/shared";
import { apiFetch, ApiRequestError } from "./api";

/**
 * Sprint 5 M3 client: 409 ASPECT_CHOICE_REQUIRED details, «Abrir carpeta» of an export, the
 * PlanChoices answer of the Asistente and the parsed export result (api.exportProject sends the
 * new ExportRequest fields as they are).
 */

/** `details` of a 409 ASPECT_CHOICE_REQUIRED, or undefined for any other error. */
export function aspectChoiceDetails(err: unknown): AspectChoiceRequiredDetails | undefined {
  if (!(err instanceof ApiRequestError) || err.code !== "ASPECT_CHOICE_REQUIRED") return undefined;
  const parsed = AspectChoiceRequiredDetailsSchema.safeParse(err.body?.error.details);
  return parsed.success ? parsed.data : undefined;
}

/** Open the folder of an export with the file selected (only files under exports/). */
export function revealExport(path: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(API_ROUTES.systemReveal, { method: "POST", json: { path } });
}

/** Pick an option of a pending plan choice; returns the plan record with the new preview. */
export function choosePlanOption(
  planId: string,
  choiceId: string,
  optionId: AspectFit,
): Promise<AgentPlanRecord> {
  return apiFetch<AgentPlanRecord>(AGENT_PLAN_CHOOSE_ROUTE, {
    method: "POST",
    params: { id: planId },
    json: { choiceId, optionId },
  });
}

/** Parsed Sprint 5 result of a finished project.export job. */
export function exportResultOf(job: Pick<Job, "result"> | undefined): ExportJobResult | undefined {
  const parsed = ExportJobResultSchema.safeParse(job?.result);
  return parsed.success ? parsed.data : undefined;
}

/** «12,3 MB» / «850 KB». */
export function formatBytesEs(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(".", ",")} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
