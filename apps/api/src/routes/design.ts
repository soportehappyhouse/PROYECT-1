import { API_ROUTES, SPRINT6_MODULES } from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { sprint6NotImplemented } from "../lib/errors.js";

/**
 * Sprint 6 M2 Sistema de diseño (docs/trabajo/sprint6-contratos.md): brand kit, design tokens,
 * design checklist, motion stills and the bundled fonts. Paso 0 stubs (501 NOT_IMPLEMENTED); M2
 * owns this file (and may move motionStill into routes/motion.ts):
 *   GET | PUT brandKit       -> BrandKit (PUT BrandKitUpdate)
 *   POST brandKitLogo        multipart `logo` -> BrandKit
 *   GET  designTokens        ?aspect=&w=&h= -> ResolvedDesign
 *   POST designCheck         DesignCheckRequest -> DesignCheckResult
 *   POST motionStill         MotionStillRequest -> image/png | image/jpeg
 *   GET  fonts               bundled OFL fonts (FONTS_DIR_REL)
 */
export const designRoutes: FastifyPluginAsync = async (app) => {
  const stub = (_req: unknown, reply: Parameters<typeof sprint6NotImplemented>[0]) =>
    sprint6NotImplemented(reply, SPRINT6_MODULES.M2);
  app.get(API_ROUTES.brandKit, stub);
  app.put(API_ROUTES.brandKit, stub);
  app.post(API_ROUTES.brandKitLogo, stub);
  app.get(API_ROUTES.designTokens, stub);
  app.post(API_ROUTES.designCheck, stub);
  app.post(API_ROUTES.motionStill, stub);
  app.get(API_ROUTES.fonts, stub);
};
