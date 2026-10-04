import { nanoid } from "nanoid";
import {
  ProjectSchema,
  ProjectSettingsSchema,
  type CreateProject,
  type Project,
} from "@studio/shared";
import type { SqlDatabase } from "../db/adapter.js";

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Project documents (tracks/clips/subtitles) persisted as JSON in the `projects` table. */
export class ProjectRepo {
  constructor(private readonly db: SqlDatabase) {}

  create(input: CreateProject): Project {
    const now = new Date().toISOString();
    const id = nanoid();
    const project = ProjectSchema.parse({
      id,
      name: input.name,
      settings: ProjectSettingsSchema.parse(input.settings ?? {}),
      tracks: [
        { id: nanoid(), kind: "video", name: "Video 1" },
        { id: nanoid(), kind: "text", name: "Texto 1" },
        { id: nanoid(), kind: "audio", name: "Audio 1" },
      ],
      subtitles: [],
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO projects (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, project.name, JSON.stringify(project), now, now);
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare(`SELECT data FROM projects WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Project) : undefined;
  }

  list(): ProjectSummary[] {
    return (
      this.db
        .prepare(`SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC`)
        .all() as { id: string; name: string; created_at: string; updated_at: string }[]
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** Replace the whole document (id and createdAt are kept; updatedAt is set by the server). */
  save(id: string, body: unknown): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const project = ProjectSchema.parse({
      ...(body as object),
      id,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    this.db
      .prepare(`UPDATE projects SET name = ?, data = ?, updated_at = ? WHERE id = ?`)
      .run(project.name, JSON.stringify(project), now, id);
    this.db.prepare(`DELETE FROM project_autosaves WHERE project_id = ?`).run(id);
    return project;
  }

  delete(id: string): boolean {
    this.db.prepare(`DELETE FROM project_autosaves WHERE project_id = ?`).run(id);
    return this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
  }

  /** Store a crash-recovery snapshot (does not touch the saved project). */
  autosave(id: string, body: unknown): { projectId: string; savedAt: string } | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const savedAt = new Date().toISOString();
    const snapshot = ProjectSchema.parse({
      ...(body as object),
      id,
      createdAt: current.createdAt,
      updatedAt: savedAt,
    });
    this.db
      .prepare(
        `INSERT INTO project_autosaves (project_id, data, saved_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`,
      )
      .run(id, JSON.stringify(snapshot), savedAt);
    return { projectId: id, savedAt };
  }

  getAutosave(id: string): { project: Project; savedAt: string } | undefined {
    const row = this.db
      .prepare(`SELECT data, saved_at FROM project_autosaves WHERE project_id = ?`)
      .get(id) as { data: string; saved_at: string } | undefined;
    return row ? { project: JSON.parse(row.data) as Project, savedAt: row.saved_at } : undefined;
  }
}
