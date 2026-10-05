import { stat } from "node:fs/promises";
import { MediaAssetSchema, type MediaAsset } from "@studio/shared";
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

export interface NewAudioAsset {
  /** Relative to STORAGE_DIR. */
  path: string;
  name: string;
  durationSec?: number;
  sampleRate?: number;
  mimeType?: string;
  id?: string;
}

/** Insert a generated/imported audio file as a MediaAsset and kick off its probe (waveform peaks). */
export async function registerAudioAsset(
  ctx: Pick<AppContext, "repos" | "config" | "queue">,
  input: NewAudioAsset,
): Promise<MediaAsset> {
  const abs = resolveStoragePath(ctx.config.storageDir, input.path);
  const info = await stat(abs);
  const now = new Date().toISOString();
  const asset = MediaAssetSchema.parse({
    id: input.id ?? nanoid(),
    kind: "audio",
    name: input.name.slice(0, 200),
    path: input.path,
    mimeType: input.mimeType ?? mimeFor(input.path),
    sizeBytes: info.size,
    ...(input.durationSec !== undefined && { durationSec: input.durationSec }),
    ...(input.sampleRate !== undefined && { sampleRate: input.sampleRate }),
    createdAt: now,
  });
  ctx.repos.media.insert(asset);
  // Waveform/probe for the timeline (module b). Audio never gets a proxy (`media.proxy` is video-only).
  if (ctx.queue.hasHandler("media.probe"))
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
