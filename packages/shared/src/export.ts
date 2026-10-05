import { z } from "zod";
import { AspectRatioSchema, IdSchema } from "./common.js";

export const ExportPresetSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  aspect: AspectRatioSchema,
  container: z.enum(["mp4", "webm", "mov", "gif"]).default("mp4"),
  videoCodec: z.enum(["h264", "h265", "vp9", "prores", "gif"]).default("h264"),
  audioCodec: z.enum(["aac", "opus", "pcm"]).default("aac"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  /** Constant rate factor (quality). Ignored when videoBitrateKbps is set. */
  crf: z.number().int().min(0).max(51).optional(),
  videoBitrateKbps: z.number().int().positive().optional(),
  audioBitrateKbps: z.number().int().positive().default(192),
  /** Built-in presets can be duplicated but not deleted. */
  builtIn: z.boolean().default(false),
  /** Keep transparency (WebM VP9 yuva420p / ProRes 4444); empty timeline areas stay transparent. */
  alpha: z.boolean().default(false),
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;
export type ExportPresetInput = z.input<typeof ExportPresetSchema>;

export const ExportRequestSchema = z.object({
  presetId: IdSchema,
  /** Optional range in seconds; default = whole timeline. */
  range: z.object({ start: z.number().min(0), end: z.number().positive() }).optional(),
  fileName: z.string().optional(),
  /**
   * Burn `project.subtitles` into the video. Absent = defaultBurnSubtitles(project): true unless the
   * timeline has an `animated-captions` motion clip.
   */
  burnSubtitles: z.boolean().optional(),
  /**
   * Segment cache render (Sprint 1): absent = true. Falls back to the single-pass render when the
   * preset or the timeline cannot be split safely (see docs/ARQUITECTURA.md §5.1).
   */
  useSegmentCache: z.boolean().optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/** Segment statistics of a project.export run with the segment cache. */
export const ExportSegmentStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  rendered: z.number().int().nonnegative(),
});
export type ExportSegmentStats = z.infer<typeof ExportSegmentStatsSchema>;

/** Result of project.export (FileJobResult + how it was rendered). */
export const ExportJobResultSchema = z.object({
  assetId: IdSchema.optional(),
  /** Relative to STORAGE_DIR. */
  path: z.string(),
  mode: z.enum(["segments", "single"]).optional(),
  segments: ExportSegmentStatsSchema.optional(),
  /** Why the segment cache was not used (Spanish), when it was requested. */
  fallbackReason: z.string().optional(),
});
export type ExportJobResult = z.infer<typeof ExportJobResultSchema>;

export const DEFAULT_EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: "youtube-1080p",
    name: "YouTube 1080p (16:9)",
    aspect: "16:9",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 20,
    audioBitrateKbps: 192,
    builtIn: true,
    alpha: false,
  },
  {
    id: "youtube-4k",
    name: "YouTube 4K (16:9)",
    aspect: "16:9",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 3840,
    height: 2160,
    fps: 30,
    crf: 18,
    audioBitrateKbps: 192,
    builtIn: true,
    alpha: false,
  },
  {
    id: "reels-tiktok",
    name: "Reels / TikTok (9:16)",
    aspect: "9:16",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 21,
    audioBitrateKbps: 160,
    builtIn: true,
    alpha: false,
  },
  {
    id: "youtube-shorts",
    name: "YouTube Shorts (9:16)",
    aspect: "9:16",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1080,
    height: 1920,
    fps: 60,
    crf: 20,
    audioBitrateKbps: 192,
    builtIn: true,
    alpha: false,
  },
];

/** Built-in presets beyond DEFAULT_EXPORT_PRESETS (GIF + alpha; seeded by the api). */
export const EXTRA_EXPORT_PRESETS: readonly ExportPreset[] = [
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
