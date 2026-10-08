import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import {
  API_ROUTES,
  CreateProjectSchema,
  duplicateProjectName,
  ExportRequestSchema,
  ProjectDuplicateSchema,
  ProjectPatchSchema,
  projectSummary,
  type Project,
} from "@studio/shared";
import { errorBody } from "../lib/errors.js";
import { exportBlockersMessage, findExportBlockers } from "../services/ffmpeg/timeline.js";

/** Projects CRUD (Project JSON documents), autosave snapshots and export jobs. */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  const { repos, queue } = app.ctx;
  const notFound = () => errorBody("NOT_FOUND", "Proyecto no encontrado");

  /** Sprint 5: `?view=summary` -> ProjectSummary[] (newest first); without it Project[] as before. */
  app.get<{ Querystring: { view?: string } }>(API_ROUTES.projects, async (req) => {
    const projects = repos.projects
      .list()
      .map((p) => repos.projects.get(p.id))
      .filter((p) => p !== undefined);
    if (req.query.view !== "summary") return projects;
    return projects.map((p) => projectSummary(p, (id) => repos.media.get(id)));
  });

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

  /** Sprint 5: rename (ProjectPatch) -> ProjectSummary. */
  app.patch<{ Params: { id: string } }>(API_ROUTES.project, async (req, reply) => {
    const body = ProjectPatchSchema.parse(req.body);
    const current = repos.projects.get(req.params.id);
    if (!current) return reply.code(404).send(projectNotFound(req.params.id));
    const saved = repos.projects.save(current.id, { ...current, name: body.name });
    if (!saved) return reply.code(404).send(projectNotFound(req.params.id));
    return projectSummary(saved, (id) => repos.media.get(id));
  });

  /** Sprint 5: copy with new track/clip ids and the same assets -> 201 Project. */
  app.post<{ Params: { id: string } }>(API_ROUTES.projectDuplicate, async (req, reply) => {
    const body = ProjectDuplicateSchema.parse(req.body ?? {});
    const source = repos.projects.get(req.params.id);
    if (!source) return reply.code(404).send(projectNotFound(req.params.id));
    const name = body.name ?? duplicateProjectName(source.name);
    const created = repos.projects.create({ name, settings: source.settings });
    const saved = repos.projects.save(created.id, { ...withNewIds(source), name });
    return reply.code(201).send(saved ?? created);
  });

  app.delete<{ Params: { id: string } }>(API_ROUTES.project, async (req, reply) => {
    return repos.projects.delete(req.params.id)
      ? reply.code(204).send()
      : reply.code(404).send(notFound());
  });

  /** Crash-recovery snapshot (does not modify the saved project; cleared on PUT). */
  app.put<{ Params: { id: string } }>(API_ROUTES.projectAutosave, async (req, reply) => {
    return repos.projects.autosave(req.params.id, req.body) ?? reply.code(404).send(notFound());
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.projectAutosave, async (req, reply) => {
    const snap = repos.projects.getAutosave(req.params.id);
    return snap
      ? { projectId: req.params.id, savedAt: snap.savedAt, project: snap.project }
      : reply.code(404).send(errorBody("NOT_FOUND", "Sin autoguardado"));
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.projectExport, async (req, reply) => {
    const body = ExportRequestSchema.parse(req.body);
    const project = repos.projects.get(req.params.id);
    if (!project) return reply.code(404).send(notFound());
    if (!repos.presets.get(body.presetId))
      return reply.code(404).send(errorBody("NOT_FOUND", "Preset de exportación no encontrado"));
    // B3/B4: never drop unrendered motion clips or deleted media silently.
    const problems = findExportBlockers(project, (id) => !!repos.media.get(id), body.range);
    const blocked = exportBlockersMessage(problems);
    if (blocked) return reply.code(409).send(errorBody("EXPORT_BLOCKED", blocked, { problems }));
    const job = queue.enqueue({
      type: "project.export",
      payload: { ...body, projectId: req.params.id },
      projectId: req.params.id,
    });
    return reply.code(202).send({ jobId: job.id });
  });
};

/** Sprint 5: 404 of the project routes (PROJECT_NOT_FOUND, Spanish message). */
function projectNotFound(id: string) {
  return errorBody("PROJECT_NOT_FOUND", `No existe el proyecto ${id} (¿se borró?).`, { id });
}

/** Deep copy of a project with fresh track and clip ids (clips follow their track). */
export function withNewIds(source: Project): Project {
  const copy = structuredClone(source);
  for (const track of copy.tracks) {
    track.id = nanoid();
    for (const clip of track.clips) {
      clip.id = nanoid();
      clip.trackId = track.id;
    }
  }
  return copy;
}
