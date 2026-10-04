import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, DEFAULT_EXPORT_PRESETS } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const exportPresetRoutes: FastifyPluginAsync = async (app) => {
  // TODO(module-b): seed DEFAULT_EXPORT_PRESETS into `export_presets` and serve from DB.
  app.get(API_ROUTES.exportPresets, async () => DEFAULT_EXPORT_PRESETS);
  app.post(API_ROUTES.exportPresets, async (_req, reply) => notImplemented(reply, "module-b"));
  app.put(API_ROUTES.exportPreset, async (_req, reply) => notImplemented(reply, "module-b"));
  app.delete(API_ROUTES.exportPreset, async (_req, reply) => notImplemented(reply, "module-b"));
};
