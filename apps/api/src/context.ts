import type { MotionEngineRegistry } from "@studio/motion-engines";
import type { ApiConfig } from "./config.js";
import type { Db } from "./db/database.js";
import type { JobQueue } from "./jobs/queue.js";
import type { JobStore } from "./jobs/types.js";
import type { Repos } from "./repos/index.js";
import type { FfmpegService } from "./services/ffmpeg.js";
import type { WorkersClient } from "./services/workers-client.js";

/** Dependencies shared by all routes and job handlers (decorated as `app.ctx`). */
export interface AppContext {
  config: ApiConfig;
  db: Db;
  jobs: JobStore;
  queue: JobQueue;
  ffmpeg: FfmpegService;
  workers: WorkersClient;
  motion: MotionEngineRegistry;
  /** SQLite repositories (media, projects, presets, settings). */
  repos: Repos;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
