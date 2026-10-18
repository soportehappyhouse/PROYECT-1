import {
  API_ROUTES,
  type ImportSuggestion,
  type JobAccepted,
  type MediaAnalyzeRequest,
  type SuggestionSettings,
  type SuggestionsResponse,
} from "@studio/shared";
import { apiFetch } from "./api";

const route = (r: string, projectId: string, sid?: string) =>
  r.replace(":id", encodeURIComponent(projectId)).replace(":sid", encodeURIComponent(sid ?? ""));

/** Sprint 6 M3 client: suggestions after an import (cards of the Asistente). */
export const suggestionsApi = {
  list: (projectId: string) =>
    apiFetch<SuggestionsResponse>(route(API_ROUTES.suggestions, projectId)),
  /** «Aplicar»: a validated plan (proposed) the Asistente shows; applying it is agent.apply. */
  plan: (projectId: string, sid: string) =>
    apiFetch<unknown>(route(API_ROUTES.suggestionPlan, projectId, sid), {
      method: "POST",
      json: {},
    }),
  dismiss: (projectId: string, sid: string, muteKind = false) =>
    apiFetch<ImportSuggestion>(route(API_ROUTES.suggestionDismiss, projectId, sid), {
      method: "POST",
      json: { muteKind },
    }),
  analyze: (assetId: string, body: Partial<MediaAnalyzeRequest> = {}) =>
    apiFetch<JobAccepted>(API_ROUTES.mediaAnalyze.replace(":id", encodeURIComponent(assetId)), {
      method: "POST",
      json: body,
    }),
  settings: () => apiFetch<SuggestionSettings>(API_ROUTES.suggestionSettings),
  saveSettings: (body: SuggestionSettings) =>
    apiFetch<SuggestionSettings>(API_ROUTES.suggestionSettings, { method: "PUT", json: body }),
};
