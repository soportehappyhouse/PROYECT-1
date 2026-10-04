import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, JobStatusSchema, JobTypeSchema, type JobEvent } from "@studio/shared";
import { z } from "zod";
import { rawCorsHeaders } from "../lib/cors.js";
import { errorBody } from "../lib/errors.js";

const ListQuery = z.object({
  status: JobStatusSchema.optional(),
  type: JobTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const EventsQuery = z.object({
  /** Only stream events of these job ids (comma separated). */
  jobId: z.string().optional(),
});

const HEARTBEAT_MS = 15_000;

export const jobRoutes: FastifyPluginAsync = async (app) => {
  /** Open SSE connections, closed on server shutdown. */
  const streams = new Set<() => void>();
  // preClose: end streams before the server waits for open connections.
  app.addHook("preClose", async () => {
    for (const close of [...streams]) close();
  });

  app.get(API_ROUTES.jobs, async (req) => {
    const q = ListQuery.parse(req.query);
    return app.ctx.jobs.list({
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
      ...(q.limit && { limit: q.limit }),
    });
  });

  /**
   * SSE stream of JobEvent (`event: job`, `data: <JobEvent JSON>`). On connect it replays the
   * current state of queued/running jobs. Raw response (reply.hijack()), so CORS headers are set
   * by hand. Heartbeat comment every 15 s. Registered before :id.
   */
  app.get(API_ROUTES.jobEvents, (req, reply) => {
    const { jobId } = EventsQuery.parse(req.query);
    const only = jobId ? new Set(jobId.split(",").filter(Boolean)) : undefined;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...rawCorsHeaders(app.ctx.config, req.headers.origin),
    });
    res.write("retry: 2000\n\n");
    const send = (event: JobEvent) => {
      if (only && !only.has(event.jobId)) return;
      res.write(`event: job\nid: ${event.jobId}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const status of ["running", "queued"] as const) {
      for (const job of app.ctx.jobs.list({ status, limit: 200 })) {
        send({
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          ...(job.message !== undefined && { message: job.message }),
        });
      }
    }
    if (only) {
      for (const id of only) {
        const job = app.ctx.jobs.get(id);
        if (job && job.status !== "queued" && job.status !== "running")
          send({
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            ...(job.message !== undefined && { message: job.message }),
          });
      }
    }
    const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
    app.ctx.queue.on("job", send);
    const close = () => {
      streams.delete(close);
      clearInterval(heartbeat);
      app.ctx.queue.off("job", send);
      if (!res.writableEnded) res.end();
    };
    streams.add(close);
    req.raw.on("close", close);
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.job, async (req, reply) => {
    const job = app.ctx.jobs.get(req.params.id);
    return job ?? reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.jobLog, async (req, reply) => {
    const job = app.ctx.jobs.get(req.params.id);
    if (!job) return reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
    return { lines: app.ctx.jobs.logTail(job.id) };
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.jobDiagnostics, async (req, reply) => {
    const job = app.ctx.jobs.get(req.params.id);
    if (!job) return reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
    return app.ctx.jobs.diagnostics(job.id) ?? { commands: [], stderrTail: [], timings: {} };
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.jobCancel, async (req, reply) => {
    const job = app.ctx.queue.cancel(req.params.id);
    return job ?? reply.code(404).send(errorBody("NOT_FOUND", "Job no encontrado"));
  });
};
