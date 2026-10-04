import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  // TODO(module-d): merge workers /tts/voices (Piper) with cloud voices when keys are set.
  app.get(API_ROUTES.ttsVoices, async (_req, reply) => notImplemented(reply, "module-d"));
  // TODO(module-d): validate TtsRequestSchema, enqueue "voice.tts".
  app.post(API_ROUTES.tts, async (_req, reply) => notImplemented(reply, "module-d"));
  // TODO(module-b): validate VoiceEffectRequestSchema, enqueue "voice.effect" (ffmpeg filters).
  app.post(API_ROUTES.voiceEffects, async (_req, reply) => notImplemented(reply, "module-b"));
  // TODO(module-d): proxy workers /rvc/models.
  app.get(API_ROUTES.rvcModels, async (_req, reply) => notImplemented(reply, "module-d"));
  // TODO(module-d): validate RvcRequestSchema, enqueue "voice.rvc".
  app.post(API_ROUTES.rvc, async (_req, reply) => notImplemented(reply, "module-d"));
};
