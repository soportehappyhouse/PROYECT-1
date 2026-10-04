import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, DEFAULT_DASHBOARD_SETTINGS } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // TODO(module-b): read/write DashboardSettings JSON in the `settings` table (key "dashboard").
  app.get(API_ROUTES.settings, async () => DEFAULT_DASHBOARD_SETTINGS);
  app.put(API_ROUTES.settings, async (_req, reply) => notImplemented(reply, "module-b"));
};
