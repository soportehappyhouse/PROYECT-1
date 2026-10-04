import { z } from "zod";
import { AspectRatioSchema, IdSchema } from "./common.js";

export const ExportPresetSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  aspect: AspectRatioSchema,
  container: z.enum(["mp4", "webm", "mov"]).default("mp4"),
  videoCodec: z.enum(["h264", "h265", "vp9", "prores"]).default("h264"),
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
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;
export type ExportPresetInput = z.input<typeof ExportPresetSchema>;

export const ExportRequestSchema = z.object({
  presetId: IdSchema,
  /** Optional range in seconds; default = whole timeline. */
  range: z.object({ start: z.number().min(0), end: z.number().positive() }).optional(),
  fileName: z.string().optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

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
  },
];
