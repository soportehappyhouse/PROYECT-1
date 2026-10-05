import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";
import { ExportRequestSchema } from "./export.js";

/** Schemas for routes owned by module b (autosave, encoders) and its job payloads. */

export const ProjectAutosaveInfoSchema = z.object({
  projectId: IdSchema,
  savedAt: TimestampSchema,
});
export type ProjectAutosaveInfo = z.infer<typeof ProjectAutosaveInfoSchema>;

export const VideoEncoderIdSchema = z.enum(["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
export type VideoEncoderId = z.infer<typeof VideoEncoderIdSchema>;

export const EncoderInfoSchema = z.object({
  /** Usable H.264 encoders in preference order (libx264 always last). */
  available: z.array(VideoEncoderIdSchema),
  preferred: VideoEncoderIdSchema,
  ffmpegVersion: z.string().optional(),
  detectedAt: TimestampSchema,
});
export type EncoderInfo = z.infer<typeof EncoderInfoSchema>;

/** Job payloads owned by module b. */
export const MediaJobPayloadSchema = z.object({ assetId: IdSchema });
export type MediaJobPayload = z.infer<typeof MediaJobPayloadSchema>;

export const ExportJobPayloadSchema = ExportRequestSchema.extend({ projectId: IdSchema });
export type ExportJobPayload = z.infer<typeof ExportJobPayloadSchema>;
