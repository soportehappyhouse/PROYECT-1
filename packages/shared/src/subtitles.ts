import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";

export const WhisperModelSchema = z.enum([
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
]);
export type WhisperModel = z.infer<typeof WhisperModelSchema>;

export const TranscribeRequestSchema = z.object({
  assetId: IdSchema,
  /** ISO-639-1 code or "auto". */
  language: z.string().default("es"),
  model: WhisperModelSchema.optional(),
  wordTimestamps: z.boolean().default(true),
  /** Whisper VAD filter (workers default: on). `false` keeps fillers like «eh»/«mmm». */
  vad: z.boolean().optional(),
});
export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export const SubtitleWordSchema = z.object({
  start: SecondsSchema,
  end: SecondsSchema,
  word: z.string(),
  probability: z.number().min(0).max(1).optional(),
});
export type SubtitleWord = z.infer<typeof SubtitleWordSchema>;

export const SubtitleSegmentSchema = z.object({
  start: SecondsSchema,
  end: SecondsSchema,
  text: z.string(),
  words: z.array(SubtitleWordSchema).optional(),
});
export type SubtitleSegment = z.infer<typeof SubtitleSegmentSchema>;

export const TranscriptSchema = z.object({
  language: z.string(),
  durationSec: SecondsSchema,
  segments: z.array(SubtitleSegmentSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Look of burned / animated subtitles (Subtitles panel); stored per project. */
export const CaptionStyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  fontFamily: z.string(),
  /** In project pixels (relative to a 1080p frame height). */
  fontSize: z.number().positive(),
  color: z.string(),
  /** Box behind the text; empty = none. */
  background: z.string(),
  /** Color of the active word for word-by-word animation. */
  highlightColor: z.string(),
  position: z.enum(["top", "center", "bottom"]),
  uppercase: z.boolean(),
  /** Animation hint for the `animated-captions` template. */
  animation: z.enum(["none", "pop", "karaoke", "fade"]),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

/**
 * Ids of the built-in caption presets: the SINGLE list (the agent's `add_captions {style}` enum in
 * agent.ts, the web Subtítulos panel and the dataset validator all read it).
 */
export const CAPTION_STYLE_IDS = ["clasico", "reels", "karaoke", "minimal", "titular"] as const;
export type CaptionStylePresetId = (typeof CAPTION_STYLE_IDS)[number];

/**
 * Built-in caption presets (the web Subtítulos panel uses these objects directly). Used by the
 * agent's `add_captions {style}`; one preset per CAPTION_STYLE_IDS entry, same order.
 */
export const CAPTION_STYLE_PRESETS: readonly (CaptionStyle & { id: CaptionStylePresetId })[] = [
  {
    id: "clasico",
    name: "Clásico",
    fontFamily: "Inter",
    fontSize: 54,
    color: "#ffffff",
    background: "rgba(0,0,0,0.6)",
    highlightColor: "#ffd60a",
    position: "bottom",
    uppercase: false,
    animation: "fade",
  },
  {
    id: "reels",
    name: "Reels (palabra a palabra)",
    fontFamily: "Inter",
    fontSize: 72,
    color: "#ffffff",
    background: "",
    highlightColor: "#22d3ee",
    position: "center",
    uppercase: true,
    animation: "pop",
  },
  {
    id: "karaoke",
    name: "Karaoke",
    fontFamily: "Inter",
    fontSize: 60,
    color: "#e5e5e5",
    background: "",
    highlightColor: "#f43f5e",
    position: "bottom",
    uppercase: false,
    animation: "karaoke",
  },
  {
    id: "minimal",
    name: "Minimal",
    fontFamily: "Georgia",
    fontSize: 44,
    color: "#ffffff",
    background: "",
    highlightColor: "#ffffff",
    position: "bottom",
    uppercase: false,
    animation: "none",
  },
  {
    id: "titular",
    name: "Titular arriba",
    fontFamily: "Inter",
    fontSize: 64,
    color: "#111111",
    background: "#ffd60a",
    highlightColor: "#111111",
    position: "top",
    uppercase: true,
    animation: "pop",
  },
];
