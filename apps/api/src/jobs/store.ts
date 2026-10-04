import { nanoid } from "nanoid";
import type { Job } from "@studio/shared";
import type { SqlDatabase, SqlParam } from "../db/adapter.js";
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
        `INSERT INTO jobs (id, type, status, progress, project_id, payload, created_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.projectId ?? null,
        JSON.stringify(input.payload ?? null),
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
                 ORDER BY created_at DESC LIMIT ?`;
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
    };
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof JobPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${map[key]} = ?`);
      params.push(key === "result" ? JSON.stringify(value) : (value as SqlParam));
    }
    if (sets.length)
      this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} not found`);
    return job;
  }

  nextQueued(): Job | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  recoverInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = 'Interrumpido por reinicio del servidor', finished_at = ?
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString()).changes;
  }
}
