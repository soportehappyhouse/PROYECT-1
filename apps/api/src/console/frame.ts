import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXPORT_PRESETS,
  TMP_SUBDIR,
  type ExportPreset,
  type Project,
} from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../context.js";
import type { TimelineAsset } from "../services/ffmpeg.js";
import { clipDuration, timelineDuration } from "../services/ffmpeg/timeline.js";
import { resolveStoragePath } from "../services/storage.js";
import { loadTrackFiles } from "../services/vision-assets.js";

/**
 * `GET /api/projects/:id/frame?t=` (Sprint 3b, studio_preview_frame): one PNG of the project at
 * time t, so Claude can "look" at the edit.
 *
 * Method «export» (default): the export compiler renders a 2-frame window [t, t + 2/fps) of the
 * whole timeline (all tracks, texts, captions, cut-outs, motion already rendered) to a scratch
 * mp4 and the first frame is saved as PNG — the same pixels an export would produce.
 * Method «proxy» (fallback when the compiler fails, e.g. missing media): the frame of the top-most
 * visible video/image clip under t, read from its proxy (or the original); no overlays.
 */

export const FRAMES_SUBDIR = "renders/frames";

export interface FrameResult {
  /** Absolute PNG path (what Claude Code reads). */
  path: string;
  /** STORAGE_DIR-relative path and /files URL. */
  relPath: string;
  url: string;
  t: number;
  width: number;
  height: number;
  method: "export" | "proxy";
  warnings: string[];
}

const EPS = 1e-3;

function framePreset(project: Project): ExportPreset {
  const base = DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!;
  return {
    ...base,
    id: "studio-frame",
    name: "Fotograma",
    width: project.settings.width,
    height: project.settings.height,
    fps: project.settings.fps || 30,
    crf: 16,
    builtIn: false,
  };
}

function timelineAssets(app: AppContext, project: Project): Map<string, TimelineAsset> {
  const ids = new Set<string>();
  for (const t of project.tracks)
    for (const c of t.clips) {
      if (c.assetId) ids.add(c.assetId);
      if (c.renderedAssetId) ids.add(c.renderedAssetId);
      if (c.matte) {
        ids.add(c.matte.assetId);
        const bg = c.matte.background;
        if (bg?.value && (bg.type === "image" || bg.type === "video")) ids.add(bg.value);
      }
    }
  const assets = new Map<string, TimelineAsset>();
  for (const id of ids) {
    const a = app.repos.media.get(id);
    if (!a || a.kind === "track" || a.kind === "mask") continue;
    assets.set(id, {
      id,
      absPath: resolveStoragePath(app.config.storageDir, a.path),
      kind: a.kind,
      hasVideo: a.hasVideo ?? a.kind !== "audio",
      hasAudio: a.hasAudio ?? a.kind !== "image",
      ...(a.hasAlpha !== undefined && { hasAlpha: a.hasAlpha }),
      ...(a.videoCodec && { videoCodec: a.videoCodec }),
      ...(a.durationSec !== undefined && { durationSec: a.durationSec }),
      ...(a.width && a.height && { width: a.width, height: a.height }),
    });
  }
  return assets;
}

/** Top-most visible video/image clip under t and the source time to read. */
export function clipUnder(
  project: Project,
  t: number,
): { assetId: string; sourceTime: number } | undefined {
  // Later tracks (or a higher Track.order, Sprint 3b layers) are drawn on top.
  const tracks = project.tracks
    .map((tr, i) => ({ tr, z: (tr as { order?: number }).order ?? i }))
    .filter(({ tr }) => tr.kind === "video" && !tr.hidden)
    .sort((a, b) => a.z - b.z)
    .map(({ tr }) => tr);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i]!;
    for (const c of track.clips) {
      if (!c.assetId) continue;
      const end = c.start + clipDuration(c);
      if (t + EPS >= c.start && t < end - EPS)
        return { assetId: c.assetId, sourceTime: c.in + (t - c.start) * (c.speed || 1) };
    }
  }
  return undefined;
}

export async function renderProjectFrame(
  app: AppContext,
  project: Project,
  tRaw: number,
): Promise<FrameResult> {
  const total = timelineDuration(project);
  const fps = project.settings.fps || 30;
  const t = Math.max(0, Math.min(tRaw, Math.max(0, total - 2 / fps)));
  const ms = Math.round(t * 1000);
  const relPath = `${FRAMES_SUBDIR}/${project.id}-${ms}.png`;
  const out = resolveStoragePath(app.config.storageDir, relPath);
  await mkdir(path.dirname(out), { recursive: true });
  const workDir = path.join(app.config.storageDir, TMP_SUBDIR, `frame-${nanoid(8)}`);
  await mkdir(workDir, { recursive: true });
  const warnings: string[] = [];
  const base = {
    path: out,
    relPath,
    url: `/files/${relPath}`,
    t,
    width: project.settings.width,
    height: project.settings.height,
  };
  try {
    if (total > EPS) {
      try {
        const trackIds = new Set<string>();
        for (const tr of project.tracks)
          for (const c of tr.clips) if (c.trackRef) trackIds.add(c.trackRef.assetId);
        const tracks = await loadTrackFiles(app, trackIds, (w) => warnings.push(w));
        const clip = path.join(workDir, "frame.mp4");
        const outcome = await app.ffmpeg.exportProject({
          project,
          preset: framePreset(project),
          assets: timelineAssets(app, project),
          output: clip,
          workDir,
          encoder: "libx264",
          range: { start: t, end: Math.min(total, t + 2 / fps) },
          ...(tracks.size > 0 && { tracks }),
        });
        warnings.push(...outcome.warnings);
        await app.ffmpeg.run(["-i", clip, "-frames:v", "1", "-update", "1", out], {
          cwd: workDir,
        });
        return { ...base, method: "export", warnings };
      } catch (err) {
        warnings.push(
          `Render completo no disponible (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); se usa el clip bajo el cursor`,
        );
      }
    }
    const hit = clipUnder(project, t);
    if (!hit) throw new Error(`No hay video ni imagen en t = ${t.toFixed(2)} s`);
    const asset = app.repos.media.get(hit.assetId);
    if (!asset) throw new Error(`Medio ${hit.assetId} no encontrado`);
    const src = resolveStoragePath(app.config.storageDir, asset.proxyPath ?? asset.path);
    const args =
      asset.kind === "image"
        ? ["-i", src, "-frames:v", "1", "-update", "1", out]
        : ["-ss", hit.sourceTime.toFixed(3), "-i", src, "-frames:v", "1", "-update", "1", out];
    await app.ffmpeg.run(args, { cwd: workDir });
    return {
      ...base,
      method: "proxy",
      warnings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
