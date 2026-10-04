import { z } from "zod";
import { IdSchema, SecondsSchema, TimestampSchema } from "./common.js";

export const MediaKindSchema = z.enum(["video", "audio", "image", "subtitle", "lottie"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

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
  createdAt: TimestampSchema,
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
