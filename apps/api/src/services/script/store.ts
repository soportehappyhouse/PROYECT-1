import type { Db } from "../../db/database.js";

/**
 * Sprint 6 M1: audio artifacts of `script.transcribe` (energy envelope + acoustic gaps), one row
 * per project and asset (the latest transcription wins). Kept out of the Project document: the
 * single source of word timings stays `project.subtitles[].words` (contract decision 1). Own table
 * with an idempotent `CREATE TABLE IF NOT EXISTS` (like style_presets / persons), so the shared
 * MIGRATIONS list is not touched.
 */
const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS script_audio (
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  path TEXT NOT NULL,            -- renders/<jobId>/script-audio.json (STORAGE_DIR-relative)
  noise_floor_db REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
`;

export interface ScriptAudioRow {
  project_id: string;
  asset_id: string;
  clip_id: string;
  job_id: string;
  path: string;
  noise_floor_db: number;
  created_at: string;
}

const ready = new WeakSet<object>();

export function ensureScriptSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  ready.add(db);
}

export function recordScriptAudio(db: Db, row: Omit<ScriptAudioRow, "created_at">): void {
  ensureScriptSchema(db);
  db.prepare(
    `INSERT INTO script_audio (project_id, asset_id, clip_id, job_id, path, noise_floor_db, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, asset_id) DO UPDATE SET clip_id = excluded.clip_id,
       job_id = excluded.job_id, path = excluded.path, noise_floor_db = excluded.noise_floor_db,
       created_at = excluded.created_at`,
  ).run(
    row.project_id,
    row.asset_id,
    row.clip_id,
    row.job_id,
    row.path,
    row.noise_floor_db,
    new Date().toISOString(),
  );
}

/** Rows of a project, newest first. */
export function listScriptAudio(db: Db, projectId: string): ScriptAudioRow[] {
  ensureScriptSchema(db);
  return db
    .prepare(`SELECT * FROM script_audio WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as ScriptAudioRow[];
}
