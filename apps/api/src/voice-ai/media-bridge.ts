import { stat } from "node:fs/promises";
import { MediaAssetSchema, type AiProvenance, type MediaAsset } from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../context.js";
import { HttpError } from "../lib/errors.js";
import { resolveStoragePath } from "../services/storage.js";

/** Read the input asset of a workers-backed job (MediaRepo, module b). */
export function getMediaAsset(ctx: Pick<AppContext, "repos">, id: string): MediaAsset | undefined {
  return ctx.repos.media.get(id);
}

export function requireMediaAsset(ctx: Pick<AppContext, "repos">, id: string): MediaAsset {
  const asset = getMediaAsset(ctx, id);
  if (!asset) throw new HttpError(404, "NOT_FOUND", `Medio ${id} no encontrado`);
  return asset;
}

/**
 * Asset used as a matte guide (`maskAssetId`): a SAM mask (kind "mask") or a PNG image. Anything
 * else (a video, an audio file…) is a 400 INVALID_MASK_ASSET.
 */
export function requireMaskAsset(ctx: Pick<AppContext, "repos">, id: string): MediaAsset {
  const asset = requireMediaAsset(ctx, id);
  const png =
    asset.kind === "image" &&
    (asset.mimeType === "image/png" || asset.path.toLowerCase().endsWith(".png"));
  if (asset.kind !== "mask" && !png)
    throw new HttpError(
      400,
      "INVALID_MASK_ASSET",
      `«${asset.name}» no es una máscara: elegí una máscara SAM o una imagen PNG`,
    );
  return asset;
}

export interface NewAudioAsset {
  /** Relative to STORAGE_DIR. */
  path: string;
  name: string;
  durationSec?: number;
  sampleRate?: number;
  mimeType?: string;
  id?: string;
  /** Sprint 4: "voice-ref" for a «Voz propia» sample (never probed: media.probe would reset kind). */
  kind?: "audio" | "voice-ref";
  channels?: number;
  /** Sprint 4: synthetic/cloned voice (or derived from one) and what generated it. */
  aiAltered?: boolean;
  aiProvenance?: AiProvenance;
}

/** Insert a generated/imported audio file as a MediaAsset and kick off its probe (waveform peaks). */
export async function registerAudioAsset(
  ctx: Pick<AppContext, "repos" | "config" | "queue">,
  input: NewAudioAsset,
): Promise<MediaAsset> {
  const abs = resolveStoragePath(ctx.config.storageDir, input.path);
  const info = await stat(abs);
  const now = new Date().toISOString();
  const kind = input.kind ?? "audio";
  const asset = MediaAssetSchema.parse({
    id: input.id ?? nanoid(),
    kind,
    name: input.name.slice(0, 200),
    path: input.path,
    mimeType: input.mimeType ?? mimeFor(input.path),
    sizeBytes: info.size,
    ...(input.durationSec !== undefined && { durationSec: input.durationSec }),
    ...(input.sampleRate !== undefined && { sampleRate: input.sampleRate }),
    ...(input.channels !== undefined && { channels: input.channels }),
    ...(kind === "voice-ref" && { hasAudio: true, hasVideo: false }),
    ...(input.aiAltered !== undefined && { aiAltered: input.aiAltered }),
    ...(input.aiProvenance !== undefined && { aiProvenance: input.aiProvenance }),
    createdAt: now,
  });
  ctx.repos.media.insert(asset);
  // Waveform/probe for the timeline (module b). Audio never gets a proxy (`media.proxy` is video-only).
  // A voice-ref is never a timeline clip and media.probe would overwrite its kind with "audio".
  if (kind === "audio" && ctx.queue.hasHandler("media.probe"))
    ctx.queue.enqueue({ type: "media.probe", payload: { assetId: asset.id }, priority: 1 });
  return asset;
}

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/opus",
      flac: "audio/flac",
      m4a: "audio/mp4",
      aac: "audio/aac",
    }[ext] ?? "application/octet-stream"
  );
}
