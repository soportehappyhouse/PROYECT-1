import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LibraryItemDetailsSchema,
  LibraryItemSchema,
  LibraryPackManifestSchema,
  STORAGE_SUBDIRS,
  type LibraryItem,
  type LibraryItemDetails,
  type LibraryItemKind,
  type LibraryItemUpdate,
  type LibraryPackManifest,
  type LibraryScanResult,
  type LibrarySearchQuery,
  type Paginated,
} from "@studio/shared";
import type { SqlDatabase } from "../db/adapter.js";
import { HttpError } from "../lib/errors.js";
import { computePeaks } from "./peaks.js";
import type { LibraryProviderAdapter } from "./types.js";

export const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".m4a",
  ".aac",
]);
const KINDS: readonly LibraryItemKind[] = ["sfx", "music", "ambience"];
const MANIFEST = "_pack.json";
const PEAKS_DIR = "_peaks";
const SCAN_CONCURRENCY = 4;

interface StoredItem extends LibraryItemDetails {
  mtimeMs?: number;
}

export function libraryItemId(relPath: string): string {
  return `lib_${createHash("sha1").update(relPath).digest("hex").slice(0, 16)}`;
}

/** Build an FTS5 prefix query from free text ("puerta cierr" -> "puerta"* "cierr"*). */
export function ftsQuery(q: string): string | undefined {
  const tokens = q
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(" ") : undefined;
}

/** Tags from folder names + file name tokens (lowercase, deduplicated). */
export function tagsFromPath(relInsideLibrary: string, extra: readonly string[] = []): string[] {
  const parts = relInsideLibrary.split("/");
  const file = parts.pop() ?? "";
  const folders = parts.filter((p, i) => !(i === 0 && KINDS.includes(p as LibraryItemKind)));
  const words = [
    ...folders.flatMap((f) => f.split(/[^\p{L}\p{N}]+/u)),
    ...path.parse(file).name.split(/[^\p{L}\p{N}]+/u),
    ...extra,
  ];
  const out = new Set<string>();
  for (const w of words) {
    const t = w.toLowerCase().trim();
    if (t.length >= 3 && !/^\d+$/.test(t) && !t.startsWith("_")) out.add(t);
  }
  return [...out].slice(0, 30);
}

export function prettyName(file: string): string {
  return path.parse(file).name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeFileName(name: string): string {
  const base = path.basename(name).normalize("NFKC");
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/\s+/g, "_");
  return cleaned.replace(/^\.+/, "").slice(0, 120) || "audio";
}

async function sha256File(abs: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(abs))
    .digest("hex");
}

/**
 * Local sound library: storage/library indexed in SQLite (FTS5) with waveform peaks.
 * Tables: `library_items` (schema v1) + `library_fts` (db/database.ts MIGRATIONS v2).
 */
export class LibraryIndex implements LibraryProviderAdapter {
  readonly id = "local" as const;

  constructor(
    private readonly db: SqlDatabase,
    private readonly storageDir: string,
    private readonly ffmpegPath: string,
  ) {}

  enabled(): boolean {
    return true;
  }

  status(): string {
    return "local";
  }

  get root(): string {
    return path.join(this.storageDir, STORAGE_SUBDIRS.library);
  }

  #abs(relToStorage: string): string {
    return path.join(this.storageDir, ...relToStorage.split("/"));
  }

  get(id: string): StoredItem | undefined {
    const row = this.db.prepare("SELECT data FROM library_items WHERE id = ?").get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredItem) : undefined;
  }

  details(id: string): LibraryItemDetails | undefined {
    const item = this.get(id);
    return item ? LibraryItemDetailsSchema.parse(item) : undefined;
  }

  #findBySha(sha: string): StoredItem | undefined {
    const row = this.db
      .prepare("SELECT data FROM library_items WHERE json_extract(data, '$.sha256') = ? LIMIT 1")
      .get(sha) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredItem) : undefined;
  }

  upsert(item: StoredItem): void {
    const tags = item.tags.join(" ");
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO library_items (id, kind, name, tags, data) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
             tags = excluded.tags, data = excluded.data`,
        )
        .run(item.id, item.kind, item.name, tags, JSON.stringify(item));
      this.db.prepare("DELETE FROM library_fts WHERE item_id = ?").run(item.id);
      this.db
        .prepare("INSERT INTO library_fts (item_id, name, tags, author) VALUES (?, ?, ?, ?)")
        .run(item.id, item.name, tags, item.author ?? "");
    });
  }

  async remove(id: string, deleteFile = false): Promise<boolean> {
    const item = this.get(id);
    if (!item) return false;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM library_items WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM library_fts WHERE item_id = ?").run(id);
    });
    if (item.peaksPath) await rm(this.#abs(item.peaksPath), { force: true });
    if (deleteFile && item.path) await rm(this.#abs(item.path), { force: true });
    return true;
  }

  update(id: string, patch: LibraryItemUpdate): LibraryItemDetails {
    const item = this.get(id);
    if (!item) throw new HttpError(404, "NOT_FOUND", `Item de biblioteca ${id} no encontrado`);
    const next: StoredItem = { ...item, ...patch };
    if (patch.tags) next.tags = [...new Set(patch.tags.map((t) => t.toLowerCase().trim()))];
    this.upsert(next);
    return LibraryItemDetailsSchema.parse(next);
  }

  async search(query: LibrarySearchQuery): Promise<Paginated<LibraryItem>> {
    const offset = (query.page - 1) * query.pageSize;
    const match = ftsQuery(query.q);
    const kindSql = query.kind ? " AND i.kind = ?" : "";
    const kindArgs = query.kind ? [query.kind] : [];
    let rows: { data: string }[];
    let total: number;
    if (match) {
      const from = `FROM library_fts f JOIN library_items i ON i.id = f.item_id
        WHERE library_fts MATCH ?${kindSql}`;
      total = (
        this.db.prepare(`SELECT count(*) AS n ${from}`).get(match, ...kindArgs) as { n: number }
      ).n;
      rows = this.db
        .prepare(`SELECT i.data ${from} ORDER BY bm25(library_fts), i.name LIMIT ? OFFSET ?`)
        .all(match, ...kindArgs, query.pageSize, offset) as { data: string }[];
    } else {
      const where = query.kind ? "WHERE i.kind = ?" : "";
      total = (
        this.db.prepare(`SELECT count(*) AS n FROM library_items i ${where}`).get(...kindArgs) as {
          n: number;
        }
      ).n;
      rows = this.db
        .prepare(`SELECT i.data FROM library_items i ${where} ORDER BY i.name LIMIT ? OFFSET ?`)
        .all(...kindArgs, query.pageSize, offset) as { data: string }[];
    }
    return {
      items: rows.map((r) => LibraryItemSchema.parse(JSON.parse(r.data))),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async #manifestFor(
    relInsideLibrary: string,
    cache: Map<string, LibraryPackManifest | null>,
  ): Promise<LibraryPackManifest> {
    const dirs: string[] = [];
    let dir = path.posix.dirname(relInsideLibrary);
    while (dir && dir !== ".") {
      dirs.unshift(dir);
      dir = path.posix.dirname(dir);
    }
    dirs.unshift("");
    let merged: LibraryPackManifest = {};
    for (const d of dirs) {
      if (!cache.has(d)) {
        try {
          const raw = await readFile(path.join(this.root, ...d.split("/"), MANIFEST), "utf8");
          cache.set(d, LibraryPackManifestSchema.parse(JSON.parse(raw)));
        } catch {
          cache.set(d, null);
        }
      }
      const m = cache.get(d);
      if (m) merged = { ...merged, ...m, tags: [...(merged.tags ?? []), ...(m.tags ?? [])] };
    }
    return merged;
  }

  /**
   * Index (or re-index) one file under storage/library. `relInsideLibrary` uses "/" separators.
   * Unchanged files (same size + mtime) are skipped unless `force`.
   */
  async indexFile(
    relInsideLibrary: string,
    opts: {
      force?: boolean;
      overrides?: Partial<LibraryItemDetails>;
      manifestCache?: Map<string, LibraryPackManifest | null>;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ item: LibraryItemDetails; status: "added" | "updated" | "unchanged" }> {
    const relToStorage = `${STORAGE_SUBDIRS.library}/${relInsideLibrary}`;
    const abs = this.#abs(relToStorage);
    const info = await stat(abs);
    const id = libraryItemId(relToStorage);
    const existing = this.get(id);
    if (
      existing &&
      !opts.force &&
      !opts.overrides &&
      existing.mtimeMs === info.mtimeMs &&
      existing.sizeBytes === info.size
    ) {
      return { item: LibraryItemDetailsSchema.parse(existing), status: "unchanged" };
    }
    const manifest = await this.#manifestFor(relInsideLibrary, opts.manifestCache ?? new Map());
    const first = relInsideLibrary.split("/")[0] as LibraryItemKind;
    const kind = KINDS.includes(first) ? first : (manifest.kind ?? "sfx");
    const peaks = await computePeaks(this.ffmpegPath, abs, opts.signal);
    const peaksPath = `${STORAGE_SUBDIRS.library}/${PEAKS_DIR}/${id}.json`;
    await mkdir(path.dirname(this.#abs(peaksPath)), { recursive: true });
    await writeFile(this.#abs(peaksPath), JSON.stringify(peaks));
    const item: StoredItem = {
      id,
      kind,
      name: existing?.name ?? prettyName(relInsideLibrary),
      path: relToStorage,
      tags: existing?.tags ?? tagsFromPath(relInsideLibrary, manifest.tags ?? []),
      durationSec: peaks.durationSec,
      provider: "local",
      license: existing?.license ?? manifest.license ?? "unknown",
      ...((existing?.attribution ?? manifest.attribution) !== undefined && {
        attribution: existing?.attribution ?? manifest.attribution,
      }),
      ...(manifest.author !== undefined && { author: manifest.author }),
      ...(manifest.url !== undefined && { sourceUrl: manifest.url }),
      ...(manifest.source !== undefined && { source: manifest.source }),
      peaksPath,
      sha256: await sha256File(abs),
      sizeBytes: info.size,
      ...opts.overrides,
      mtimeMs: info.mtimeMs,
    };
    this.upsert(item);
    return { item: LibraryItemDetailsSchema.parse(item), status: existing ? "updated" : "added" };
  }

  async #walk(dir: string, prefix: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await this.#walk(path.join(dir, e.name), rel, out);
      else if (e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
        out.push(rel);
    }
  }

  /** Re-index storage/library: add new/changed files, drop rows whose file disappeared. */
  async scan(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<LibraryScanResult> {
    await mkdir(this.root, { recursive: true });
    const files: string[] = [];
    await this.#walk(this.root, "", files);
    const result: LibraryScanResult = {
      scanned: files.length,
      added: 0,
      updated: 0,
      removed: 0,
      errors: [],
    };
    const cache = new Map<string, LibraryPackManifest | null>();
    const seen = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const rel = files[next++]!;
        try {
          const { item, status } = await this.indexFile(rel, {
            ...(opts.force !== undefined && { force: opts.force }),
            manifestCache: cache,
            ...(opts.signal && { signal: opts.signal }),
          });
          seen.add(item.id);
          if (status === "added") result.added++;
          if (status === "updated") result.updated++;
        } catch (err) {
          seen.add(libraryItemId(`${STORAGE_SUBDIRS.library}/${rel}`));
          result.errors.push({
            path: rel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    const localRows = this.db
      .prepare("SELECT id FROM library_items WHERE json_extract(data, '$.provider') = 'local'")
      .all() as { id: string }[];
    for (const { id } of localRows) {
      if (!seen.has(id) && (await this.remove(id))) result.removed++;
    }
    return result;
  }

  /**
   * Store a new audio file in storage/library/<kind>/<source>/ and index it. Identical content
   * (sha256) already in the library is returned instead of duplicated.
   */
  async importBuffer(
    data: Buffer,
    meta: { fileName: string; kind: LibraryItemKind; source: string } & Partial<LibraryItemDetails>,
  ): Promise<{ item: LibraryItemDetails; duplicate: boolean }> {
    const ext = path.extname(meta.fileName).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext))
      throw new HttpError(
        400,
        "UNSUPPORTED_FORMAT",
        `Formato no soportado: ${ext || "(sin extensión)"}`,
      );
    const sha = createHash("sha256").update(data).digest("hex");
    const dup = this.#findBySha(sha);
    if (dup) return { item: LibraryItemDetailsSchema.parse(dup), duplicate: true };
    const dirRel = `${meta.kind}/${safeFileName(meta.source)}`;
    await mkdir(path.join(this.root, ...dirRel.split("/")), { recursive: true });
    const parsed = path.parse(safeFileName(meta.fileName));
    let name = `${parsed.name}${ext}`;
    for (let n = 1; ; n++) {
      try {
        await stat(path.join(this.root, ...dirRel.split("/"), name));
        name = `${parsed.name}-${n}${ext}`;
      } catch {
        break;
      }
    }
    const rel = `${dirRel}/${name}`;
    await writeFile(path.join(this.root, ...rel.split("/")), data);
    const { fileName: _f, kind, source, ...rest } = meta;
    const overrides: Partial<LibraryItemDetails> = { kind, source, ...rest };
    try {
      const { item } = await this.indexFile(rel, { overrides });
      return { item, duplicate: false };
    } catch (err) {
      await rm(path.join(this.root, ...rel.split("/")), { force: true });
      throw err;
    }
  }

  async peaks(id: string): Promise<unknown> {
    const item = this.get(id);
    if (!item?.peaksPath) throw new HttpError(404, "NOT_FOUND", `Sin forma de onda para ${id}`);
    return JSON.parse(await readFile(this.#abs(item.peaksPath), "utf8"));
  }
}
