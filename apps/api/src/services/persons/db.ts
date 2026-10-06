import {
  LicenceAcceptanceSchema,
  PersonSchema,
  type LicenceAcceptance,
  type LicenceId,
  type Person,
} from "@studio/shared";
import type { SqlDatabase } from "../../db/adapter.js";

/**
 * Sprint 4 M1 (docs/trabajo/sprint4-contratos.md «M1»): Personas with their consent history, the
 * on-screen licence acceptances and the append-only consent audit. The module owns its tables:
 * `ensurePersonsSchema` is idempotent (CREATE TABLE IF NOT EXISTS, like style_presets) and never
 * competes with the numbered MIGRATIONS of db/database.ts. `consent_audit` has no delete path.
 */
export const PERSONS_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,            -- Person JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS persons_updated_idx ON persons(updated_at);
CREATE TABLE IF NOT EXISTS ai_licences (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,            -- LicenceAcceptance JSON
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  person_id TEXT,
  consent_id TEXT,
  job_id TEXT,
  asset_id TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS consent_audit_person_idx ON consent_audit(person_id, at);
`;

export function ensurePersonsSchema(db: SqlDatabase): void {
  db.exec(PERSONS_SCHEMA_SQL);
}

export interface StoredPerson {
  person: Person;
  deletedAt?: string;
}

/** `persons` rows (Person JSON); soft delete keeps the row (deleted_at) for the audit trail. */
export class PersonsRepo {
  constructor(private readonly db: SqlDatabase) {}

  /** Live Persons (not deleted), by name. */
  list(): Person[] {
    return (
      this.db
        .prepare(`SELECT data FROM persons WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`)
        .all() as { data: string }[]
    ).map((r) => PersonSchema.parse(JSON.parse(r.data)));
  }

  /** Row including soft-deleted ones (deletedAt set). */
  find(id: string): StoredPerson | undefined {
    const row = this.db.prepare(`SELECT data, deleted_at FROM persons WHERE id = ?`).get(id) as
      { data: string; deleted_at: string | null } | undefined;
    if (!row) return undefined;
    return {
      person: PersonSchema.parse(JSON.parse(row.data)),
      ...(row.deleted_at && { deletedAt: row.deleted_at }),
    };
  }

  /** Live Person or undefined (deleted ones are not returned). */
  get(id: string): Person | undefined {
    const row = this.find(id);
    return row && !row.deletedAt ? row.person : undefined;
  }

  insert(person: Person): Person {
    const p = PersonSchema.parse(person);
    this.db
      .prepare(
        `INSERT INTO persons (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, JSON.stringify(p), p.createdAt, p.updatedAt);
    return p;
  }

  /** Replace the document (updatedAt = now). */
  save(person: Person): Person {
    const p = PersonSchema.parse({ ...person, updatedAt: new Date().toISOString() });
    this.db
      .prepare(`UPDATE persons SET name = ?, data = ?, updated_at = ? WHERE id = ?`)
      .run(p.name, JSON.stringify(p), p.updatedAt, p.id);
    return p;
  }

  /** Soft delete: the row stays (with the archived consents) so the audit keeps its references. */
  markDeleted(person: Person, at: string): void {
    this.db
      .prepare(`UPDATE persons SET data = ?, updated_at = ?, deleted_at = ? WHERE id = ?`)
      .run(JSON.stringify(person), at, at, person.id);
  }
}

/** `ai_licences` rows (LicenceAcceptance JSON). */
export class LicencesRepo {
  constructor(private readonly db: SqlDatabase) {}

  get(id: LicenceId): LicenceAcceptance | undefined {
    const row = this.db.prepare(`SELECT data FROM ai_licences WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row ? LicenceAcceptanceSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(): LicenceAcceptance[] {
    return (this.db.prepare(`SELECT data FROM ai_licences`).all() as { data: string }[]).map((r) =>
      LicenceAcceptanceSchema.parse(JSON.parse(r.data)),
    );
  }

  save(a: LicenceAcceptance): LicenceAcceptance {
    const v = LicenceAcceptanceSchema.parse(a);
    this.db
      .prepare(
        `INSERT INTO ai_licences (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(v.id, JSON.stringify(v), new Date().toISOString());
    return v;
  }
}

export interface AuditEntry {
  action: string;
  personId?: string;
  consentId?: string;
  jobId?: string;
  assetId?: string;
  data?: unknown;
}

export interface AuditRow extends AuditEntry {
  id: number;
  at: string;
}

/** Append-only `consent_audit` (no update/delete method on purpose). */
export class ConsentAudit {
  constructor(private readonly db: SqlDatabase) {}

  append(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO consent_audit (at, action, person_id, consent_id, job_id, asset_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        e.action,
        e.personId ?? null,
        e.consentId ?? null,
        e.jobId ?? null,
        e.assetId ?? null,
        e.data === undefined ? null : JSON.stringify(e.data),
      );
  }

  list(filter: { personId?: string; action?: string; limit?: number } = {}): AuditRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.personId) {
      where.push("person_id = ?");
      params.push(filter.personId);
    }
    if (filter.action) {
      where.push("action = ?");
      params.push(filter.action);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM consent_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC LIMIT ${Math.max(1, Math.min(1000, filter.limit ?? 200))}`,
      )
      .all(...params) as {
      id: number;
      at: string;
      action: string;
      person_id: string | null;
      consent_id: string | null;
      job_id: string | null;
      asset_id: string | null;
      data: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      ...(r.person_id && { personId: r.person_id }),
      ...(r.consent_id && { consentId: r.consent_id }),
      ...(r.job_id && { jobId: r.job_id }),
      ...(r.asset_id && { assetId: r.asset_id }),
      ...(r.data && { data: JSON.parse(r.data) as unknown }),
    }));
  }
}
