import type { FastifyPluginAsync } from "fastify";
import { createRemotionEngine } from "@studio/motion-engines";
import { REMOTION_ENGINE_OPTIONS } from "@studio/remotion";
import { API_ROUTES, type JobAccepted, MotionSpecSchema } from "@studio/shared";
import { createMotionRenderHandler } from "../jobs/handlers/motion-render.js";
import { HttpError } from "../lib/errors.js";

/**
 * Motion graphics (module c).
 * - GET engines: status + capability flags; GET templates: every engine's templates (engine id +
 *   JSON Schema of props + defaults + thumbnail composition).
 * - POST render: MotionSpec -> pre-flight validation (template, format, fps, props) -> 202 {jobId}.
 */
export const motionRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  // Full Remotion adapter (props validation + Chrome Headless Shell check). Same id -> replaces
  // the minimal one built in app.ts, keeping registry order. No-op once app.ts passes
  // REMOTION_ENGINE_OPTIONS itself.
  ctx.motion.register(createRemotionEngine(REMOTION_ENGINE_OPTIONS));
  if (!ctx.queue.hasHandler("motion.render")) ctx.queue.register(createMotionRenderHandler(ctx));

  app.get(API_ROUTES.motionEngines, async () => ctx.motion.status());
  app.get(API_ROUTES.motionTemplates, async () => ctx.motion.listTemplates());
  app.post(API_ROUTES.motionRender, async (req, reply) => {
    const spec = MotionSpecSchema.parse(req.body ?? {});
    const validation = ctx.motion.validate(spec);
    if (!validation.ok)
      throw new HttpError(400, "VALIDATION_ERROR", "Especificación de motion inválida", {
        engine: validation.engine,
        errors: validation.errors,
      });
    const job = ctx.queue.enqueue({ type: "motion.render", payload: spec });
    return reply.code(202).send({ jobId: job.id } satisfies JobAccepted);
  });
};
