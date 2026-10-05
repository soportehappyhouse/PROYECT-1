import {
  DEFAULT_EXPORT_PRESETS,
  EXTRA_EXPORT_PRESETS,
  ExportPresetSchema,
  type ExportPreset,
} from "@studio/shared";
import type { SqlDatabase } from "../db/adapter.js";

/** B5: built-ins keep the catalog order (youtube-1080p first, GIF last), not alphabetical. */
const CATALOG = [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS].map((p) => p.id);
const catalogIndex = (id: string) => {
  const i = CATALOG.indexOf(id);
  return i < 0 ? CATALOG.length : i;
};

/** Export presets (ExportPreset JSON) in the `export_presets` table; built-ins are seeded. */
export class PresetRepo {
  constructor(private readonly db: SqlDatabase) {}

  /** Insert missing built-in presets (never overwrites user edits). */
  seed(): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO export_presets (id, data) VALUES (?, ?)`);
    this.db.transaction(() => {
      for (const p of [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS]) {
        const preset = ExportPresetSchema.parse({ ...p, builtIn: true });
        insert.run(preset.id, JSON.stringify(preset));
      }
    });
  }

  list(): ExportPreset[] {
    return (this.db.prepare(`SELECT data FROM export_presets`).all() as { data: string }[])
      .map((r) => JSON.parse(r.data) as ExportPreset)
      .sort(
        (a, b) =>
          Number(b.builtIn) - Number(a.builtIn) ||
          catalogIndex(a.id) - catalogIndex(b.id) ||
          a.name.localeCompare(b.name),
      );
  }

  get(id: string): ExportPreset | undefined {
    const row = this.db.prepare(`SELECT data FROM export_presets WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ExportPreset) : undefined;
  }

  upsert(preset: ExportPreset): ExportPreset {
    this.db
      .prepare(
        `INSERT INTO export_presets (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(preset.id, JSON.stringify(preset));
    return preset;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM export_presets WHERE id = ?`).run(id).changes > 0;
  }
}
