import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_FILENAME } from "@studio/shared";
import type { SqlDatabase, SqlParam } from "./adapter.js";

export type { SqlDatabase as Db } from "./adapter.js";

/**
 * Schema v1. JSON columns hold zod-validated documents from @studio/shared.
 * TODO(module-b): proper migrations table if the schema evolves; FTS5 table for library search.
 */
const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,            -- Project JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,            -- MediaAsset JSON
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  message TEXT,
  project_id TEXT,
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS export_presets (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL             -- ExportPreset JSON
);
CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL             -- LibraryItem JSON
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);
`;

/** better-sqlite3 implementation of the SqlDatabase adapter. */
function wrapBetterSqlite(db: Database.Database): SqlDatabase {
  return {
    exec: (sql) => void db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare<SqlParam[]>(sql);
      return {
        run: (...params) => ({ changes: stmt.run(...params).changes }),
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
      };
    },
    transaction: (fn) => db.transaction(fn)(),
    close: () => void db.close(),
  };
}

/** Open (or create) storage/studio.db. Pass ":memory:" for tests. */
export function openDatabase(storageDir: string | ":memory:"): SqlDatabase {
  let file: string = ":memory:";
  if (storageDir !== ":memory:") {
    mkdirSync(storageDir, { recursive: true });
    file = path.join(storageDir, DB_FILENAME);
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return wrapBetterSqlite(db);
}
