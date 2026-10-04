import type { FastifyPluginAsync } from "fastify";
import {
  API_ROUTES,
  API_ROUTES_EXT,
  CreateProjectSchema,
  ExportRequestSchema,
} from "@studio/shared";
import { errorBody } from "../lib/errors.js";

/** Projects CRUD (Project JSON documents), autosave snapshots and export jobs. */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  const { repos, queue } = app.ctx;
  const notFound = () => errorBody("NOT_FOUND", "Proyecto no encontrado");

  app.get(API_ROUTES.projects, async () =>
    repos.projects
      .list()
      .map((p) => repos.projects.get(p.id))
      .filter((p) => p !== undefined),
  );

  app.post(API_ROUTES.projects, async (req, reply) => {
    const body = CreateProjectSchema.parse(req.body);
    return reply.code(201).send(repos.projects.create(body));
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.project, async (req, reply) => {
    return repos.projects.get(req.params.id) ?? reply.code(404).send(notFound());
  });

  /** Full replace (validated with ProjectSchema); the server owns id/createdAt/updatedAt. */
  app.put<{ Params: { id: string } }>(API_ROUTES.project, async (req, reply) => {
    return repos.projects.save(req.params.id, req.body) ?? reply.code(404).send(notFound());
  });

  app.delete<{ Params: { id: string } }>(API_ROUTES.project, async (req, reply) => {
    return repos.projects.delete(req.params.id)
      ? reply.code(204).send()
      : reply.code(404).send(notFound());
  });

  /** Crash-recovery snapshot (does not modify the saved project; cleared on PUT). */
  app.put<{ Params: { id: string } }>(API_ROUTES_EXT.projectAutosave, async (req, reply) => {
    return repos.projects.autosave(req.params.id, req.body) ?? reply.code(404).send(notFound());
  });

  app.get<{ Params: { id: string } }>(API_ROUTES_EXT.projectAutosave, async (req, reply) => {
    const snap = repos.projects.getAutosave(req.params.id);
    return snap
      ? { projectId: req.params.id, savedAt: snap.savedAt, project: snap.project }
      : reply.code(404).send(errorBody("NOT_FOUND", "Sin autoguardado"));
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.projectExport, async (req, reply) => {
    const body = ExportRequestSchema.parse(req.body);
    if (!repos.projects.get(req.params.id)) return reply.code(404).send(notFound());
    if (!repos.presets.get(body.presetId))
      return reply.code(404).send(errorBody("NOT_FOUND", "Preset de exportación no encontrado"));
    const job = queue.enqueue({
      type: "project.export",
      payload: { ...body, projectId: req.params.id },
      projectId: req.params.id,
    });
    return reply.code(202).send({ jobId: job.id });
  });
};
