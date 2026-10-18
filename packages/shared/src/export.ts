import { z } from "zod";
import { AspectFitSchema } from "./agent.js";
import { AspectRatioSchema, IdSchema } from "./common.js";

/** Sprint 5: loudness target of a preset (EBU R128 loudnorm: LUFS, dBTP, LU). */
export const LoudnessTargetSchema = z.object({
  integrated: z.number().min(-30).max(-5),
  truePeak: z.number().min(-9).max(0),
  lra: z.number().min(1).max(20),
});
export type LoudnessTarget = z.infer<typeof LoudnessTargetSchema>;

/** −14 LUFS / −1 dBTP / LRA 11: social networks and YouTube. */
export const SOCIAL_LOUDNESS: LoudnessTarget = { integrated: -14, truePeak: -1, lra: 11 };

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
  /** Sprint 5: loudness normalization of the mix (2-pass loudnorm); null = do not normalize. */
  loudness: LoudnessTargetSchema.nullable().optional(),
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
  /**
   * Sprint 5: how to fit the canvas into a preset with another aspect. Required (409
   * ASPECT_CHOICE_REQUIRED) when the aspects differ and the project has no reframe keyframes.
   */
  aspectFit: AspectFitSchema.optional(),
  /** Sprint 5: absent = yes when the preset has `loudness`. */
  normalizeLoudness: z.boolean().optional(),
  /** Sprint 5: absent = project.audioMix.autoDuck ?? true. */
  autoDuck: z.boolean().optional(),
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
  /** Sprint 5 additions. */
  durationS: z.number().optional(),
  sizeBytes: z.number().int().optional(),
  aspectFit: AspectFitSchema.optional(),
  loudness: z
    .object({
      input_i: z.number(),
      input_tp: z.number(),
      output_i: z.number(),
      output_tp: z.number(),
    })
    .optional(),
  ducked: z.object({ voiceTracks: z.number().int(), musicTracks: z.number().int() }).optional(),
  /** Warning codes, e.g. LOUDNESS_MEASURE_FAILED (the job still succeeds). */
  warnings: z.array(z.string()).optional(),
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
    loudness: SOCIAL_LOUDNESS,
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
    loudness: SOCIAL_LOUDNESS,
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
    loudness: SOCIAL_LOUDNESS,
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
    loudness: SOCIAL_LOUDNESS,
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
    loudness: null,
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
    loudness: null,
  },
];
