import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  AUTO_DUCK,
  AUTO_DUCK_SIDECHAIN_GAIN,
  duckRatioFor,
  ExportJobPayloadSchema,
  ExportPresetSchema,
  inferTrackRole,
  loudnessFor,
  ProjectAudioMixSchema,
  SEGMENT_CACHE_SUBDIR,
  type ExportJobPayload,
  type ExportJobResult,
  type MediaAsset,
  type Project,
  type TrackRole,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { exportAiComment } from "../../services/ai-provenance.js";
import { disableEncoder, selectEncoder } from "../../services/encoder-select.js";
import { presetEncoding } from "../../services/ffmpeg/encoders.js";
import { resolveExportAspect } from "../../services/export/aspect-check.js";
import {
  exportBlockersMessage,
  findExportBlockers,
  type AudioMixPlan,
} from "../../services/ffmpeg/timeline.js";
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
 * Sprint 5: roles of the audible tracks and the ducking compressor (music under voice) when
 * `autoDuck` (request, else project.audioMix.autoDuck, default on) and both roles are present.
 */
export function exportAudioMix(
  project: Project,
  assetOf: (id: string) => MediaAsset | undefined,
  autoDuck: boolean | undefined,
): AudioMixPlan {
  const roles = new Map<string, TrackRole>();
  for (const t of project.tracks) roles.set(t.id, inferTrackRole(t, assetOf));
  const mix = ProjectAudioMixSchema.parse(project.audioMix ?? {});
  const on = autoDuck ?? mix.autoDuck;
  const audible = project.tracks.filter((t) => !t.muted && t.clips.length > 0);
  const has = (r: TrackRole) => audible.some((t) => roles.get(t.id) === r);
  if (!on || !has("voice") || !has("music")) return { roles };
  return {
    roles,
    duck: {
      threshold: AUTO_DUCK.threshold,
      ratio: duckRatioFor(mix.duckDb),
      attackMs: AUTO_DUCK.attackMs,
      releaseMs: AUTO_DUCK.releaseMs,
      levelSc: AUTO_DUCK_SIDECHAIN_GAIN,
    },
  };
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
      // Sprint 5: framing of another aspect (409 texts as job errors when it changed meanwhile).
      const aspectFit = resolveExportAspect(project, preset, req.aspectFit);
      const loudness = req.normalizeLoudness === false ? null : loudnessFor(preset);
      const audioMix = exportAudioMix(project, (id) => app.repos.media.get(id), req.autoDuck);
      ctx.reportProgress(0.01, "Preparando exportación", {
        stage_es: "Preparando exportación",
        cancellable: true,
      });
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
        ctx.reportProgress(0.02, "Renderizando", { stage_es: "Video", cancellable: true });
        ctx.log(
          `Encoder: ${encoder} · preset ${preset.id}` +
            (aspectFit ? ` · encuadre ${aspectFit}` : "") +
            (loudness
              ? ` · sonoridad ${loudness.integrated} LUFS / ${loudness.truePeak} dBTP`
              : ""),
        );
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
            ...(aspectFit && { aspectFit }),
            loudness,
            audioMix,
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
            onProgress: (r, message, items) =>
              ctx.reportProgress(0.02 + r * 0.97, message ?? "Renderizando", {
                stage_es: (message ?? "Renderizando").slice(0, 120),
                cancellable: true,
                ...(items && { done: items.done, total: items.total, unit: "blocks" as const }),
              }),
          },
        );
        if (outcome.fellBack) disableEncoder(app.repos.settings, encoder);
        const size = await stat(absPath(app, rel)).catch(() => undefined);
        result = {
          path: rel,
          mode: outcome.mode,
          ...(outcome.segments && { segments: outcome.segments }),
          ...(outcome.fallbackReason && { fallbackReason: outcome.fallbackReason }),
          durationS: Math.round(outcome.durationSec * 1000) / 1000,
          ...(size && { sizeBytes: size.size }),
          ...(aspectFit && { aspectFit }),
          ...(outcome.loudness && { loudness: outcome.loudness }),
          ...(outcome.ducked && { ducked: outcome.ducked }),
          ...(outcome.warningCodes?.length && { warnings: outcome.warningCodes }),
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
