import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MediaAssetSchema,
  TrackFileSchema,
  type MediaAsset,
  type MediaKind,
  type TrackFile,
} from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../context.js";
import { resolveStoragePath } from "./storage.js";

/** Sprint 2: storage/masks/<session|job>/ holds SAM mask PNGs (served by /files). */
export const MASKS_SUBDIR = "masks";

type Deps = Pick<AppContext, "config" | "repos" | "queue">;

/** Safe single path segment (session ids come from the workers). */
export const safeSegment = (s: string) => s.replace(/[^\w.-]/g, "_").slice(0, 80) || "x";

/** Read and validate a track.json (relative to STORAGE_DIR). */
export async function readTrackFile(storageDir: string, rel: string): Promise<TrackFile> {
  const raw = JSON.parse(await readFile(resolveStoragePath(storageDir, rel), "utf8")) as unknown;
  return TrackFileSchema.parse(raw);
}

/** Track files of `ids` (asset kind "track"); missing / invalid ones are skipped (warning). */
export async function loadTrackFiles(
  deps: Pick<AppContext, "config" | "repos">,
  ids: Iterable<string>,
  warn: (line: string) => void = () => {},
): Promise<Map<string, TrackFile>> {
  const out = new Map<string, TrackFile>();
  for (const id of new Set(ids)) {
    const asset = deps.repos.media.get(id);
    if (!asset) {
      warn(`Seguimiento ${id} no encontrado: el clip queda fijo`);
      continue;
    }
    try {
      out.set(id, await readTrackFile(deps.config.storageDir, asset.path));
    } catch (err) {
      warn(`Seguimiento ${id} ilegible (${String(err)}): el clip queda fijo`);
    }
  }
  return out;
}

/** Write a TrackFile under renders/ and register it as an asset of kind "track". */
export async function registerTrackAsset(
  deps: Deps,
  track: TrackFile,
  o: { jobId: string; name: string },
): Promise<MediaAsset> {
  const rel = `renders/${o.jobId}.track.json`;
  await writeFile(resolveStoragePath(deps.config.storageDir, rel), JSON.stringify(track), "utf8");
  const frames = track.frames;
  const durationSec = frames.length ? Math.max(0, frames.at(-1)!.t - frames[0]!.t) : undefined;
  return registerFileAsset(deps, {
    kind: "track",
    path: rel,
    name: o.name,
    mimeType: "application/json",
    ...(durationSec !== undefined && { durationSec }),
    fps: track.fps,
  });
}

/** Copy a file or folder written by the workers into storage/masks/<dir>/ (servable by /files). */
export async function copyIntoMasks(
  storageDir: string,
  fromRel: string,
  dir: string,
  name?: string,
): Promise<string> {
  const src = resolveStoragePath(storageDir, fromRel);
  const destRel = name
    ? `${MASKS_SUBDIR}/${safeSegment(dir)}/${safeSegment(name)}`
    : `${MASKS_SUBDIR}/${safeSegment(dir)}`;
  const dest = resolveStoragePath(storageDir, destRel);
  await mkdir(name ? path.dirname(dest) : dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
  return destRel;
}

/** First PNG of a mask asset (folder) or the asset file itself. */
export async function maskPngOf(storageDir: string, asset: MediaAsset): Promise<string> {
  const abs = resolveStoragePath(storageDir, asset.path);
  const st = await stat(abs);
  if (!st.isDirectory()) return asset.path;
  const png = (await readdir(abs)).filter((n) => n.toLowerCase().endsWith(".png")).sort()[0];
  if (!png) throw new Error(`La máscara ${asset.id} no tiene imágenes PNG`);
  return `${asset.path.replace(/\/+$/, "")}/${png}`;
}

export interface NewFileAsset {
  kind: MediaKind;
  path: string;
  name: string;
  mimeType?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  hasAlpha?: boolean;
  videoCodec?: string;
  /** Enqueue media.probe (+ proxy) for video/image assets. */
  probe?: boolean;
}

/** Register a file (or folder) written under storage as a MediaAsset. */
export async function registerFileAsset(deps: Deps, a: NewFileAsset): Promise<MediaAsset> {
  const st = await stat(resolveStoragePath(deps.config.storageDir, a.path));
  const { probe, ...fields } = a;
  const asset = deps.repos.media.insert(
    MediaAssetSchema.parse({
      id: nanoid(),
      ...fields,
      name: a.name.slice(0, 200),
      sizeBytes: st.isDirectory() ? 0 : st.size,
      createdAt: new Date().toISOString(),
    }),
  );
  if (probe && deps.queue.hasHandler("media.probe"))
    deps.queue.enqueue({ type: "media.probe", payload: { assetId: asset.id }, priority: 1 });
  return asset;
}
