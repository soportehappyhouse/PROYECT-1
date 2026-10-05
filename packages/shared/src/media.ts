import { z } from "zod";
import { IdSchema, SecondsSchema, TimestampSchema } from "./common.js";

export const MediaKindSchema = z.enum(["video", "audio", "image", "subtitle", "lottie"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** Sprite sheet for timeline scrubbing (tiles left-to-right, top-to-bottom). */
export const SpriteSheetSchema = z.object({
  /** Relative to STORAGE_DIR, e.g. "proxies/abc.sprite.jpg". */
  path: z.string(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  /** Seconds between tiles. */
  intervalSec: z.number().positive(),
  count: z.number().int().positive(),
});
export type SpriteSheet = z.infer<typeof SpriteSheetSchema>;

/** An imported file living under storage/media (or generated under storage/renders). */
export const MediaAssetSchema = z.object({
  id: IdSchema,
  kind: MediaKindSchema,
  name: z.string(),
  /** Path relative to STORAGE_DIR, e.g. "media/abc123.mp4". */
  path: z.string(),
  /** Editing proxy relative to STORAGE_DIR, e.g. "proxies/abc123.mp4". */
  proxyPath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  durationSec: SecondsSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  /** Derivatives written by media.probe. */
  sprite: SpriteSheetSchema.optional(),
  /** Relative to STORAGE_DIR: "proxies/<id>.peaks.json" (WaveformPeaks from dashboard.ts). */
  waveformPath: z.string().optional(),
  hasVideo: z.boolean().optional(),
  hasAudio: z.boolean().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  /** VP9/ProRes with alpha channel (motion overlays). */
  hasAlpha: z.boolean().optional(),
  createdAt: TimestampSchema,
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
