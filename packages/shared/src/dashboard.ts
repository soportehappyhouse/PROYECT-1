import { z } from "zod";
import { TimestampSchema } from "./common.js";
import { DashboardSettingsSchema } from "./settings.js";

/**
 * Additive extension of `DashboardSettings` used by the dashboard (module a).
 * The web sends `DashboardSettingsWithUi` to PUT /api/settings; the api should persist the whole
 * JSON (including `ui`) so layout, accent, density and layout presets survive a browser reset.
 */
export const UiDensitySchema = z.enum(["compact", "comfortable", "spacious"]);
export type UiDensity = z.infer<typeof UiDensitySchema>;

/** A named, user-saved dockview layout (`api.toJSON()` output, opaque to the server). */
export const LayoutPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layout: z.unknown(),
  createdAt: TimestampSchema,
});
export type LayoutPreset = z.infer<typeof LayoutPresetSchema>;

export const DashboardUiPrefsSchema = z.object({
  /** CSS color used as the accent (primary) color. */
  accent: z.string().min(1),
  density: UiDensitySchema,
  /** Current dockview layout (`SerializedDockview`), opaque to the server. */
  layout: z.unknown().optional(),
  layoutPresets: z.array(LayoutPresetSchema).default([]),
  /** Last local modification; the newest copy (browser vs api) wins on load. */
  updatedAt: TimestampSchema.optional(),
});
export type DashboardUiPrefs = z.infer<typeof DashboardUiPrefsSchema>;

export const DashboardSettingsWithUiSchema = DashboardSettingsSchema.extend({
  ui: DashboardUiPrefsSchema.optional(),
});
export type DashboardSettingsWithUi = z.infer<typeof DashboardSettingsWithUiSchema>;

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
