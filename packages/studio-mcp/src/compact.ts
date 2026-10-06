import path from "node:path";

/** Compact, Claude-friendly views of the API objects (short keys, rounded seconds). */

const r2 = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : undefined);

interface ClipLike {
  id: string;
  name?: string;
  assetId?: string;
  renderedAssetId?: string;
  start: number;
  in?: number;
  out: number;
  speed?: number;
  volume?: number;
  opacity?: number;
  text?: string;
  motion?: { template?: string };
  matte?: unknown;
  blendMode?: string;
  maskRef?: unknown;
  keyframes?: unknown;
}

interface TrackLike {
  id: string;
  kind: string;
  name: string;
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;
  order?: number;
  clips: ClipLike[];
}

export interface ProjectLike {
  id: string;
  name: string;
  settings: { width: number; height: number; fps: number };
  tracks: TrackLike[];
  subtitles?: { start: number; end: number; text: string }[];
  captionStyle?: unknown;
  publish?: unknown;
  reframe?: unknown;
  updatedAt?: string;
}

export const clipEnd = (c: Pick<ClipLike, "start" | "in" | "out" | "speed">) =>
  c.start + (c.out - (c.in ?? 0)) / (c.speed || 1);

export function compactProject(p: ProjectLike) {
  const duration = Math.max(0, ...p.tracks.flatMap((t) => t.clips.map(clipEnd)));
  return {
    id: p.id,
    name: p.name,
    canvas: { w: p.settings.width, h: p.settings.height, fps: p.settings.fps },
    duration_s: r2(duration),
    updatedAt: p.updatedAt,
    tracks: p.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      ...(t.muted && { muted: true }),
      ...(t.hidden && { hidden: true }),
      ...(t.locked && { locked: true }),
      ...(t.order !== undefined && { order: t.order }),
      clips: t.clips.map((c) => ({
        id: c.id,
        ...(c.name && { name: c.name }),
        ...(c.assetId && { assetId: c.assetId }),
        start: r2(c.start),
        end: r2(clipEnd(c)),
        ...((c.in ?? 0) > 0 && { in: r2(c.in) }),
        ...(c.speed && c.speed !== 1 && { speed: c.speed }),
        ...(c.volume !== undefined && c.volume !== 1 && { volume: c.volume }),
        ...(c.opacity !== undefined && c.opacity !== 1 && { opacity: c.opacity }),
        ...(c.text && { text: c.text.slice(0, 120) }),
        ...(c.motion?.template && { motion: c.motion.template }),
        ...(t.kind === "motion" && { rendered: Boolean(c.renderedAssetId) }),
        ...(c.matte !== undefined && { matte: true }),
        ...(c.blendMode && c.blendMode !== "normal" && { blend: c.blendMode }),
        ...(c.maskRef !== undefined && { mask: true }),
        ...(c.keyframes !== undefined && { keyframes: true }),
      })),
    })),
    subtitles: p.subtitles?.length ?? 0,
    ...(p.captionStyle !== undefined && { captionStyle: p.captionStyle }),
    ...(p.publish !== undefined && { publish: p.publish }),
    ...(p.reframe !== undefined && { reframe: true }),
  };
}

export interface AssetLike {
  id: string;
  name: string;
  kind: string;
  path: string;
  proxyPath?: string;
  thumbnailPath?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  hasAlpha?: boolean;
  scenes?: unknown[];
  createdAt?: string;
}

/** STORAGE_DIR-relative path → absolute (already absolute paths are kept). */
export function absStorage(storageDir: string | undefined, rel: string | undefined) {
  if (!rel) return undefined;
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || !storageDir) return rel;
  return path.join(storageDir, rel);
}

export function compactAsset(a: AssetLike, storageDir?: string) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    file: absStorage(storageDir, a.path),
    ...(a.thumbnailPath && { thumbnail: absStorage(storageDir, a.thumbnailPath) }),
    ...(a.durationSec !== undefined && { duration_s: r2(a.durationSec) }),
    ...(a.width && a.height && { size: `${a.width}x${a.height}` }),
    ...(a.fps && { fps: r2(a.fps) }),
    ...(a.hasAudio === false && { audio: false }),
    ...(a.hasAlpha && { alpha: true }),
    ...(a.scenes && { scenes: a.scenes.length }),
  };
}

const PATH_KEY = /(path|Path|file|File|_png|Png)$/;

/**
 * Collect every STORAGE_DIR-relative path inside a job result (keys ending in path/Path/file) as
 * absolute paths, so Claude Code can open images/JSON directly.
 */
export function collectFiles(value: unknown, storageDir?: string, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && PATH_KEY.test(k) && /\.[a-z0-9]{2,5}$/i.test(v)) {
      const abs = absStorage(storageDir, v);
      if (abs && !out.includes(abs)) out.push(abs);
    } else if (Array.isArray(v)) {
      for (const item of v.slice(0, 50)) {
        if (typeof item === "string" && PATH_KEY.test(k) && /\.[a-z0-9]{2,5}$/i.test(item)) {
          const abs = absStorage(storageDir, item);
          if (abs && !out.includes(abs)) out.push(abs);
        } else collectFiles(item, storageDir, out);
      }
    } else if (typeof v === "object") collectFiles(v, storageDir, out);
  }
  return out;
}

export interface JobLike {
  id: string;
  type: string;
  status: string;
  progress?: number;
  message?: string;
  error?: string;
  result?: unknown;
  projectId?: string;
}

export function compactJob(j: JobLike, storageDir?: string) {
  const files = collectFiles(j.result, storageDir);
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    progress: Math.round((j.progress ?? 0) * 100) / 100,
    ...(j.message && { message: j.message }),
    ...(j.error && { error: j.error }),
    ...(j.result !== undefined && { result: j.result }),
    ...(files.length > 0 && { files }),
  };
}
