import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createDefaultRegistry } from "@studio/motion-engines";
import { configureRemotionRenderer, REMOTION_ENGINE_OPTIONS } from "@studio/remotion";
import path from "node:path";
import { LOGS_SUBDIR } from "@studio/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db/database.js";
import { registerAiHandlers } from "./jobs/handlers/ai.js";
import { registerModuleBHandlers } from "./jobs/handlers/index.js";
import { createMotionRenderHandler } from "./jobs/handlers/motion-render.js";
import { JobQueue } from "./jobs/queue.js";
import { SqliteJobStore } from "./jobs/store.js";
import { allowedOrigins } from "./lib/cors.js";
import { DailyLogStream } from "./lib/log-file.js";
import { errorBody, HttpError, PackRequiredError } from "./lib/errors.js";
import { createRepos } from "./repos/index.js";
import { registerRoutes } from "./routes/index.js";
import { createFfmpegService } from "./services/ffmpeg.js";
import { ensureStorageLayout } from "./services/storage.js";
import { createWorkersClient } from "./services/workers-client.js";
import { registerVoiceAiHandlers } from "./voice-ai/handlers.js";

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

  configureRemotionRenderer(config.remotion);
  const db = openDatabase(inMemoryDb ? ":memory:" : config.storageDir);
  const jobs = new SqliteJobStore(db);
  const queue = new JobQueue({ store: jobs, storageDir: config.storageDir, lanes: config.queue });
  const ctx: AppContext = {
    config,
    db,
    jobs,
    queue,
    ffmpeg: createFfmpegService(config.ffmpegPath, config.ffprobePath),
    workers: createWorkersClient(config.workersUrl),
    motion: createDefaultRegistry({
      ffmpegPath: config.ffmpegPath,
      remotion: REMOTION_ENGINE_OPTIONS,
    }),
    repos: createRepos(db),
  };
  // Job handlers, dispatched by JobType (contract: jobs/types.ts JobHandler; lanes: jobs/state.ts).
  registerModuleBHandlers(ctx); // media.probe, media.proxy, voice.effect, project.export
  registerVoiceAiHandlers(ctx); // module d: voice.tts, voice.rvc, subtitles.transcribe
  registerAiHandlers(ctx); // Sprint 1: packs.download, analyze.*, timeline.apply-cuts, audio.denoise, perf.run
  queue.register(createMotionRenderHandler(ctx)); // module c: motion.render

  // stdout + storage/logs/api-YYYY-MM-DD.log (7 days, secrets redacted). Tests use logger: false.
  const logStream =
    logger && !inMemoryDb
      ? new DailyLogStream({
          dir: path.join(config.storageDir, LOGS_SUBDIR),
          redact: { secrets: Object.values(config.keys) },
        })
      : undefined;
  const app = Fastify({
    logger: logger ? { level: config.logLevel, ...(logStream && { stream: logStream }) } : false,
    bodyLimit: 10 * 1024 * 1024,
  });
  app.decorate("ctx", ctx);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "Datos inválidos", err.issues));
    if (err instanceof HttpError)
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    // Sprint 1 contract: flat body so the web can open the "Paquete requerido" dialog.
    if (err instanceof PackRequiredError) return reply.code(409).send(err.body);
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "Error interno";
    return reply.code(status).send(errorBody("INTERNAL_ERROR", message));
  });

  // The SSE route (/api/jobs/events) bypasses this plugin via reply.hijack(): lib/cors.ts rawCorsHeaders.
  await app.register(cors, {
    origin: allowedOrigins(config),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: config.storageDir,
    prefix: "/files/",
    decorateReply: false,
    // Never expose the SQLite files, scratch dirs, logs, error reports or partial uploads.
    allowedPath: (pathName) =>
      !/^\/?(studio\.db|tmp\/|logs\/|reports\/|cache\/)/.test(pathName) &&
      !pathName.endsWith(".part"),
  });
  await registerRoutes(app);

  app.addHook("onReady", async () => queue.start());
  app.addHook("onClose", async () => {
    await queue.stop();
    db.close();
    await logStream?.end();
  });
  return app;
}
