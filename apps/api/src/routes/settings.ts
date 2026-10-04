import type { FastifyPluginAsync } from "fastify";
import {
  API_ROUTES,
  DashboardSettingsWithUiSchema,
  DEFAULT_DASHBOARD_SETTINGS,
  type DashboardSettingsWithUi,
} from "@studio/shared";

const KEY = "dashboard";

/**
 * Dashboard settings (theme, panels, shortcuts + `ui` prefs incl. dockview layout and layout
 * presets) persisted as one JSON document in `settings` (key "dashboard").
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { settings } = app.ctx.repos;

  app.get(API_ROUTES.settings, async () => {
    const stored = settings.get<DashboardSettingsWithUi>(KEY);
    if (!stored) return DEFAULT_DASHBOARD_SETTINGS;
    const parsed = DashboardSettingsWithUiSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_DASHBOARD_SETTINGS;
  });

  app.put(API_ROUTES.settings, async (req) => {
    const next = DashboardSettingsWithUiSchema.parse(req.body);
    settings.set(KEY, next);
    return next;
  });
};
