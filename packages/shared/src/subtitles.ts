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
