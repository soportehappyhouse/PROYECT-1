import { nanoid } from "nanoid";
import {
  AudioEffectRequestSchema,
  type AudioEffectRequest,
  type FileJobResult,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { storageRelative } from "../../services/storage.js";
import type { JobHandler } from "../types.js";
import { absPath, fileSize, requireAsset } from "./util.js";

const CODEC: Record<AudioEffectRequest["format"], { ext: string; mime: string; args: string[] }> = {
  wav: { ext: "wav", mime: "audio/wav", args: ["-c:a", "pcm_s16le"] },
  mp3: { ext: "mp3", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-q:a", "2"] },
  m4a: { ext: "m4a", mime: "audio/mp4", args: ["-c:a", "aac", "-b:a", "192k"] },
};

/**
 * voice.effect: FFmpeg audio filter chain (fuentes-audio §4) -> storage/renders/<jobId>.<ext>,
 * registered as a new audio MediaAsset. Supports two-pass loudnorm and ducking under music.
 */
export function createVoiceEffectHandler(
  app: AppContext,
): JobHandler<AudioEffectRequest, FileJobResult> {
  return {
    type: "voice.effect",
    parse: (p) => AudioEffectRequestSchema.parse(p),
    async run(req, ctx, job) {
      const source = requireAsset(app, req.assetId);
      if (source.hasAudio === false) throw new Error("El asset no tiene audio");
      const ducking = req.effects.find((e) => e.type === "ducking");
      const music = ducking ? requireAsset(app, ducking.musicAssetId) : undefined;
      const codec = CODEC[req.format];
      const rel = storageRelative("renders", `${job.id}.${codec.ext}`);
      ctx.reportProgress(0.01, "Aplicando efectos de voz");
      await app.ffmpeg.applyVoiceEffects(
        absPath(app, source.path),
        absPath(app, rel),
        req.effects,
        {
          signal: ctx.signal,
          log: ctx.log,
          audioCodecArgs: codec.args,
          ...(source.durationSec !== undefined && { durationSec: source.durationSec }),
          ...(music && { musicPath: absPath(app, music.path) }),
          onProgress: (r) => ctx.reportProgress(0.01 + r * 0.95, "Aplicando efectos de voz"),
        },
      );
      const abs = absPath(app, rel);
      const info = await app.ffmpeg.probe(abs, ctx.signal).catch(() => undefined);
      const asset = app.repos.media.insert({
        id: nanoid(),
        kind: "audio",
        name: `${source.name} (efecto)`,
        path: rel,
        mimeType: codec.mime,
        sizeBytes: await fileSize(abs),
        hasAudio: true,
        hasVideo: false,
        ...(info?.durationSec !== undefined && { durationSec: info.durationSec }),
        ...(info?.sampleRate !== undefined && { sampleRate: info.sampleRate }),
        ...(info?.channels !== undefined && { channels: info.channels }),
        createdAt: new Date().toISOString(),
      });
      app.queue.enqueue({ type: "media.probe", payload: { assetId: asset.id }, priority: 1 });
      return { assetId: asset.id, path: rel };
    },
  };
}
