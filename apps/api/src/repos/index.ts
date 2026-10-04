import type { SqlDatabase } from "../db/adapter.js";
import { MediaRepo } from "./media.js";
import { PresetRepo } from "./presets.js";
import { ProjectRepo } from "./projects.js";
import { SettingsRepo } from "./settings.js";

export { MediaRepo, PresetRepo, ProjectRepo, SettingsRepo };

export interface Repos {
  media: MediaRepo;
  projects: ProjectRepo;
  presets: PresetRepo;
  settings: SettingsRepo;
}

export function createRepos(db: SqlDatabase): Repos {
  const presets = new PresetRepo(db);
  presets.seed();
  return {
    media: new MediaRepo(db),
    projects: new ProjectRepo(db),
    presets,
    settings: new SettingsRepo(db),
  };
}
