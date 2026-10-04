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
