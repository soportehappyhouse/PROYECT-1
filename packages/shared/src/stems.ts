import { z } from "zod";
import { IdSchema } from "./common.js";
import type { Project } from "./timeline.js";

/**
 * Sprint 3b (docs/trabajo/sprint3b-contratos.md §C): audio source separation ("stems") with Demucs
 * htdemucs in the workers (pack `stems`). Job `audio.stems`: new audio assets and, with a target
 * project, new tracks («Voz» + «Música», or 4) aligned to the source clip, whose audio is muted
 * (clip.volume = 0). The project before the edit is kept as an undo snapshot (agent snapshots):
 * «Deshacer separación» = POST STEMS_API_ROUTES.undo.
 */

export const STEMS_JOB_TYPE = "audio.stems" as const;
export const STEMS_PACK_ID = "stems" as const;

export const STEMS_API_ROUTES = {
  stems: "/api/audio/stems", // POST StemsRequest -> JobAccepted (job audio.stems)
  undo: "/api/audio/stems/undo", // POST StemsUndoRequest -> StemsUndoResponse
} as const;

/** Workers (Python) routes; the task has the VisionTask shape {status, progress, result}. */
export const WORKER_STEMS_ROUTES = {
  stems: "/audio/stems", // POST {path, mode, output_base} -> {task_id}
  task: "/audio/tasks/:id", // GET task -> result WorkerStemsResult
} as const;

export const StemsModeSchema = z.enum(["two", "four"]);
export type StemsMode = z.infer<typeof StemsModeSchema>;

export const StemNameSchema = z.enum(["vocals", "no_vocals", "drums", "bass", "other"]);
export type StemName = z.infer<typeof StemNameSchema>;

/** Stems per mode, in track order (two = `demucs --two-stems=vocals`). */
export const STEM_NAMES: Record<StemsMode, readonly StemName[]> = {
  two: ["vocals", "no_vocals"],
  four: ["vocals", "drums", "bass", "other"],
};

/** Track / asset names (Spanish). */
export const STEM_LABELS_ES: Record<StemName, string> = {
  vocals: "Voz",
  no_vocals: "Música",
  drums: "Batería",
  bass: "Bajo",
  other: "Otros",
};

export const STEMS_MODE_LABELS_ES: Record<StemsMode, string> = {
  two: "2 pistas: voz y música",
  four: "4 pistas: voz, batería, bajo y otros",
};

/** Output sample rate of htdemucs (WAV 16-bit stereo). */
export const STEMS_SAMPLE_RATE = 44_100;

/**
 * POST /api/audio/stems. `clipId` (with `target.projectId`) separates the clip's asset and places
 * the stems under it; `assetId` alone only creates assets (with a target: stems at 0 s, full length).
 */
export const StemsRequestSchema = z
  .object({
    assetId: IdSchema.optional(),
    clipId: IdSchema.optional(),
    mode: StemsModeSchema.default("two"),
    target: z.object({ projectId: IdSchema }).optional(),
  })
  .refine((r) => r.assetId !== undefined || r.clipId !== undefined, {
    message: "Indicá assetId o clipId",
  })
  .refine((r) => r.clipId === undefined || r.target !== undefined, {
    message: "clipId necesita target.projectId",
    path: ["target"],
  });
export type StemsRequest = z.infer<typeof StemsRequestSchema>;
export type StemsRequestInput = z.input<typeof StemsRequestSchema>;

export const WorkerStemsRequestSchema = z.object({
  path: z.string().min(1),
  mode: StemsModeSchema,
  output_base: z.string().min(1),
});
export type WorkerStemsRequest = z.infer<typeof WorkerStemsRequestSchema>;

export const WorkerStemsResultSchema = z.object({
  stems: z.record(z.string(), z.string()),
  sample_rate: z.number().int().positive().default(STEMS_SAMPLE_RATE),
  device: z.string().default("cpu"),
  segment: z.number().positive().nullish(),
  chunks: z.number().int().nonnegative().nullish(),
  duration_s: z.number().nonnegative().nullish(),
  warnings: z.array(z.string()).nullish(),
});
export type WorkerStemsResult = z.infer<typeof WorkerStemsResultSchema>;

export const StemOutputSchema = z.object({
  name: StemNameSchema,
  label: z.string(),
  assetId: IdSchema,
  /** Relative to STORAGE_DIR. */
  path: z.string(),
  trackId: IdSchema.optional(),
  clipId: IdSchema.optional(),
});
export type StemOutput = z.infer<typeof StemOutputSchema>;

export const StemsResultSchema = z.object({
  mode: StemsModeSchema,
  sourceAssetId: IdSchema,
  stems: z.array(StemOutputSchema),
  sampleRate: z.number().int().positive(),
  device: z.string(),
  warnings: z.array(z.string()).optional(),
  projectId: IdSchema.optional(),
  sourceClipId: IdSchema.optional(),
  /** Volume the source clip had before it was muted (restored by the undo). */
  previousVolume: z.number().optional(),
  /** Project before the edit (agent snapshots): POST STEMS_API_ROUTES.undo. */
  undoSnapshotId: z.string().optional(),
  /** Content hash after the edit: the undo asks for `force` when the project changed since. */
  postEditHash: z.string().optional(),
});
export type StemsResult = z.infer<typeof StemsResultSchema>;

export const StemsUndoRequestSchema = z.object({
  undoSnapshotId: z.string().min(1),
  /** Restore even when the project was edited after the separation (those edits are lost). */
  force: z.boolean().optional(),
});
export type StemsUndoRequest = z.infer<typeof StemsUndoRequestSchema>;

/** Answer of the undo: the restored (saved) project. */
export interface StemsUndoResponse {
  project: Project;
}

/** Track names of a separation: «Voz» + «Música» (two) or the four instruments. */
export function stemTrackNames(mode: StemsMode): string[] {
  return STEM_NAMES[mode].map((s) => STEM_LABELS_ES[s]);
}
