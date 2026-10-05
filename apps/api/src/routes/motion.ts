import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, type JobAccepted, MotionRenderRequestSchema } from "@studio/shared";
import { HttpError } from "../lib/errors.js";

/**
 * Motion graphics (module c).
 * - GET engines: status + capability flags; GET templates: every engine's templates (engine id +
 *   JSON Schema of props + defaults + thumbnail composition).
 * - POST render: MotionSpec (+ optional target {projectId, clipId}) -> pre-flight validation (template, format, fps, props) -> 202 {jobId}.
 */
export const motionRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  // Registry (with REMOTION_ENGINE_OPTIONS) and the motion.render handler are set up in app.ts.

  app.get(API_ROUTES.motionEngines, async () => ctx.motion.status());
  app.get(API_ROUTES.motionTemplates, async () => ctx.motion.listTemplates());
  app.post(API_ROUTES.motionRender, async (req, reply) => {
    const { target, ...spec } = MotionRenderRequestSchema.parse(req.body ?? {});
    const validation = ctx.motion.validate(spec);
    if (!validation.ok)
      throw new HttpError(400, "VALIDATION_ERROR", "Especificación de motion inválida", {
        engine: validation.engine,
        errors: validation.errors,
      });
    const job = ctx.queue.enqueue({
      type: "motion.render",
      payload: { ...spec, ...(target && { target }) },
      ...(target && { projectId: target.projectId }),
    });
    return reply.code(202).send({ jobId: job.id } satisfies JobAccepted);
  });
};
