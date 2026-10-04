import type { SqlDatabase } from "../db/adapter.js";

/** Key/value JSON store over the `settings` table. */
export class SettingsRepo {
  constructor(private readonly db: SqlDatabase) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }
}
