import { z } from "zod";

/** Opaque string id (nanoid/uuid). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 timestamp string. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Time in seconds (float). */
export const SecondsSchema = z.number().nonnegative();

export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
