import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, VOICE_EFFECT_PRESETS } from "@studio/shared";
import { z } from "zod";
import { getEncoderInfo } from "../services/encoder-select.js";

/** Module (b) extras: hardware encoder detection and voice effect presets. */
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.systemEncoders, async (req) => {
    const { refresh } = z.object({ refresh: z.enum(["0", "1"]).optional() }).parse(req.query);
    const info = await getEncoderInfo(app.ctx.ffmpeg, app.ctx.repos.settings, refresh === "1");
    return { ...info, mode: app.ctx.config.hwEncoder, lanes: app.ctx.queue.lanes() };
  });

  app.get(API_ROUTES.voiceEffectPresets, async () => VOICE_EFFECT_PRESETS);
};
