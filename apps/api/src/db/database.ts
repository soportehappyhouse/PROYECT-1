import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_FILENAME } from "@studio/shared";
import type { SqlDatabase, SqlParam } from "./adapter.js";

export type { SqlDatabase as Db } from "./adapter.js";

/**
 * Schema v1. JSON columns hold zod-validated documents from @studio/shared.
 * Later changes go into MIGRATIONS (tracked with PRAGMA user_version).
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

/** Incremental migrations; index + 1 = resulting user_version. Append only, never edit. */
const MIGRATIONS: readonly string[] = [
  /* v1 (module b): job retry/priority/log, ffprobe JSON, project autosaves */ `
  ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN log_tail TEXT;
  ALTER TABLE media ADD COLUMN probe TEXT;
  CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, priority DESC, created_at);
  CREATE TABLE IF NOT EXISTS project_autosaves (
    project_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,          -- Project JSON snapshot
    saved_at TEXT NOT NULL
  );
  `,
  /* v2 (module d): local sound library full-text index (storage/library) */ `
  CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
    item_id UNINDEXED, name, tags, author,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE INDEX IF NOT EXISTS library_items_kind_idx ON library_items(kind, name);
  `,
  /* v3 (error reports): per-job command lines, stderr tail (200 lines) and timings */ `
  ALTER TABLE jobs ADD COLUMN diagnostics TEXT;
  `,
  /* v4 (Sprint 3 agent): proposed/applied EditPlans and their undo snapshots */ `
  CREATE TABLE IF NOT EXISTS agent_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,          -- proposed | applied | rejected
    data TEXT NOT NULL,            -- AgentPlanRecord JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_plans_project_idx ON agent_plans(project_id, created_at);
  CREATE TABLE IF NOT EXISTS agent_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    plan_id TEXT,
    data TEXT NOT NULL,            -- Project JSON before agent.apply
    created_at TEXT NOT NULL
  );
  `,
];

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

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
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return wrapBetterSqlite(db);
}
