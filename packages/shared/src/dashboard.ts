import { z } from "zod";

/**
 * Pre-computed waveform peaks for an audio/video asset, written by the `media.proxy` job next to the
 * proxy (`proxies/<assetId>.peaks.json`, served by GET /files/*). Mono, max-abs per bucket, 0..1.
 */
export const WaveformPeaksSchema = z.object({
  version: z.literal(1),
  durationSec: z.number().nonnegative(),
  /** Number of buckets per second of audio. */
  bucketsPerSecond: z.number().positive(),
  peaks: z.array(z.number().min(0).max(1)),
});
export type WaveformPeaks = z.infer<typeof WaveformPeaksSchema>;

/** Relative (to STORAGE_DIR) path of the peaks JSON of an asset. */
export function waveformPeaksPath(assetId: string): string {
  return `proxies/${assetId}.peaks.json`;
}
