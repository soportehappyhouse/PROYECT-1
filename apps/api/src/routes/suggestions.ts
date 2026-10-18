import { API_ROUTES, SPRINT6_MODULES } from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { sprint6NotImplemented } from "../lib/errors.js";

/**
 * Sprint 6 M3 Sugerencias (docs/trabajo/sprint6-contratos.md): proactive suggestions after an
 * import. Paso 0 stubs (501 NOT_IMPLEMENTED); M3 owns this file and replaces them:
 *   GET  suggestions         -> SuggestionsResponse
 *   POST suggestionPlan      -> AgentPlanRecord (validated + resolved)
 *   POST suggestionDismiss   SuggestionDismissRequest -> ImportSuggestion
 *   POST mediaAnalyze        MediaAnalyzeRequest -> 202 JobAccepted (suggest.analyze)
 *   GET | PUT suggestionSettings -> SuggestionSettings
 */
export const suggestionRoutes: FastifyPluginAsync = async (app) => {
  const stub = (_req: unknown, reply: Parameters<typeof sprint6NotImplemented>[0]) =>
    sprint6NotImplemented(reply, SPRINT6_MODULES.M3);
  app.get(API_ROUTES.suggestions, stub);
  app.post(API_ROUTES.suggestionPlan, stub);
  app.post(API_ROUTES.suggestionDismiss, stub);
  app.post(API_ROUTES.mediaAnalyze, stub);
  app.get(API_ROUTES.suggestionSettings, stub);
  app.put(API_ROUTES.suggestionSettings, stub);
};
