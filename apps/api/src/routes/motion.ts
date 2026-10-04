import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const motionRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.motionEngines, async () => app.ctx.motion.status());
  app.get(API_ROUTES.motionTemplates, async () => app.ctx.motion.listTemplates());
  // TODO(module-c): validate MotionSpecSchema, enqueue "motion.render" (handler calls app.ctx.motion.render).
  app.post(API_ROUTES.motionRender, async (_req, reply) => notImplemented(reply, "module-c"));
};
