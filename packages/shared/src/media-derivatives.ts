import { z } from "zod";
import { MediaAssetSchema } from "./media.js";

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

/**
 * MediaAsset as returned by the api (module b): extra optional derivative fields.
 * Pending contract merge into MediaAssetSchema.
 */
export const MediaAssetDetailsSchema = MediaAssetSchema.extend({
  sprite: SpriteSheetSchema.optional(),
  /** Relative to STORAGE_DIR: "proxies/<id>.peaks.json" (WaveformPeaks from dashboard.ts). */
  waveformPath: z.string().optional(),
  hasVideo: z.boolean().optional(),
  hasAudio: z.boolean().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  /** VP9/ProRes with alpha channel (motion overlays). */
  hasAlpha: z.boolean().optional(),
});
export type MediaAssetDetails = z.infer<typeof MediaAssetDetailsSchema>;
