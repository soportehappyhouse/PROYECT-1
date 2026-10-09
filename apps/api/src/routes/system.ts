import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, formatErrorEs, SPRINT5_ERRORS, VOICE_EFFECT_PRESETS } from "@studio/shared";
import { z } from "zod";
import { errorBody } from "../lib/errors.js";
import { getEncoderInfo } from "../services/encoder-select.js";
import { revealExport, spawnRevealRunner, type RevealRunner } from "../services/export/reveal.js";

/** Sprint 5: replaceable in tests (the fake runner records the argv). */
export const systemRouteDeps: { reveal: RevealRunner; platform: NodeJS.Platform } = {
  reveal: spawnRevealRunner,
  platform: process.platform,
};

/** Module (b) extras: hardware encoder detection and voice effect presets. */
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.systemEncoders, async (req) => {
    const { refresh } = z.object({ refresh: z.enum(["0", "1"]).optional() }).parse(req.query);
    const info = await getEncoderInfo(app.ctx.ffmpeg, app.ctx.repos.settings, refresh === "1");
    return { ...info, mode: app.ctx.config.hwEncoder, lanes: app.ctx.queue.lanes() };
  });

  app.get(API_ROUTES.voiceEffectPresets, async () => VOICE_EFFECT_PRESETS);

  /** Sprint 5: «Abrir carpeta» of an export (only files under storage/exports). */
  app.post(API_ROUTES.systemReveal, async (req, reply) => {
    const { path } = z.object({ path: z.string().min(1).max(1024) }).parse(req.body);
    const outcome = await revealExport(
      app.ctx.config.storageDir,
      path,
      systemRouteDeps.reveal,
      systemRouteDeps.platform,
    );
    if (outcome === "outside")
      return reply
        .code(SPRINT5_ERRORS.REVEAL_OUTSIDE_EXPORTS.status)
        .send(errorBody("REVEAL_OUTSIDE_EXPORTS", formatErrorEs("REVEAL_OUTSIDE_EXPORTS")));
    if (outcome === "missing")
      return reply
        .code(404)
        .send(errorBody("NOT_FOUND", "El archivo exportado ya no está (¿se borró o se movió?)."));
    return { ok: true };
  });
};
