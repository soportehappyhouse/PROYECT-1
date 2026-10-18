import { z } from "zod";
import { EditPlanSchema } from "./agent.js";
import { CutRangeSchema } from "./ai.js";
import { IdSchema, TimestampSchema } from "./common.js";

/**
 * Sprint 6 M3 (docs/trabajo/sprint6-contratos.md): proactive suggestions after an import. A
 * low-priority, cancellable `suggest.analyze` job (api lane `background`, workers priority 5)
 * measures silences and loudness in one FFmpeg pass; each suggestion carries a ready EditPlan the
 * user applies (never automatic). The logic lives in suggestions-rules.ts (M3).
 */

/** Sprint 6 essentials; scenes / reframe / captions are Sprint 7. */
export const SuggestionKindSchema = z.enum(["silences", "low_voice", "clipping"]);
export type SuggestionKind = z.infer<typeof SuggestionKindSchema>;

export const SuggestionStatusSchema = z.enum(["open", "applied", "dismissed", "stale"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

/** Per-asset analysis, keyed by (assetId, params_version, file_sig): never repeated. */
export const ImportAnalysisSchema = z
  .object({
    assetId: IdSchema,
    params_version: z.int().positive(),
    file_sig: z.object({ size: z.int().nonnegative(), mtime_ms: z.number() }).strict(),
    duration_s: z.number().nonnegative(),
    noise_floor_db: z.number(),
    silence_threshold_db: z.number(),
    /** Source seconds of the asset. */
    silences: z.array(CutRangeSchema).max(2000),
    lufs_i: z.number().nullable(),
    lra: z.number().nullable(),
    true_peak_db: z.number().nullable(),
    analyzed_at: TimestampSchema,
  })
  .strict();
export type ImportAnalysis = z.infer<typeof ImportAnalysisSchema>;

export const ImportSuggestionSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    assetId: IdSchema,
    clipIds: z.array(IdSchema).min(1),
    kind: SuggestionKindSchema,
    status: SuggestionStatusSchema,
    title_es: z.string().min(1).max(120),
    detail_es: z.string().max(300),
    impact: z
      .object({
        seconds_saved: z.number().nonnegative().optional(),
        count: z.int().nonnegative().optional(),
        lufs: z.number().optional(),
        target_lufs: z.number().optional(),
        gain_db: z.number().optional(),
        true_peak_db: z.number().optional(),
      })
      .strict(),
    evidence: z
      .object({ ranges: z.array(CutRangeSchema).max(200).optional() })
      .strict()
      .optional(),
    plan: EditPlanSchema,
    params_version: z.int().positive(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();
export type ImportSuggestion = z.infer<typeof ImportSuggestionSchema>;

/** Thresholds (docs/trabajo/fuentes-sprint6.md §3.1); bump params_version when they change. */
export const SUGGESTION_THRESHOLDS = {
  params_version: 1,
  silence_rel_db: 9,
  silence_db_min: -50,
  silence_db_max: -30,
  silence_min_ms: 500,
  offer_ratio: 0.08,
  offer_min_s: 5,
  offer_min_count: 3,
  low_voice_lufs: -24,
  target_lufs: -14,
  target_true_peak_db: -1,
  clipping_true_peak_db: -1,
  max_cards: 4,
  max_parallel_imports: 3,
  long_video_s: 1800,
  /** api JobQueue priority of suggest.analyze (lane `background`). */
  background_priority: -10,
} as const;

/** GET /api/projects/:id/suggestions. */
export const SuggestionsResponseSchema = z.object({
  suggestions: z.array(ImportSuggestionSchema),
  /** Assets with a suggest.analyze job queued or running. */
  analyzing: z.array(IdSchema),
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;

/** POST …/suggestions/:sid/dismiss. `muteKind` = «No sugerir más» for that kind. */
export const SuggestionDismissRequestSchema = z
  .object({ muteKind: z.boolean().default(false) })
  .strict();
export type SuggestionDismissRequest = z.infer<typeof SuggestionDismissRequestSchema>;

/** GET | PUT /api/suggestions/settings. */
export const SuggestionSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    mutedKinds: z.array(SuggestionKindSchema).default([]),
  })
  .strict();
export type SuggestionSettings = z.infer<typeof SuggestionSettingsSchema>;

/** Payload of the suggest.analyze job (also POST /api/media/:id/analyze). */
export const SuggestAnalyzePayloadSchema = z
  .object({
    assetId: IdSchema,
    projectId: IdSchema.optional(),
    force: z.boolean().default(false),
  })
  .strict();
export type SuggestAnalyzePayload = z.infer<typeof SuggestAnalyzePayloadSchema>;

/** Body of POST /api/media/:id/analyze. */
export const MediaAnalyzeRequestSchema = SuggestAnalyzePayloadSchema.omit({ assetId: true });
export type MediaAnalyzeRequest = z.infer<typeof MediaAnalyzeRequestSchema>;

/** Workers POST /analyze/suggest (area analyze of the TaskQueue) -> {task_id}. */
export const WorkerSuggestAnalyzeRequestSchema = z
  .object({
    input_path: z.string().min(1),
    job_id: z.string().optional(),
    silence_min_ms: z.int().min(100).max(10_000).default(SUGGESTION_THRESHOLDS.silence_min_ms),
    silence_rel_db: z.number().min(3).max(30).default(SUGGESTION_THRESHOLDS.silence_rel_db),
    /** TaskQueue priority (0 = user, 5 = background). */
    priority: z.int().min(0).max(9).default(5),
  })
  .strict();
export type WorkerSuggestAnalyzeRequest = z.input<typeof WorkerSuggestAnalyzeRequestSchema>;

const nullableNumber = () =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? null);

/** `result` of the suggest.analyze worker task (source seconds). */
export const WorkerSuggestAnalyzeResultSchema = z.object({
  duration_s: z.number().nonnegative(),
  noise_floor_db: z.number(),
  silence_threshold_db: z.number(),
  silences: z.array(z.tuple([z.number(), z.number()])),
  // Null on digital silence (LUFS −inf). The api client drops JSON nulls (stripNulls), so absent
  // is accepted too and normalized to null (audit S6 E5).
  lufs_i: nullableNumber(),
  lra: nullableNumber(),
  true_peak_db: nullableNumber(),
});
export type WorkerSuggestAnalyzeResult = z.infer<typeof WorkerSuggestAnalyzeResultSchema>;
