import { MediaJobPayloadSchema, type FileJobResult, type MediaJobPayload } from "@studio/shared";
import type { AppContext } from "../../context.js";
import { disableEncoder, selectEncoder } from "../../services/encoder-select.js";
import { derivativePaths } from "../../services/media-files.js";
import type { JobHandler } from "../types.js";
import { absPath, requireAsset } from "./util.js";

/**
 * media.proxy: 360p H.264 editing proxy (keyframe every 15 frames) -> storage/proxies/<id>.mp4,
 * encoded with the detected hardware encoder (libx264 fallback).
 */
export function createMediaProxyHandler(
  app: AppContext,
): JobHandler<MediaJobPayload, FileJobResult> {
  return {
    type: "media.proxy",
    parse: (p) => MediaJobPayloadSchema.parse(p),
    async run({ assetId }, ctx) {
      let asset = requireAsset(app, assetId);
      const input = absPath(app, asset.path);
      if (asset.hasVideo === undefined || asset.durationSec === undefined) {
        ctx.reportProgress(0.01, "Analizando");
        const info = await app.ffmpeg.probe(input, ctx.signal);
        asset = app.repos.media.update(assetId, {
          hasVideo: info.hasVideo,
          hasAudio: info.hasAudio,
          ...(info.durationSec !== undefined && { durationSec: info.durationSec }),
        });
      }
      if (asset.kind !== "video" || asset.hasVideo === false) {
        throw new Error("Solo se generan proxies para video");
      }
      const out = derivativePaths(assetId).proxy;
      // Sprint 1: NVENC/QSV/AMF for proxies (HW_ENCODER=off forces libx264).
      const encoder = await selectEncoder(app.config, app.ffmpeg, app.repos.settings);
      ctx.reportProgress(0.02, "Generando proxy 360p");
      ctx.log(`Encoder del proxy: ${encoder}`);
      const used = await app.ffmpeg.makeProxy(input, absPath(app, out), {
        encoder,
        signal: ctx.signal,
        log: ctx.log,
        ...(asset.durationSec !== undefined && { durationSec: asset.durationSec }),
        ...(asset.hasAudio !== undefined && { hasAudio: asset.hasAudio }),
        onProgress: (r) => ctx.reportProgress(0.02 + r * 0.97, "Generando proxy 360p"),
      });
      if (used.fellBack) disableEncoder(app.repos.settings, encoder);
      app.repos.media.update(assetId, { proxyPath: out });
      return { assetId, path: out };
    },
  };
}
