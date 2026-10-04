import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const subtitleRoutes: FastifyPluginAsync = async (app) => {
  // TODO(module-d): validate TranscribeRequestSchema, enqueue "subtitles.transcribe"
  // (handler extracts 16 kHz mono WAV with ffmpeg, then calls workers /transcribe).
  app.post(API_ROUTES.transcribe, async (_req, reply) => notImplemented(reply, "module-d"));
};
