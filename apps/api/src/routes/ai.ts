import {
  AnalyzeScenesRequestSchema,
  AnalyzeSilencesRequestSchema,
  API_ROUTES,
  ApplyCutsRequestSchema,
  DenoiseRequestSchema,
  FEATURE_PACKS,
  LicenceIdSchema,
  type JobType,
} from "@studio/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { readPerfResult, requirePack, toPackRequired } from "../jobs/handlers/ai.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { createConsentGate, licenceRequired } from "../services/persons/gate.js";
import { WorkersError } from "../services/workers-client.js";
import { requireMediaAsset } from "../voice-ai/media-bridge.js";

/** Proxy a workers call: PACK_REQUIRED -> 409 body, other worker errors -> ApiError. */
async function proxy<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = toPackRequired(err);
    if (mapped instanceof WorkersError)
      throw new HttpError(mapped.statusCode, mapped.code, mapped.message);
    throw mapped;
  }
}

/**
 * Sprint 1 AI routes (/api/ai/*, docs/trabajo/sprint1-contratos.md): GPU status, model packs,
 * performance test and the jobs analyze.scenes / analyze.silences / timeline.apply-cuts /
 * audio.denoise. Long work answers 202 {jobId}; progress goes through /api/jobs/events.
 */
export const aiRoutes: FastifyPluginAsync = async (app) => {
  const { workers, queue, repos, config } = app.ctx;
  const gate = createConsentGate(app.ctx.db, config.storageDir);
  const accepted = (reply: FastifyReply, type: JobType, payload: unknown, projectId?: string) => {
    const job = queue.enqueue({
      type,
      payload,
      ...(projectId && { projectId }),
      ...(type === "timeline.apply-cuts" && { priority: 2 }),
    });
    return reply.code(202).send({ jobId: job.id });
  };

  app.get(API_ROUTES.aiGpu, async () => proxy(() => workers.gpuStatus()));

  app.post(API_ROUTES.aiGpuRelease, async () => {
    await proxy(() => workers.gpuRelease());
    return proxy(() => workers.gpuStatus());
  });

  app.get(API_ROUTES.aiPacks, async () => proxy(() => workers.packs()));

  app.post<{ Params: { id: string } }>(API_ROUTES.aiPackDownload, async (req, reply) => {
    const packs = await proxy(() => workers.packs());
    const pack = packs.find((p) => p.id === req.params.id);
    if (!pack)
      return reply.code(404).send(errorBody("NOT_FOUND", `Paquete «${req.params.id}» desconocido`));
    // Sprint 4 M1: packs behind an on-screen licence (faceswap) are not downloaded before it is
    // accepted (criterion 5: nothing of the face swap on disk without the acceptance).
    const licence = LicenceIdSchema.safeParse(pack.licence_gate);
    if (pack.licence_gate && (!licence.success || !gate.isLicenceAccepted(licence.data)))
      throw licenceRequired(licence.success ? licence.data : "faceswap");
    // One download job per pack at a time: reuse the active one.
    const active = queue.activeJob("packs.download", (p) => p.packId === req.params.id);
    if (active) return reply.code(202).send({ jobId: active.id });
    return accepted(reply, "packs.download", { packId: req.params.id });
  });

  app.get(API_ROUTES.aiPerf, async (_req, reply) => {
    const result = await readPerfResult(config.storageDir);
    return (
      result ??
      reply.code(404).send(errorBody("NOT_FOUND", "Todavía no se corrió el test de rendimiento"))
    );
  });
  const perfRun = async (_req: unknown, reply: FastifyReply) => accepted(reply, "perf.run", {});
  app.post(API_ROUTES.aiPerf, perfRun);
  app.post(API_ROUTES.aiPerfRun, perfRun);

  app.post(API_ROUTES.aiAnalyzeScenes, async (req, reply) => {
    const body = AnalyzeScenesRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "video")
      throw new HttpError(400, "BAD_REQUEST", "La detección de escenas necesita un video");
    await requirePack(workers, FEATURE_PACKS.scenes);
    return accepted(reply, "analyze.scenes", body);
  });

  app.post(API_ROUTES.aiAnalyzeSilences, async (req, reply) => {
    const body = AnalyzeSilencesRequestSchema.parse(req.body);
    const project = repos.projects.get(body.projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === body.clipId);
    if (!clip?.assetId)
      return reply.code(404).send(errorBody("NOT_FOUND", "Clip con medio no encontrado"));
    requireMediaAsset(app.ctx, clip.assetId);
    return accepted(reply, "analyze.silences", body, body.projectId);
  });

  app.post(API_ROUTES.aiApplyCuts, async (req, reply) => {
    const body = ApplyCutsRequestSchema.parse(req.body);
    if (!repos.projects.get(body.projectId))
      return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    return accepted(reply, "timeline.apply-cuts", body, body.projectId);
  });

  app.post(API_ROUTES.aiDenoise, async (req, reply) => {
    const body = DenoiseRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "audio" && asset.kind !== "video")
      throw new HttpError(400, "BAD_REQUEST", "Solo se limpia la voz de audio o video");
    await requirePack(workers, FEATURE_PACKS.denoise);
    return accepted(reply, "audio.denoise", body);
  });
};
