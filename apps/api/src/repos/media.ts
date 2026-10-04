import { MediaAssetDetailsSchema, type MediaAssetDetails } from "@studio/shared";
import type { SqlDatabase } from "../db/adapter.js";

interface MediaRow {
  id: string;
  data: string;
  probe: string | null;
}

/** MediaAsset (+ derivatives) persisted as JSON in the `media` table. */
export class MediaRepo {
  constructor(private readonly db: SqlDatabase) {}

  insert(asset: MediaAssetDetails): MediaAssetDetails {
    const parsed = MediaAssetDetailsSchema.parse(asset);
    this.db
      .prepare(`INSERT INTO media (id, kind, data, created_at) VALUES (?, ?, ?, ?)`)
      .run(parsed.id, parsed.kind, JSON.stringify(parsed), parsed.createdAt);
    return parsed;
  }

  get(id: string): MediaAssetDetails | undefined {
    const row = this.db.prepare(`SELECT id, data, probe FROM media WHERE id = ?`).get(id) as
      MediaRow | undefined;
    return row ? (JSON.parse(row.data) as MediaAssetDetails) : undefined;
  }

  list(filter: { kind?: string; limit?: number } = {}): MediaAssetDetails[] {
    const rows = (
      filter.kind
        ? this.db
            .prepare(`SELECT data FROM media WHERE kind = ? ORDER BY created_at DESC LIMIT ?`)
            .all(filter.kind, filter.limit ?? 1000)
        : this.db
            .prepare(`SELECT data FROM media ORDER BY created_at DESC LIMIT ?`)
            .all(filter.limit ?? 1000)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MediaAssetDetails);
  }

  /** Shallow-merge a patch (re-validated) and persist. */
  update(id: string, patch: Partial<MediaAssetDetails>, probe?: unknown): MediaAssetDetails {
    const current = this.get(id);
    if (!current) throw new Error(`Media ${id} not found`);
    const next = MediaAssetDetailsSchema.parse({ ...current, ...patch, id });
    this.db
      .prepare(`UPDATE media SET kind = ?, data = ?, probe = COALESCE(?, probe) WHERE id = ?`)
      .run(next.kind, JSON.stringify(next), probe === undefined ? null : JSON.stringify(probe), id);
    return next;
  }

  probe(id: string): unknown {
    const row = this.db.prepare(`SELECT probe FROM media WHERE id = ?`).get(id) as
      { probe: string | null } | undefined;
    return row?.probe ? (JSON.parse(row.probe) as unknown) : undefined;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM media WHERE id = ?`).run(id).changes > 0;
  }
}
