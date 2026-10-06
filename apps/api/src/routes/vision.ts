import { rm } from "node:fs/promises";
import {
  API_ROUTES,
  FEATURE_PACKS,
  SamPointsRequestSchema,
  SamPropagateRequestSchema,
  SamSessionRequestSchema,
  TrackToKeyframesRequestSchema,
  VisionMatteRequestSchema,
  VisionReframeRequestSchema,
  VisionTrackRequestSchema,
  type JobType,
  type SamPointsResponse,
  type SamSessionResponse,
} from "@studio/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { requirePack, toPackRequired } from "../jobs/handlers/ai.js";
import { reframeSourceClip, resolveTrackMethod } from "../jobs/handlers/vision.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { resolveStoragePath } from "../services/storage.js";
import { copyIntoMasks, MASKS_SUBDIR, safeSegment } from "../services/vision-assets.js";
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

/** SAM sessions opened through the api: session id -> asset (for vision.mask results). */
const samSessions = new Map<string, { assetId: string; points: number }>();

/**
 * Sprint 2 vision routes (/api/ai/vision/*, /api/ai/timeline/track-to-keyframes). Long work
 * answers 202 {jobId}; the SAM session calls are synchronous proxies (the mask PNG is copied to
 * storage/masks/<session>/ and served by /files).
 */
export const visionRoutes: FastifyPluginAsync = async (app) => {
  const { workers, queue, repos, config } = app.ctx;
  const accepted = (reply: FastifyReply, type: JobType, payload: unknown, projectId?: string) => {
    const job = queue.enqueue({
      type,
      payload,
      ...(projectId && { projectId }),
      ...(type === "timeline.track-to-keyframes" && { priority: 2 }),
    });
    return reply.code(202).send({ jobId: job.id });
  };
  const requireProject = (id: string) => {
    const p = repos.projects.get(id);
    if (!p) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
    return p;
  };
  const requireClip = (projectId: string, clipId: string) => {
    const clip = requireProject(projectId)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clipId);
    if (!clip) throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
    return clip;
  };

  app.post(API_ROUTES.aiVisionMatte, async (req, reply) => {
    const body = VisionMatteRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "video" && asset.kind !== "image")
      throw new HttpError(400, "BAD_REQUEST", "Quitar el fondo necesita un video o una imagen");
    if (asset.kind === "video" && body.model === "birefnet")
      throw new HttpError(400, "BAD_REQUEST", "Para video se usa RobustVideoMatting (rvm)");
    if (body.target) requireClip(body.target.projectId, body.target.clipId);
    for (const id of [body.background?.value].filter(
      (v): v is string =>
        !!v && (body.background?.type === "image" || body.background?.type === "video"),
    ))
      requireMediaAsset(app.ctx, id);
    if (body.maskAssetId) requireMediaAsset(app.ctx, body.maskAssetId);
    await requirePack(
      workers,
      asset.kind === "image"
        ? FEATURE_PACKS.mattingImage
        : body.quality === "high"
          ? FEATURE_PACKS.mattingHq
          : FEATURE_PACKS.matting,
    );
    return accepted(reply, "vision.matte", body, body.target?.projectId);
  });

  app.post(API_ROUTES.aiVisionSamSession, async (req, reply) => {
    const body = SamSessionRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "video" && asset.kind !== "image")
      throw new HttpError(400, "BAD_REQUEST", "La máscara por clic necesita un video o una imagen");
    await requirePack(workers, FEATURE_PACKS.sam2);
    const res = await proxy(() =>
      workers.samSession({
        path: asset.path,
        ...(body.frameRange && { frame_range: body.frameRange }),
      }),
    );
    samSessions.set(res.session_id, { assetId: asset.id, points: 0 });
    const out: SamSessionResponse = {
      sessionId: res.session_id,
      assetId: asset.id,
      frames: res.frames,
      fps: res.fps,
    };
    return reply.code(201).send(out);
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.aiVisionSamPoints, async (req) => {
    const body = SamPointsRequestSchema.parse(req.body);
    const id = req.params.id;
    const res = await proxy(() =>
      workers.samPoints(id, { frame: body.frame, points: body.points, obj_id: body.objId }),
    );
    const session = samSessions.get(id) ?? { assetId: "", points: 0 };
    session.points++;
    samSessions.set(id, session);
    // New name per call: the browser must not show a cached mask of an earlier click.
    const maskPath = await copyIntoMasks(
      config.storageDir,
      res.mask_png_path,
      id,
      `f${body.frame}-o${body.objId}-${session.points}.png`,
    ).catch((err: unknown) => {
      throw new HttpError(502, "WORKERS_BAD_OUTPUT", `Máscara no encontrada: ${String(err)}`);
    });
    const out: SamPointsResponse = {
      frame: body.frame,
      objId: body.objId,
      maskPath,
      maskUrl: `/files/${maskPath}`,
      ...(res.bbox && { bbox: res.bbox }),
    };
    return out;
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.aiVisionSamPropagate, async (req, reply) => {
    const body = SamPropagateRequestSchema.parse(req.body ?? {});
    const assetId = body.assetId ?? (samSessions.get(req.params.id)?.assetId || undefined);
    if (assetId) requireMediaAsset(app.ctx, assetId);
    return accepted(reply, "vision.mask", {
      ...body,
      sessionId: req.params.id,
      ...(assetId && { assetId }),
    });
  });

  /**
   * Close a SAM session. Workers: frees the extracted frames (storage/tmp/sam/<id>) and the model;
   * what propagate produced stays (alpha WebM in renders/sam/<id>, masks copied to masks/<job>,
   * track.json in renders/) because those are assets. Here: the per-click preview masks
   * (masks/<session>/) are removed. Idempotent: an unknown / expired session answers
   * `{deleted: false}` (the web closes sessions on unmount and may race the 30-min expiry).
   */
  app.delete<{ Params: { id: string } }>(API_ROUTES.aiVisionSamSessionItem, async (req) => {
    const id = req.params.id;
    let deleted = true;
    try {
      await proxy(() => workers.samDelete(id));
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
      deleted = false;
    }
    samSessions.delete(id);
    await rm(resolveStoragePath(config.storageDir, `${MASKS_SUBDIR}/${safeSegment(id)}`), {
      recursive: true,
      force: true,
    });
    return { deleted };
  });

  app.post(API_ROUTES.aiVisionTrack, async (req, reply) => {
    const body = VisionTrackRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "video")
      throw new HttpError(400, "BAD_REQUEST", "El seguimiento necesita un video");
    if (body.maskAssetId) requireMediaAsset(app.ctx, body.maskAssetId);
    if (body.target) requireClip(body.target.projectId, body.target.clipId);
    if (body.method === "sam2") await requirePack(workers, FEATURE_PACKS.sam2);
    // "auto": SAM 2 when its pack is installed, else CSRT/template (decided here, kept in the job)
    const method = await resolveTrackMethod(workers, body.method);
    return accepted(reply, "vision.track", { ...body, method }, body.target?.projectId);
  });

  app.post(API_ROUTES.aiVisionReframe, async (req, reply) => {
    const body = VisionReframeRequestSchema.parse(req.body);
    const clip = reframeSourceClip(requireProject(body.projectId), body.clipId);
    requireMediaAsset(app.ctx, clip.assetId!);
    if (body.subject === "track") {
      if (!body.trackAssetId)
        return reply
          .code(400)
          .send(errorBody("BAD_REQUEST", "Elegí un seguimiento (trackAssetId)"));
      requireMediaAsset(app.ctx, body.trackAssetId);
    } else await requirePack(workers, FEATURE_PACKS.reframe);
    return accepted(reply, "vision.reframe", body, body.projectId);
  });

  app.post(API_ROUTES.aiTrackToKeyframes, async (req, reply) => {
    const body = TrackToKeyframesRequestSchema.parse(req.body);
    const clip = requireClip(body.projectId, body.clipId);
    if (!clip.trackRef) throw new HttpError(400, "BAD_REQUEST", "El clip no sigue ningún objeto");
    requireMediaAsset(app.ctx, clip.trackRef.assetId);
    return accepted(reply, "timeline.track-to-keyframes", body, body.projectId);
  });
};
