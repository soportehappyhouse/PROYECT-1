import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createDefaultRegistry } from "@studio/motion-engines";
import { REMOTION_TEMPLATES, renderMotion } from "@studio/remotion";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db/database.js";
import { JobQueue } from "./jobs/queue.js";
import { SqliteJobStore } from "./jobs/store.js";
import { errorBody, HttpError } from "./lib/errors.js";
import { registerRoutes } from "./routes/index.js";
import { createFfmpegService } from "./services/ffmpeg.js";
import { ensureStorageLayout } from "./services/storage.js";
import { createWorkersClient } from "./services/workers-client.js";

export interface BuildAppOptions {
  config: ApiConfig;
  /** Use an in-memory SQLite DB (tests). */
  inMemoryDb?: boolean;
  logger?: boolean;
}

export async function buildApp({
  config,
  inMemoryDb = false,
  logger = true,
}: BuildAppOptions): Promise<FastifyInstance> {
  if (!inMemoryDb) await ensureStorageLayout(config.storageDir);

  const db = openDatabase(inMemoryDb ? ":memory:" : config.storageDir);
  const jobs = new SqliteJobStore(db);
  const queue = new JobQueue({ store: jobs, storageDir: config.storageDir });
  const ctx: AppContext = {
    config,
    db,
    jobs,
    queue,
    ffmpeg: createFfmpegService(config.ffmpegPath, config.ffprobePath),
    workers: createWorkersClient(config.workersUrl),
    motion: createDefaultRegistry({
      ffmpegPath: config.ffmpegPath,
      remotion: { templates: REMOTION_TEMPLATES, render: renderMotion },
    }),
  };
  // TODO(module-b/c/d): register job handlers here, e.g. queue.register(createProbeHandler(ctx)).

  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    bodyLimit: 10 * 1024 * 1024,
  });
  app.decorate("ctx", ctx);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "Datos inválidos", err.issues));
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "Error interno";
    return reply.code(status).send(errorBody("INTERNAL_ERROR", message));
  });

  await app.register(cors, {
    origin: [config.webOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: config.storageDir,
    prefix: "/files/",
    decorateReply: false,
  });
  await registerRoutes(app);

  app.addHook("onReady", async () => queue.start());
  app.addHook("onClose", async () => {
    await queue.stop();
    db.close();
  });
  return app;
}
