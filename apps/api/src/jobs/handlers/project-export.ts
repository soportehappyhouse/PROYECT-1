import {
  ExportJobPayloadSchema,
  toExportPresetExt,
  type ExportJobPayload,
  type FileJobResult,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { disableEncoder, selectEncoder } from "../../services/encoder-select.js";
import { presetEncoding } from "../../services/ffmpeg/encoders.js";
import type { TimelineAsset } from "../../services/ffmpeg.js";
import { fileStamp, slugify } from "../../services/media-files.js";
import { storageRelative } from "../../services/storage.js";
import type { JobHandler } from "../types.js";
import { absPath, checkAborted, jobTmpDir } from "./util.js";

/** project.export: compile the timeline into one FFmpeg graph and render to storage/exports. */
export function createProjectExportHandler(
  app: AppContext,
): JobHandler<ExportJobPayload, FileJobResult> {
  return {
    type: "project.export",
    parse: (p) => ExportJobPayloadSchema.parse(p),
    async run(req, ctx, job) {
      const project = app.repos.projects.get(req.projectId);
      if (!project) throw new Error(`Proyecto ${req.projectId} no encontrado`);
      const stored = app.repos.presets.get(req.presetId);
      if (!stored) throw new Error(`Preset ${req.presetId} no encontrado`);
      const preset = toExportPresetExt(stored);

      ctx.reportProgress(0.01, "Preparando exportación");
      const ids = new Set<string>();
      for (const t of project.tracks)
        for (const c of t.clips) {
          if (c.assetId) ids.add(c.assetId);
          if (c.renderedAssetId) ids.add(c.renderedAssetId);
        }
      const assets = new Map<string, TimelineAsset>();
      for (const id of ids) {
        let a = app.repos.media.get(id);
        if (!a) continue;
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
        });
      }
      checkAborted(ctx);

      const encoder =
        preset.videoCodec === "h264"
          ? await selectEncoder(app.config, app.ffmpeg, app.repos.settings)
          : "libx264";
      const ext = presetEncoding(preset, encoder).extension;
      const rel = storageRelative(
        "exports",
        `${slugify(req.fileName ?? project.name)}-${fileStamp()}.${ext}`,
      );
      const tmp = await jobTmpDir(app, job.id);
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
          },
          {
            signal: ctx.signal,
            log: ctx.log,
            onProgress: (r) => ctx.reportProgress(0.02 + r * 0.97, "Renderizando"),
          },
        );
        if (outcome.fellBack) disableEncoder(app.repos.settings, encoder);
      } finally {
        await tmp.cleanup();
      }
      return { path: rel };
    },
  };
}
