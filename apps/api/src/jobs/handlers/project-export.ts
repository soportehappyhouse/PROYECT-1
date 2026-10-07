import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import {
  ExportJobPayloadSchema,
  ExportPresetSchema,
  SEGMENT_CACHE_SUBDIR,
  type ExportJobPayload,
  type ExportJobResult,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { exportAiComment } from "../../services/ai-provenance.js";
import { disableEncoder, selectEncoder } from "../../services/encoder-select.js";
import { presetEncoding } from "../../services/ffmpeg/encoders.js";
import { exportBlockersMessage, findExportBlockers } from "../../services/ffmpeg/timeline.js";
import type { TimelineAsset } from "../../services/ffmpeg.js";
import { fileStamp, slugify } from "../../services/media-files.js";
import { loadTrackFiles } from "../../services/vision-assets.js";
import { storageRelative } from "../../services/storage.js";
import type { JobHandler } from "../types.js";
import { absPath, checkAborted, jobTmpDir } from "./util.js";

/**
 * exports/<base>.<ext>, or <base>-2.<ext>, ... when taken: the name is reserved atomically
 * (exclusive create) so two exports started in the same second never overwrite each other.
 */
async function reserveExportPath(app: AppContext, base: string, ext: string): Promise<string> {
  await mkdir(absPath(app, "exports"), { recursive: true });
  for (let n = 1; ; n++) {
    const rel = storageRelative("exports", `${base}${n > 1 ? `-${n}` : ""}.${ext}`);
    try {
      await (await open(absPath(app, rel), "wx")).close();
      return rel;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 1000) throw err;
    }
  }
}

/**
 * project.export: compile the timeline into FFmpeg graphs and render to storage/exports. With
 * `useSegmentCache` (default) the video is rendered by blocks cached in storage/cache/segments.
 */
export function createProjectExportHandler(
  app: AppContext,
): JobHandler<ExportJobPayload, ExportJobResult> {
  return {
    type: "project.export",
    parse: (p) => ExportJobPayloadSchema.parse(p),
    async run(req, ctx, job) {
      const project = app.repos.projects.get(req.projectId);
      if (!project) throw new Error(`Proyecto ${req.projectId} no encontrado`);
      const stored = app.repos.presets.get(req.presetId);
      if (!stored) throw new Error(`Preset ${req.presetId} no encontrado`);
      const preset = ExportPresetSchema.parse(stored);

      // B3/B4: the project may have changed since the route checked it (deleted media, new clip).
      const blocked = exportBlockersMessage(
        findExportBlockers(project, (id) => !!app.repos.media.get(id), req.range),
      );
      if (blocked) throw new Error(blocked);
      ctx.reportProgress(0.01, "Preparando exportación");
      const ids = new Set<string>();
      const trackIds = new Set<string>();
      const maskIds = new Set<string>();
      for (const t of project.tracks)
        for (const c of t.clips) {
          if (c.assetId) ids.add(c.assetId);
          if (c.renderedAssetId) ids.add(c.renderedAssetId);
          // Sprint 2: cut-out alpha + its background media, tracks followed by the clip.
          if (c.matte) {
            ids.add(c.matte.assetId);
            const bg = c.matte.background;
            if (bg?.value && (bg.type === "image" || bg.type === "video")) ids.add(bg.value);
          }
          if (c.trackRef) trackIds.add(c.trackRef.assetId);
          // Sprint 3b: asset mask of the clip (SAM mask folder / image / alpha video).
          if (c.maskRef?.type === "asset") maskIds.add(c.maskRef.assetId);
        }
      const tracks = await loadTrackFiles(app, trackIds, (w) => ctx.log(`AVISO: ${w}`));
      for (const tf of tracks.values()) ids.add(tf.source.assetId); // media size for the mapping
      const assets = new Map<string, TimelineAsset>();
      for (const id of maskIds) ids.add(id);
      for (const id of ids) {
        let a = app.repos.media.get(id);
        if (a?.kind === "mask" && maskIds.has(id)) {
          // Folder of PNGs (or one PNG): no probe, read by the compiler as an image sequence.
          assets.set(id, {
            id,
            absPath: absPath(app, a.path),
            kind: "mask",
            hasVideo: true,
            hasAudio: false,
            ...(a.fps !== undefined && { fps: a.fps }),
            ...(a.width && a.height && { width: a.width, height: a.height }),
          });
          continue;
        }
        if (!a || a.kind === "track" || a.kind === "mask") continue;
        if (a.hasVideo === undefined || a.hasAudio === undefined) {
          const info = await app.ffmpeg.probe(absPath(app, a.path), ctx.signal);
          a = app.repos.media.update(id, {
            kind: info.kind,
            hasVideo: info.hasVideo,
            hasAudio: info.hasAudio,
            hasAlpha: info.hasAlpha,
            ...(info.videoCodec && { videoCodec: info.videoCodec }),
            ...(info.durationSec !== undefined && { durationSec: info.durationSec }),
          });
        }
        assets.set(id, {
          id,
          absPath: absPath(app, a.path),
          kind: a.kind,
          hasVideo: a.hasVideo ?? a.kind !== "audio",
          hasAudio: a.hasAudio ?? a.kind !== "image",
          ...(a.hasAlpha !== undefined && { hasAlpha: a.hasAlpha }),
          ...(a.videoCodec && { videoCodec: a.videoCodec }),
          ...(a.durationSec !== undefined && { durationSec: a.durationSec }),
          ...(a.width && a.height && { width: a.width, height: a.height }),
          ...(a.fps !== undefined && { fps: a.fps }),
        });
      }
      checkAborted(ctx);

      const encoder =
        preset.videoCodec === "h264"
          ? await selectEncoder(app.config, app.ffmpeg, app.repos.settings)
          : "libx264";
      const ext = presetEncoding(preset, encoder).extension;
      const rel = await reserveExportPath(
        app,
        `${slugify(req.fileName ?? project.name)}-${fileStamp()}`,
        ext,
      );
      const tmp = await jobTmpDir(app, job.id);
      const aiComment = exportAiComment(app, project);
      if (aiComment) ctx.log(`Metadato de IA: ${aiComment}`);
      let result: ExportJobResult = { path: rel };
      try {
        ctx.reportProgress(0.02, "Renderizando");
        ctx.log(`Encoder: ${encoder} · preset ${preset.id}`);
        const outcome = await app.ffmpeg.exportProject(
          {
            project,
            preset,
            assets,
            output: absPath(app, rel),
            workDir: tmp.dir,
            encoder,
            ...(req.range && { range: req.range }),
            ...(tracks.size > 0 && { tracks }),
            ...(req.burnSubtitles !== undefined && { burnSubtitles: req.burnSubtitles }),
            // Sprint 4 (decision 9): invisible traceability of AI content, label on or off.
            ...(aiComment && { metadataComment: aiComment }),
            ...(req.useSegmentCache !== false && {
              segmentCache: {
                dir: path.join(app.config.storageDir, SEGMENT_CACHE_SUBDIR),
                maxBytes: app.config.segmentCacheMaxBytes,
              },
            }),
          },
          {
            signal: ctx.signal,
            log: ctx.log,
            onProgress: (r, message) =>
              ctx.reportProgress(0.02 + r * 0.97, message ?? "Renderizando"),
          },
        );
        if (outcome.fellBack) disableEncoder(app.repos.settings, encoder);
        result = {
          path: rel,
          mode: outcome.mode,
          ...(outcome.segments && { segments: outcome.segments }),
          ...(outcome.fallbackReason && { fallbackReason: outcome.fallbackReason }),
        };
      } catch (err) {
        await rm(absPath(app, rel), { force: true }); // drop the reserved (partial) output
        throw err;
      } finally {
        await tmp.cleanup();
      }
      return result;
    },
  };
}
