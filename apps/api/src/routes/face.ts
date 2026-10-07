import {
  API_ROUTES,
  FaceDetectRequestSchema,
  FacePreviewRequestSchema,
  FaceSwapRequestSchema,
  FaceUndoRequestSchema,
  type Project,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../lib/errors.js";
import {
  FACE_LICENCE,
  faceDeps,
  facePreflight,
  findClip,
  restoreClip,
} from "../jobs/handlers/face.js";

/**
 * Sprint 4 M1 «Cambiar cara» routes (docs/trabajo/sprint4-contratos.md «M1 · API»): detect faces
 * in a frame (sync, YuNet in the workers), one-frame preview (job face.preview), the swap (job
 * face.swap, `confirmed: true` = consent + nobody in the video is a minor) and its undo. Preview
 * and swap run the full preflight before enqueueing (the job repeats it when it starts).
 */
export const faceRoutes: FastifyPluginAsync = async (app) => {
  const { repos, queue, workers } = app.ctx;
  const deps = faceDeps(app.ctx);

  app.post(API_ROUTES.faceDetect, async (req) => {
    const body = FaceDetectRequestSchema.parse(req.body);
    const asset = repos.media.get(body.assetId);
    if (!asset) throw new HttpError(404, "NOT_FOUND", `Medio ${body.assetId} no encontrado`);
    if (asset.kind !== "video" && asset.kind !== "image")
      throw new HttpError(400, "BAD_REQUEST", "Las caras se buscan en un video o una imagen");
    const t =
      asset.kind === "image"
        ? 0
        : Math.max(0, Math.min(body.t, Math.max(0, (asset.durationSec ?? body.t) - 0.04)));
    return deps.face.detect(asset.path, Math.round(t * 1000) / 1000);
  });

  app.post(API_ROUTES.facePreview, async (req, reply) => {
    const body = FacePreviewRequestSchema.parse(req.body);
    const packs = await workers.packs().catch(() => undefined);
    const pre = facePreflight(deps, body, "preview", packs);
    const job = queue.enqueue({
      type: "face.preview",
      payload: { ...body, consentId: pre.consent.id, licences: [FACE_LICENCE] },
      priority: 1,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post(API_ROUTES.faceSwap, async (req, reply) => {
    const raw = (req.body ?? {}) as { confirmed?: unknown };
    if (raw.confirmed !== true)
      throw new HttpError(
        409,
        "CONFIRM_REQUIRED",
        "Confirmá que la persona dio su consentimiento y que nadie en el video es menor de edad " +
          "(confirmed: true).",
      );
    const body = FaceSwapRequestSchema.parse(req.body);
    const packs = await workers.packs().catch(() => undefined);
    const pre = facePreflight(deps, body, "swap", packs);
    if (body.target) {
      // Audit fix 18: the same clip AND the same Person (another Person is another job).
      const active = queue.activeJob("face.swap", (p) => {
        const q = p as { target?: { clipId?: string }; personId?: string };
        return q.target?.clipId === body.target!.clipId && q.personId === body.personId;
      });
      if (active) return reply.code(202).send({ jobId: active.id });
    }
    const job = queue.enqueue({
      type: "face.swap",
      payload: { ...body, consentId: pre.consent.id, licences: [FACE_LICENCE] },
      ...(body.target && { projectId: body.target.projectId }),
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post(API_ROUTES.faceUndo, async (req): Promise<Project> => {
    const body = FaceUndoRequestSchema.parse(req.body);
    const project = repos.projects.get(body.projectId);
    if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
    const found = findClip(project, body.clipId);
    if (!found) throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
    const fs = found.clip.faceSwap;
    if (!fs)
      throw new HttpError(
        409,
        "NOTHING_TO_UNDO",
        "Este clip no tiene un cambio de cara para deshacer",
      );
    const restored = restoreClip(found.clip);
    const tracks = project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === restored.id ? restored : c)),
    }));
    // The «cara IA» flag stays while another clip still shows a face-swapped render; otherwise it
    // goes back to what it was before this swap (audit fix 21), not to a forced false.
    const stillAi = tracks.some((t) =>
      t.clips.some(
        (c) =>
          !!c.faceSwap ||
          (!!c.assetId && repos.media.get(c.assetId)?.aiProvenance?.kind === "face"),
      ),
    );
    const next: Project = {
      ...project,
      tracks,
      ...(project.publish && {
        publish: {
          ...project.publish,
          flags: { ...project.publish.flags, aiFace: stillAi || (fs.prevAiFace ?? false) },
        },
      }),
    };
    const saved = repos.projects.save(project.id, next);
    if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
    deps.gate.audit({
      action: "face.undo",
      personId: fs.personId,
      consentId: fs.consentId,
      jobId: fs.jobId,
      data: { projectId: project.id, clipId: body.clipId },
    });
    return saved;
  });
};
