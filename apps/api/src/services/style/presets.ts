import { nanoid } from "nanoid";
import { StylePresetSchema, type StylePreset, type StylePresetSaveRequest } from "@studio/shared";
import type { SqlDatabase } from "../../db/adapter.js";

/**
 * Sprint 3b «Perfil de estilo»: saved StylePresets (table `style_presets`). The module owns its
 * table: `ensureStyleSchema` is an idempotent migration (CREATE TABLE IF NOT EXISTS) run when the
 * repo is created, so it never competes with the numbered MIGRATIONS of db/database.ts.
 */
export const STYLE_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS style_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,            -- StylePreset JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS style_presets_updated_idx ON style_presets(updated_at);
`;

export function ensureStyleSchema(db: SqlDatabase): void {
  db.exec(STYLE_SCHEMA_SQL);
}

export class StylePresetRepo {
  constructor(private readonly db: SqlDatabase) {
    ensureStyleSchema(db);
  }

  /** Newest first. */
  list(): StylePreset[] {
    return (
      this.db
        .prepare(`SELECT data FROM style_presets ORDER BY updated_at DESC, rowid DESC`)
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as StylePreset);
  }

  get(id: string): StylePreset | undefined {
    const row = this.db.prepare(`SELECT data FROM style_presets WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StylePreset) : undefined;
  }

  /** Insert, or overwrite when `id` exists (keeps created_at). */
  save(req: StylePresetSaveRequest): StylePreset {
    const now = new Date().toISOString();
    const current = req.id ? this.get(req.id) : undefined;
    const preset = StylePresetSchema.parse({
      ...req,
      id: req.id ?? nanoid(10),
      created_at: current?.created_at ?? now,
      updated_at: now,
    });
    this.db
      .prepare(
        `INSERT INTO style_presets (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(preset.id, preset.name, JSON.stringify(preset), preset.created_at!, now);
    return preset;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM style_presets WHERE id = ?`).run(id).changes > 0;
  }
}
