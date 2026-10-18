import {
  API_ROUTES,
  FitDurationRequestSchema,
  ScriptCutsRequestSchema,
  ScriptTranscribeRequestSchema,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../lib/errors.js";
import { setScriptDeps } from "../services/script/ops.js";
import { computeCuts, computeFit, getScript, type ScriptDeps } from "../services/script/service.js";
import { ensureScriptSchema } from "../services/script/store.js";

/**
 * Sprint 6 M1 Guion (docs/trabajo/sprint6-contratos.md): word-level script of a project.
 *   GET  script            -> Script (computed from project.subtitles[].words + audio artifacts)
 *   POST scriptTranscribe  ScriptTranscribeRequest -> 202 {jobId} (job script.transcribe)
 *   POST scriptCuts        ScriptCutsRequest -> ScriptCutsResponse (does not apply)
 *   POST scriptFit         FitDurationRequest -> FitDurationPreview (+ plan; does not apply)
 * Errors: 404 NOT_FOUND, 409 SCRIPT_EMPTY / SCRIPT_STALE, 422 SCRIPT_NOTHING_TO_CUT.
 */
export const scriptRoutes: FastifyPluginAsync = async (app) => {
  const deps: ScriptDeps = { db: app.ctx.db, storageDir: app.ctx.config.storageDir };
  ensureScriptSchema(deps.db);
  // The agent resolver / agent.apply read the audio artifacts through the same deps.
  setScriptDeps(deps);

  const project = (id: string) => {
    const p = app.ctx.repos.projects.get(id);
    if (!p) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
    return p;
  };

  app.get<{ Params: { id: string } }>(API_ROUTES.script, async (req) =>
    getScript(deps, project(req.params.id)),
  );

  app.post<{ Params: { id: string } }>(API_ROUTES.scriptTranscribe, async (req, reply) => {
    const body = ScriptTranscribeRequestSchema.parse(req.body ?? {});
    const p = project(req.params.id);
    const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === body.clipId);
    if (!clip) throw new HttpError(404, "NOT_FOUND", "El clip no está en el proyecto");
    const asset = clip.assetId ? app.ctx.repos.media.get(clip.assetId) : undefined;
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || asset.hasAudio === false)
      throw new HttpError(400, "BAD_REQUEST", "Ese clip no tiene audio para transcribir");
    const job = app.ctx.queue.enqueue({
      type: "script.transcribe",
      payload: { ...body, projectId: p.id },
      projectId: p.id,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.scriptCuts, async (req) =>
    computeCuts(deps, project(req.params.id), ScriptCutsRequestSchema.parse(req.body ?? {})),
  );

  app.post<{ Params: { id: string } }>(API_ROUTES.scriptFit, async (req) =>
    computeFit(deps, project(req.params.id), FitDurationRequestSchema.parse(req.body ?? {})),
  );
};
