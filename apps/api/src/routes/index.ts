import type { FastifyInstance } from "fastify";
import { agentRoutes } from "./agent.js";
import { consoleRoutes } from "./console.js";
import { designRoutes } from "./design.js";
import { aiRoutes } from "./ai.js";
import { audioRoutes } from "./audio.js";
import { visionRoutes } from "./vision.js";
import { exportPresetRoutes } from "./export-presets.js";
import { healthRoutes } from "./health.js";
import { jobRoutes } from "./jobs.js";
import { libraryRoutes } from "./library.js";
import { mediaRoutes } from "./media.js";
import { motionRoutes } from "./motion.js";
import { projectRoutes } from "./projects.js";
import { reportRoutes } from "./reports.js";
import { scriptRoutes } from "./script.js";
import { settingsRoutes } from "./settings.js";
import { styleRoutes } from "./style.js";
import { suggestionRoutes } from "./suggestions.js";
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
  await app.register(aiRoutes);
  await app.register(visionRoutes);
  await app.register(agentRoutes);
  await app.register(styleRoutes); // Sprint 3b: perfil de estilo
  await app.register(audioRoutes); // Sprint 3b: stems
  await app.register(consoleRoutes); // Sprint 3b: Consola Claude (PTY + WebSocket) + frame PNG
  // Sprint 6 (docs/trabajo/sprint6-contratos.md): Paso 0 stubs, each file owned by its module.
  await app.register(scriptRoutes); // M1 Guion
  await app.register(designRoutes); // M2 Sistema de diseño
  await app.register(suggestionRoutes); // M3 Sugerencias
}
