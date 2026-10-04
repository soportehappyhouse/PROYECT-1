import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, type AppConfig, type HealthResponse } from "@studio/shared";

const VERSION = "0.1.0";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.health, async (): Promise<HealthResponse> => {
    const { ffmpeg, workers, config } = app.ctx;
    const [ffmpegVersion, workerHealth] = await Promise.all([ffmpeg.version(), workers.health()]);
    return {
      status: ffmpegVersion && workerHealth ? "ok" : "degraded",
      version: VERSION,
      ffmpeg: {
        available: Boolean(ffmpegVersion),
        ...(ffmpegVersion && { version: ffmpegVersion }),
      },
      workers: { reachable: Boolean(workerHealth), url: config.workersUrl },
    };
  });

  app.get(API_ROUTES.config, async (): Promise<AppConfig> => {
    const { keys, useCuda } = app.ctx.config;
    return {
      useCuda,
      providers: {
        elevenlabs: Boolean(keys.elevenlabs),
        openai: Boolean(keys.openai),
        anthropic: Boolean(keys.anthropic),
        freesound: Boolean(keys.freesound),
        pixabay: Boolean(keys.pixabay),
      },
    };
  });
};
