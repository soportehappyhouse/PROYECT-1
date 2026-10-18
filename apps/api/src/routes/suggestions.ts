import {
  API_ROUTES,
  MediaAnalyzeRequestSchema,
  SuggestionDismissRequestSchema,
  type SuggestionSettings,
  type SuggestionsResponse,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { errorBody } from "../lib/errors.js";
import { projectAssetIds, suggestionsService } from "../services/suggestions/service.js";

/**
 * Sprint 6 M3 Sugerencias (docs/trabajo/sprint6-contratos.md):
 *   GET  suggestions         -> SuggestionsResponse (cards recomputed from the stored analyses)
 *   POST suggestionPlan      -> 201 AgentPlanRecord (validated + resolved; the web opens it in the
 *                               Asistente, applying it goes through POST /api/agent/apply)
 *   POST suggestionDismiss   SuggestionDismissRequest -> ImportSuggestion («Ignorar» / «No sugerir más»)
 *   POST mediaAnalyze        MediaAnalyzeRequest -> 202 {jobId} (suggest.analyze, lane background)
 *   GET | PUT suggestionSettings -> SuggestionSettings
 */
export const suggestionRoutes: FastifyPluginAsync = async (app) => {
  const { repos } = app.ctx;
  const svc = suggestionsService(app.ctx);
  const projectNotFound = () => errorBody("NOT_FOUND", "Proyecto no encontrado");

  app.get<{ Params: { id: string } }>(API_ROUTES.suggestions, async (req, reply) => {
    const project = repos.projects.get(req.params.id);
    if (!project) return reply.code(404).send(projectNotFound());
    const suggestions = svc.refresh(project);
    const inProject = new Set(projectAssetIds(project));
    const analyzing = [...svc.analyzingAssets()].filter((id) => inProject.has(id));
    const body: SuggestionsResponse = { suggestions, analyzing };
    return body;
  });

  app.post<{ Params: { id: string; sid: string } }>(
    API_ROUTES.suggestionPlan,
    async (req, reply) => {
      const project = repos.projects.get(req.params.id);
      if (!project) return reply.code(404).send(projectNotFound());
      const record = await svc.plan(project, req.params.sid);
      req.log.info(
        { plan: record.id, suggestion: req.params.sid, ok: record.ok },
        "Sugerencia convertida en plan del asistente",
      );
      return reply.code(201).send(record);
    },
  );

  app.post<{ Params: { id: string; sid: string } }>(
    API_ROUTES.suggestionDismiss,
    async (req, reply) => {
      if (!repos.projects.get(req.params.id)) return reply.code(404).send(projectNotFound());
      const body = SuggestionDismissRequestSchema.parse(req.body ?? {});
      return svc.dismiss(req.params.id, req.params.sid, body.muteKind);
    },
  );

  app.post<{ Params: { id: string } }>(API_ROUTES.mediaAnalyze, async (req, reply) => {
    const asset = repos.media.get(req.params.id);
    if (!asset) return reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
    if (asset.kind !== "video" && asset.kind !== "audio")
      return reply
        .code(400)
        .send(errorBody("NOT_ANALYZABLE", "Solo se pueden analizar videos o audios"));
    const body = MediaAnalyzeRequestSchema.parse(req.body ?? {});
    const job = svc.enqueueAnalysis(asset.id, {
      ...(body.projectId && { projectId: body.projectId }),
      force: body.force,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(API_ROUTES.suggestionSettings, async (): Promise<SuggestionSettings> => svc.settings());
  app.put(API_ROUTES.suggestionSettings, async (req): Promise<SuggestionSettings> =>
    svc.saveSettings(req.body ?? {}),
  );
};
