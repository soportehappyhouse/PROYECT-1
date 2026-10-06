import {
  STEMS_API_ROUTES,
  STEMS_JOB_TYPE,
  STEMS_PACK_ID,
  StemsRequestSchema,
  StemsResultSchema,
  StemsUndoRequestSchema,
  type StemsUndoResponse,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { requirePack } from "../jobs/handlers/ai.js";
import { resolveStemsSource } from "../jobs/handlers/audio-stems.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { projectContentHash } from "../services/agent/project-hash.js";

/**
 * Sprint 3b audio routes (docs/trabajo/sprint3b-contratos.md §C): «Separar audio» (job audio.stems,
 * pack stems: 409 PACK_REQUIRED before enqueueing) and «Deshacer separación» (restores the agent
 * snapshot the job stored; 409 PROJECT_CHANGED when the project was edited since, unless force).
 */
export const audioRoutes: FastifyPluginAsync = async (app) => {
  const { workers, queue, repos, jobs } = app.ctx;

  app.post(STEMS_API_ROUTES.stems, async (req, reply) => {
    const body = StemsRequestSchema.parse(req.body);
    resolveStemsSource(app.ctx, body); // 404 / 400 before the pack check
    await requirePack(workers, STEMS_PACK_ID);
    const job = queue.enqueue({
      type: STEMS_JOB_TYPE,
      payload: body,
      ...(body.target && { projectId: body.target.projectId }),
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post(STEMS_API_ROUTES.undo, async (req, reply): Promise<StemsUndoResponse> => {
    const body = StemsUndoRequestSchema.parse(req.body ?? {});
    const snap = repos.agentPlans.getSnapshot(body.undoSnapshotId);
    const jobId = snap?.planId?.startsWith("stems:") ? snap.planId.slice(6) : undefined;
    if (!snap || !jobId)
      return reply
        .code(404)
        .send(errorBody("NOT_FOUND", "No hay ninguna separación para deshacer"));
    const current = repos.projects.get(snap.projectId);
    if (!current) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const parsed = StemsResultSchema.safeParse(jobs.get(jobId)?.result);
    const postHash = parsed.success ? parsed.data.postEditHash : undefined;
    if (!body.force && postHash && projectContentHash(current) !== postHash)
      throw new HttpError(
        409,
        "PROJECT_CHANGED",
        "El proyecto cambió después de separar el audio; si deshacés se pierden esos cambios. " +
          "Mandá force: true para deshacer igual. (Los audios separados quedan en Media.)",
        { updatedAt: current.updatedAt },
      );
    const project = repos.projects.save(snap.projectId, snap.project);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    return { project };
  });
};
