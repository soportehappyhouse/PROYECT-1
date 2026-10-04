import { writeFile } from "node:fs/promises";
import {
  MediaJobPayloadSchema,
  type FileJobResult,
  type MediaAssetDetails,
  type MediaJobPayload,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { derivativePaths, EXT_MIME } from "../../services/media-files.js";
import type { JobHandler } from "../types.js";
import { absPath, checkAborted, optionalStep, requireAsset } from "./util.js";

/**
 * media.probe: ffprobe -> metadata on the MediaAsset (+ raw JSON in media.probe), then thumbnail,
 * sprite sheet (video) and waveform peaks JSON (audio) under storage/proxies.
 */
export function createMediaProbeHandler(
  app: AppContext,
): JobHandler<MediaJobPayload, FileJobResult> {
  return {
    type: "media.probe",
    parse: (p) => MediaJobPayloadSchema.parse(p),
    async run({ assetId }, ctx) {
      const asset = requireAsset(app, assetId);
      if (asset.kind === "subtitle" || asset.kind === "lottie")
        return { assetId, path: asset.path };
      const input = absPath(app, asset.path);
      const { signal } = ctx;
      const log = ctx.log;
      ctx.reportProgress(0.05, "Analizando con ffprobe");
      const info = await app.ffmpeg.probe(input, signal);
      const { raw, ...meta } = info;
      const ext = asset.path.split(".").pop()?.toLowerCase() ?? "";
      const patch: Partial<MediaAssetDetails> = {
        kind: meta.kind,
        hasVideo: meta.hasVideo,
        hasAudio: meta.hasAudio,
        hasAlpha: meta.hasAlpha,
        ...(meta.durationSec !== undefined && { durationSec: meta.durationSec }),
        ...(meta.width !== undefined && { width: meta.width }),
        ...(meta.height !== undefined && { height: meta.height }),
        ...(meta.fps !== undefined && { fps: meta.fps }),
        ...(meta.sampleRate !== undefined && { sampleRate: meta.sampleRate }),
        ...(meta.channels !== undefined && { channels: meta.channels }),
        ...(meta.videoCodec && { videoCodec: meta.videoCodec }),
        ...(meta.audioCodec && { audioCodec: meta.audioCodec }),
        ...(!asset.mimeType && EXT_MIME[ext] && { mimeType: EXT_MIME[ext] }),
      };
      let current = app.repos.media.update(assetId, patch, raw);
      const paths = derivativePaths(assetId);
      checkAborted(ctx);

      if (meta.hasVideo) {
        ctx.reportProgress(0.25, "Generando miniatura");
        const at =
          meta.kind === "video" && meta.durationSec
            ? Math.min(1, meta.durationSec * 0.1)
            : undefined;
        const ok = await optionalStep(ctx, "Miniatura", async () => {
          await app.ffmpeg.thumbnail(input, absPath(app, paths.thumbnail), at, { signal, log });
          return true;
        });
        if (ok) current = app.repos.media.update(assetId, { thumbnailPath: paths.thumbnail });
      }
      checkAborted(ctx);

      if (meta.kind === "video" && meta.hasVideo && meta.durationSec) {
        ctx.reportProgress(0.45, "Generando sprite de miniaturas");
        const sprite = await optionalStep(ctx, "Sprite", () =>
          app.ffmpeg.sprite(input, absPath(app, paths.sprite), meta.durationSec!, { signal, log }),
        );
        if (sprite)
          current = app.repos.media.update(assetId, { sprite: { ...sprite, path: paths.sprite } });
      }
      checkAborted(ctx);

      if (meta.hasAudio) {
        ctx.reportProgress(0.7, "Calculando forma de onda");
        const peaks = await optionalStep(ctx, "Forma de onda", () =>
          app.ffmpeg.waveformPeaks(input, meta.durationSec, {
            signal,
            log,
            onProgress: (r) => ctx.reportProgress(0.7 + r * 0.29, "Calculando forma de onda"),
          }),
        );
        if (peaks) {
          await writeFile(absPath(app, paths.peaks), JSON.stringify(peaks));
          current = app.repos.media.update(assetId, { waveformPath: paths.peaks });
        }
      }
      return { assetId, path: current.path };
    },
  };
}
