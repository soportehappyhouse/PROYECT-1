import { z } from "zod";
import { ExportPresetSchema, type ExportPreset } from "./export.js";

/**
 * Additive extension of ExportPreset (module b): GIF output and alpha-channel exports.
 * Pending contract merge: `container` += "gif", `videoCodec` += "gif", new `alpha` flag.
 */
export const ExportPresetExtSchema = ExportPresetSchema.extend({
  container: z.enum(["mp4", "webm", "mov", "gif"]).default("mp4"),
  videoCodec: z.enum(["h264", "h265", "vp9", "prores", "gif"]).default("h264"),
  /** Keep transparency (WebM VP9 yuva420p / ProRes 4444); empty timeline areas stay transparent. */
  alpha: z.boolean().default(false),
});
export type ExportPresetExt = z.infer<typeof ExportPresetExtSchema>;
export type ExportPresetExtInput = z.input<typeof ExportPresetExtSchema>;

/** Built-in presets beyond DEFAULT_EXPORT_PRESETS (seeded by the api). */
export const EXTRA_EXPORT_PRESETS: readonly ExportPresetExt[] = [
  {
    id: "gif-480",
    name: "GIF 480p",
    aspect: "16:9",
    container: "gif",
    videoCodec: "gif",
    audioCodec: "aac",
    width: 480,
    height: 270,
    fps: 12,
    audioBitrateKbps: 128,
    builtIn: true,
    alpha: false,
  },
  {
    id: "webm-alpha",
    name: "WebM con transparencia (VP9)",
    aspect: "16:9",
    container: "webm",
    videoCodec: "vp9",
    audioCodec: "opus",
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 30,
    audioBitrateKbps: 160,
    builtIn: true,
    alpha: true,
  },
];

/** Widen a contract ExportPreset to the extended shape. */
export function toExportPresetExt(preset: ExportPreset | ExportPresetExt): ExportPresetExt {
  return ExportPresetExtSchema.parse(preset);
}
