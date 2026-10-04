import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { registerVoiceAiRoutes } from "./voice-ai.js";
import { handleVoiceEffects } from "./voice-effects.js";

export const voiceRoutes: FastifyPluginAsync = async (app) => {
  // module-d: TTS voices/providers, "voice.tts", RVC models, "voice.rvc", model downloads
  // (see ./voice-ai.ts).
  registerVoiceAiRoutes(app);
  // module-b: VoiceEffectRequest -> "voice.effect" job (see ./voice-effects.ts).
  app.post(API_ROUTES.voiceEffects, handleVoiceEffects);
};
