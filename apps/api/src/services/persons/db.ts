import {
  LicenceAcceptanceSchema,
  PersonSchema,
  type LicenceAcceptance,
  type LicenceId,
  type Person,
} from "@studio/shared";
import { createHash } from "node:crypto";
import type { SqlDatabase } from "../../db/adapter.js";

/**
 * Sprint 4 M1 (docs/trabajo/sprint4-contratos.md «M1»): Personas with their consent history, the
 * on-screen licence acceptances and the append-only consent audit. The module owns its tables:
 * `ensurePersonsSchema` is idempotent (CREATE TABLE IF NOT EXISTS, like style_presets) and never
 * competes with the numbered MIGRATIONS of db/database.ts. `consent_audit` has no delete path:
 * SQLite triggers abort any UPDATE or DELETE on it, and every row carries `prev_hash` / `hash`
 * (sha256 chain over the previous row) so an edit made with another tool shows up (audit fix 11).
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
  data TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS consent_audit_person_idx ON consent_audit(person_id, at);
`;

/** Append-only enforcement, created after the (one-time) hash backfill of older storages. */
export const CONSENT_AUDIT_TRIGGERS_SQL = /* sql */ `
CREATE TRIGGER IF NOT EXISTS consent_audit_no_update BEFORE UPDATE ON consent_audit
BEGIN SELECT RAISE(ABORT, 'consent_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_audit_no_delete BEFORE DELETE ON consent_audit
BEGIN SELECT RAISE(ABORT, 'consent_audit is append-only'); END;
`;

/** prev_hash of the first row of the chain. */
export const AUDIT_GENESIS = "0".repeat(64);

interface RawAuditRow {
  id: number;
  at: string;
  action: string;
  person_id: string | null;
  consent_id: string | null;
  job_id: string | null;
  asset_id: string | null;
  data: string | null;
  prev_hash: string | null;
  hash: string | null;
}

/** sha256(prev_hash + canonical JSON of the row's content): the link of the chain. */
export function auditRowHash(
  prevHash: string,
  r: Pick<
    RawAuditRow,
    "at" | "action" | "person_id" | "consent_id" | "job_id" | "asset_id" | "data"
  >,
): string {
  const body = JSON.stringify([
    r.at,
    r.action,
    r.person_id,
    r.consent_id,
    r.job_id,
    r.asset_id,
    r.data,
  ]);
  return createHash("sha256").update(`${prevHash}\n${body}`).digest("hex");
}

export function ensurePersonsSchema(db: SqlDatabase): void {
  db.exec(PERSONS_SCHEMA_SQL);
  const cols = (db.prepare(`PRAGMA table_info(consent_audit)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("hash")) {
    // Storage of the first Sprint 4 build: add the chain columns and hash the existing rows once,
    // before the triggers exist (afterwards nothing can UPDATE the table).
    db.transaction(() => {
      if (!cols.includes("prev_hash"))
        db.exec(`ALTER TABLE consent_audit ADD COLUMN prev_hash TEXT`);
      db.exec(`ALTER TABLE consent_audit ADD COLUMN hash TEXT`);
      const rows = db.prepare(`SELECT * FROM consent_audit ORDER BY id`).all() as RawAuditRow[];
      let prev = AUDIT_GENESIS;
      const upd = db.prepare(`UPDATE consent_audit SET prev_hash = ?, hash = ? WHERE id = ?`);
      for (const r of rows) {
        const hash = auditRowHash(prev, r);
        upd.run(prev, hash, r.id);
        prev = hash;
      }
    });
  }
  db.exec(CONSENT_AUDIT_TRIGGERS_SQL);
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
  hash?: string;
}

/** Result of walking the hash chain from the first row. */
export interface AuditChainCheck {
  ok: boolean;
  checked: number;
  /** id of the first row whose prev_hash / hash does not match. */
  brokenAt?: number;
}

/** Append-only `consent_audit` (no update/delete method; triggers forbid them too). */
export class ConsentAudit {
  constructor(private readonly db: SqlDatabase) {}

  append(e: AuditEntry): void {
    this.db.transaction(() => {
      const last = this.db
        .prepare(`SELECT hash FROM consent_audit ORDER BY id DESC LIMIT 1`)
        .get() as { hash: string | null } | undefined;
      const prev = last?.hash ?? AUDIT_GENESIS;
      const row = {
        at: new Date().toISOString(),
        action: e.action,
        person_id: e.personId ?? null,
        consent_id: e.consentId ?? null,
        job_id: e.jobId ?? null,
        asset_id: e.assetId ?? null,
        data: e.data === undefined ? null : JSON.stringify(e.data),
      };
      this.db
        .prepare(
          `INSERT INTO consent_audit
             (at, action, person_id, consent_id, job_id, asset_id, data, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.at,
          row.action,
          row.person_id,
          row.consent_id,
          row.job_id,
          row.asset_id,
          row.data,
          prev,
          auditRowHash(prev, row),
        );
    });
  }

  /** Recompute the chain over every row (cheap: the table holds human-scale events). */
  verify(): AuditChainCheck {
    const rows = this.db.prepare(`SELECT * FROM consent_audit ORDER BY id`).all() as RawAuditRow[];
    let prev = AUDIT_GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev || r.hash !== auditRowHash(prev, r))
        return { ok: false, checked: rows.length, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
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
      .all(...params) as RawAuditRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      ...(r.person_id && { personId: r.person_id }),
      ...(r.consent_id && { consentId: r.consent_id }),
      ...(r.job_id && { jobId: r.job_id }),
      ...(r.asset_id && { assetId: r.asset_id }),
      ...(r.data && { data: JSON.parse(r.data) as unknown }),
      ...(r.hash && { hash: r.hash }),
    }));
  }
}
