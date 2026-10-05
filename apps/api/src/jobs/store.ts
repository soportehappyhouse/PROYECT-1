import { nanoid } from "nanoid";
import { JobDiagnosticsSchema, type Job, type JobDiagnostics } from "@studio/shared";
import type { SqlDatabase, SqlParam } from "../db/adapter.js";
import type { JobType } from "@studio/shared";
import type { CreateJobInput, JobListFilter, JobPatch, JobStore } from "./types.js";

interface JobRow {
  id: string;
  type: Job["type"];
  status: Job["status"];
  progress: number;
  message: string | null;
  project_id: string | null;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  priority: number;
  log_tail: string | null;
  diagnostics?: string | null;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress,
    payload: JSON.parse(r.payload) as unknown,
    ...(r.message !== null && { message: r.message }),
    ...(r.project_id !== null && { projectId: r.project_id }),
    ...(r.result !== null && { result: JSON.parse(r.result) as unknown }),
    ...(r.error !== null && { error: r.error }),
    createdAt: r.created_at,
    ...(r.started_at !== null && { startedAt: r.started_at }),
    ...(r.finished_at !== null && { finishedAt: r.finished_at }),
  };
}

/** better-sqlite3 implementation of JobStore (synchronous, single process). */
export class SqliteJobStore implements JobStore {
  constructor(private readonly db: SqlDatabase) {}

  create(input: CreateJobInput): Job {
    const id = nanoid();
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, status, progress, project_id, payload, priority, created_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.projectId ?? null,
        JSON.stringify(input.payload ?? null),
        input.priority ?? 0,
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  list(filter: JobListFilter = {}): Job[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.type) {
      where.push("type = ?");
      params.push(filter.type);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    params.push(filter.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as JobRow[]).map(rowToJob);
  }

  update(id: string, patch: JobPatch): Job {
    const map: Record<keyof JobPatch, string> = {
      status: "status",
      progress: "progress",
      message: "message",
      result: "result",
      error: "error",
      startedAt: "started_at",
      finishedAt: "finished_at",
      logTail: "log_tail",
      diagnostics: "diagnostics",
    };
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof JobPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${map[key]} = ?`);
      params.push(
        key === "result" || key === "diagnostics" ? JSON.stringify(value) : (value as SqlParam),
      );
    }
    if (sets.length)
      this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} not found`);
    return job;
  }

  nextQueued(): Job | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  claimNext(types: readonly JobType[]): Job | undefined {
    if (types.length === 0) return undefined;
    const placeholders = types.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, progress = 0, attempts = attempts + 1,
           finished_at = NULL, error = NULL
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND type IN (${placeholders})
                     ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString(), ...types) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  attempts(id: string): number {
    const row = this.db.prepare(`SELECT attempts FROM jobs WHERE id = ?`).get(id) as
      { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  logTail(id: string): string[] {
    const row = this.db.prepare(`SELECT log_tail FROM jobs WHERE id = ?`).get(id) as
      { log_tail: string | null } | undefined;
    return row?.log_tail ? row.log_tail.split("\n") : [];
  }

  diagnostics(id: string): JobDiagnostics | undefined {
    const row = this.db.prepare(`SELECT diagnostics FROM jobs WHERE id = ?`).get(id) as
      { diagnostics: string | null } | undefined;
    if (!row?.diagnostics) return undefined;
    try {
      const parsed = JobDiagnosticsSchema.safeParse(JSON.parse(row.diagnostics));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  recoverInterrupted(maxAttempts = 2): number {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE jobs SET status = 'failed', finished_at = ?,
             error = 'Interrumpido por reinicio del servidor (sin más reintentos)'
           WHERE status = 'running' AND attempts >= ?`,
        )
        .run(new Date().toISOString(), maxAttempts);
      return this.db
        .prepare(
          `UPDATE jobs SET status = 'queued', progress = 0, started_at = NULL,
             message = 'Reintentando tras reinicio del servidor'
           WHERE status = 'running'`,
        )
        .run().changes;
    });
  }
}
