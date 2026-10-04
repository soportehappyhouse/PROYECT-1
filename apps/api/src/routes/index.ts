import type { FastifyInstance } from "fastify";
import { exportPresetRoutes } from "./export-presets.js";
import { healthRoutes } from "./health.js";
import { jobRoutes } from "./jobs.js";
import { libraryRoutes } from "./library.js";
import { mediaRoutes } from "./media.js";
import { motionRoutes } from "./motion.js";
import { projectRoutes } from "./projects.js";
import { reportRoutes } from "./reports.js";
import { settingsRoutes } from "./settings.js";
import { subtitleRoutes } from "./subtitles.js";
import { systemRoutes } from "./system.js";
import { voiceRoutes } from "./voice.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(settingsRoutes);
  await app.register(projectRoutes);
  await app.register(mediaRoutes);
  await app.register(jobRoutes);
  await app.register(exportPresetRoutes);
  await app.register(motionRoutes);
  await app.register(voiceRoutes);
  await app.register(subtitleRoutes);
  await app.register(libraryRoutes);
  await app.register(systemRoutes);
  await app.register(reportRoutes);
}
