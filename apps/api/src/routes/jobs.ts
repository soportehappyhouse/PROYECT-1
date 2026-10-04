import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, JobStatusSchema, JobTypeSchema } from "@studio/shared";
import { z } from "zod";
import { errorBody, notImplemented } from "../lib/errors.js";

const ListQuery = z.object({
  status: JobStatusSchema.optional(),
  type: JobTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.jobs, async (req) => {
    const q = ListQuery.parse(req.query);
    return app.ctx.jobs.list({
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
      ...(q.limit && { limit: q.limit }),
    });
  });

  // TODO(module-b): raw SSE (reply.hijack(); text/event-stream; no plugin) — subscribe to
  // app.ctx.queue "job" events and write `data: <JobEvent>\n\n`, heartbeat comment every 15 s.
  // Registered before :id so "events" is not captured as an id.
  app.get(API_ROUTES.jobEvents, async (_req, reply) => notImplemented(reply, "module-b"));

  app.get<{ Params: { id: string } }>(API_ROUTES.job, async (req, reply) => {
    const job = app.ctx.jobs.get(req.params.id);
    return job ?? reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.jobCancel, async (req, reply) => {
    const job = app.ctx.queue.cancel(req.params.id);
    return job ?? reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
  });
};
