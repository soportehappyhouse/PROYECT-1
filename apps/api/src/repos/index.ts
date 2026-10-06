import type { SqlDatabase } from "../db/adapter.js";
import { AgentPlanRepo } from "./agent-plans.js";
import { MediaRepo } from "./media.js";
import { PresetRepo } from "./presets.js";
import { ProjectRepo } from "./projects.js";
import { SettingsRepo } from "./settings.js";

export { AgentPlanRepo, MediaRepo, PresetRepo, ProjectRepo, SettingsRepo };

export interface Repos {
  media: MediaRepo;
  projects: ProjectRepo;
  presets: PresetRepo;
  settings: SettingsRepo;
  /** Sprint 3: agent plans + undo snapshots. */
  agentPlans: AgentPlanRepo;
}

export function createRepos(db: SqlDatabase): Repos {
  const presets = new PresetRepo(db);
  presets.seed();
  return {
    media: new MediaRepo(db),
    projects: new ProjectRepo(db),
    presets,
    settings: new SettingsRepo(db),
    agentPlans: new AgentPlanRepo(db),
  };
}
