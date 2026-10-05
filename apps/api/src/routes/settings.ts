import type { FastifyPluginAsync } from "fastify";
import {
  API_ROUTES,
  DashboardSettingsSchema,
  DEFAULT_DASHBOARD_SETTINGS,
  type DashboardSettings,
} from "@studio/shared";

const KEY = "dashboard";

/**
 * Dashboard settings (theme, panels, shortcuts + `ui` prefs incl. dockview layout and layout
 * presets) persisted as one JSON document in `settings` (key "dashboard").
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { settings } = app.ctx.repos;

  app.get(API_ROUTES.settings, async () => {
    const stored = settings.get<DashboardSettings>(KEY);
    if (!stored) return DEFAULT_DASHBOARD_SETTINGS;
    const parsed = DashboardSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_DASHBOARD_SETTINGS;
  });

  app.put(API_ROUTES.settings, async (req) => {
    const next = DashboardSettingsSchema.parse(req.body);
    settings.set(KEY, next);
    return next;
  });
};
