import {
  ImportAnalysisSchema,
  ImportSuggestionSchema,
  type ImportAnalysis,
  type ImportSuggestion,
  type SuggestionKind,
  type SuggestionStatus,
} from "@studio/shared";
import type { SqlDatabase } from "../../db/adapter.js";

/**
 * Sprint 6 M3: tables `import_analysis` (one row per (asset, params_version, file_sig), never
 * repeated) and `suggestions` (one row per (project, asset, kind): the card and its status). The
 * module owns its tables: idempotent CREATE TABLE IF NOT EXISTS, like style_presets.
 */
export const SUGGESTIONS_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS import_analysis (
  asset_id TEXT NOT NULL,
  params_version INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime_ms REAL NOT NULL,
  data TEXT NOT NULL,            -- ImportAnalysis JSON
  analyzed_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, params_version, file_size, file_mtime_ms)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT NOT NULL,       -- clipsSignature() when the card was computed
  plan_id TEXT,                  -- AgentPlanRecord created by «Aplicar»
  data TEXT NOT NULL,            -- ImportSuggestion JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, asset_id, kind)
);
CREATE INDEX IF NOT EXISTS suggestions_project_idx ON suggestions(project_id);
`;

export interface SuggestionRow {
  suggestion: ImportSuggestion;
  signature: string;
  planId: string | null;
}

interface RawRow {
  data: string;
  signature: string;
  plan_id: string | null;
}

const toRow = (r: RawRow): SuggestionRow => ({
  suggestion: ImportSuggestionSchema.parse(JSON.parse(r.data)),
  signature: r.signature,
  planId: r.plan_id,
});

export class SuggestionsRepo {
  constructor(private readonly db: SqlDatabase) {
    db.exec(SUGGESTIONS_SCHEMA_SQL);
  }

  analysis(
    assetId: string,
    paramsVersion: number,
    sig: ImportAnalysis["file_sig"],
  ): ImportAnalysis | undefined {
    const row = this.db
      .prepare(
        `SELECT data FROM import_analysis WHERE asset_id = ? AND params_version = ?
           AND file_size = ? AND file_mtime_ms = ?`,
      )
      .get(assetId, paramsVersion, sig.size, sig.mtime_ms) as { data: string } | undefined;
    return row ? ImportAnalysisSchema.parse(JSON.parse(row.data)) : undefined;
  }

  /** Newest analysis of the asset with these parameters (any file signature). */
  latestAnalysis(assetId: string, paramsVersion: number): ImportAnalysis | undefined {
    const row = this.db
      .prepare(
        `SELECT data FROM import_analysis WHERE asset_id = ? AND params_version = ?
         ORDER BY analyzed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(assetId, paramsVersion) as { data: string } | undefined;
    return row ? ImportAnalysisSchema.parse(JSON.parse(row.data)) : undefined;
  }

  saveAnalysis(a: ImportAnalysis): void {
    const parsed = ImportAnalysisSchema.parse(a);
    this.db
      .prepare(
        `INSERT INTO import_analysis (asset_id, params_version, file_size, file_mtime_ms, data, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, params_version, file_size, file_mtime_ms)
         DO UPDATE SET data = excluded.data, analyzed_at = excluded.analyzed_at`,
      )
      .run(
        parsed.assetId,
        parsed.params_version,
        parsed.file_sig.size,
        parsed.file_sig.mtime_ms,
        JSON.stringify(parsed),
        parsed.analyzed_at,
      );
  }

  list(projectId: string): SuggestionRow[] {
    return (
      this.db
        .prepare(
          `SELECT data, signature, plan_id FROM suggestions WHERE project_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(projectId) as RawRow[]
    ).map(toRow);
  }

  get(id: string): SuggestionRow | undefined {
    const r = this.db
      .prepare(`SELECT data, signature, plan_id FROM suggestions WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  find(projectId: string, assetId: string, kind: SuggestionKind): SuggestionRow | undefined {
    const r = this.db
      .prepare(
        `SELECT data, signature, plan_id FROM suggestions
         WHERE project_id = ? AND asset_id = ? AND kind = ?`,
      )
      .get(projectId, assetId, kind) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  /** Insert or replace the card (keyed by id; (project, asset, kind) is unique). */
  save(s: ImportSuggestion, signature: string, planId: string | null = null): ImportSuggestion {
    const parsed = ImportSuggestionSchema.parse(s);
    this.db
      .prepare(
        `INSERT INTO suggestions (id, project_id, asset_id, kind, status, signature, plan_id, data,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, signature = excluded.signature,
           plan_id = excluded.plan_id, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        parsed.id,
        parsed.projectId,
        parsed.assetId,
        parsed.kind,
        parsed.status,
        signature,
        planId,
        JSON.stringify(parsed),
        parsed.created_at,
        parsed.updated_at,
      );
    return parsed;
  }

  setStatus(row: SuggestionRow, status: SuggestionStatus, planId = row.planId): ImportSuggestion {
    return this.save(
      { ...row.suggestion, status, updated_at: new Date().toISOString() },
      row.signature,
      planId,
    );
  }
}
