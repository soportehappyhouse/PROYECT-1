import { API_ROUTES, SPRINT6_MODULES } from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { sprint6NotImplemented } from "../lib/errors.js";

/**
 * Sprint 6 M1 Guion (docs/trabajo/sprint6-contratos.md): word-level script of a project.
 * Paso 0 stubs (501 NOT_IMPLEMENTED); M1 owns this file and replaces them:
 *   GET  script            -> Script
 *   POST scriptTranscribe  ScriptTranscribeRequest -> 202 JobAccepted (script.transcribe)
 *   POST scriptCuts        ScriptCutsRequest -> ScriptCutsResponse (does not apply)
 *   POST scriptFit         FitDurationRequest -> FitDurationPreview (does not apply)
 */
export const scriptRoutes: FastifyPluginAsync = async (app) => {
  const stub = (_req: unknown, reply: Parameters<typeof sprint6NotImplemented>[0]) =>
    sprint6NotImplemented(reply, SPRINT6_MODULES.M1);
  app.get(API_ROUTES.script, stub);
  app.post(API_ROUTES.scriptTranscribe, stub);
  app.post(API_ROUTES.scriptCuts, stub);
  app.post(API_ROUTES.scriptFit, stub);
};
