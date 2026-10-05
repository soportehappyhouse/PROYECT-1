import { nanoid } from "nanoid";
import type { AgentPlanRecord, AgentPlanStatus, Project } from "@studio/shared";
import type { SqlDatabase } from "../db/adapter.js";

/** Sprint 3: EditPlans proposed by the local agent (`agent_plans`) and undo snapshots. */
export class AgentPlanRepo {
  constructor(private readonly db: SqlDatabase) {}

  insert(record: AgentPlanRecord): AgentPlanRecord {
    this.db
      .prepare(
        `INSERT INTO agent_plans (id, project_id, command, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.command,
        record.status,
        JSON.stringify(record),
        record.created_at,
        record.created_at,
      );
    return record;
  }

  get(id: string): AgentPlanRecord | undefined {
    const row = this.db.prepare(`SELECT data FROM agent_plans WHERE id = ?`).get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AgentPlanRecord) : undefined;
  }

  /** Newest first. */
  list(filter: { projectId?: string; limit?: number } = {}): AgentPlanRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const rows = (
      filter.projectId
        ? this.db
            .prepare(
              `SELECT data FROM agent_plans WHERE project_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(filter.projectId, limit)
        : this.db
            .prepare(`SELECT data FROM agent_plans ORDER BY created_at DESC, rowid DESC LIMIT ?`)
            .all(limit)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AgentPlanRecord);
  }

  update(
    id: string,
    patch: Partial<Omit<AgentPlanRecord, "id" | "projectId" | "created_at">>,
  ): AgentPlanRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: AgentPlanRecord = { ...current, ...patch };
    this.db
      .prepare(`UPDATE agent_plans SET status = ?, data = ?, updated_at = ? WHERE id = ?`)
      .run(next.status, JSON.stringify(next), new Date().toISOString(), id);
    return next;
  }

  setStatus(id: string, status: AgentPlanStatus): AgentPlanRecord | undefined {
    return this.update(id, { status });
  }

  /** Store the project as it was before agent.apply; returns the snapshot id. */
  snapshot(project: Project, planId?: string): string {
    const id = nanoid();
    this.db
      .prepare(
        `INSERT INTO agent_snapshots (id, project_id, plan_id, data, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, project.id, planId ?? null, JSON.stringify(project), new Date().toISOString());
    return id;
  }

  getSnapshot(id: string): { projectId: string; planId?: string; project: Project } | undefined {
    const row = this.db
      .prepare(`SELECT project_id, plan_id, data FROM agent_snapshots WHERE id = ?`)
      .get(id) as { project_id: string; plan_id: string | null; data: string } | undefined;
    if (!row) return undefined;
    return {
      projectId: row.project_id,
      ...(row.plan_id && { planId: row.plan_id }),
      project: JSON.parse(row.data) as Project,
    };
  }
}
