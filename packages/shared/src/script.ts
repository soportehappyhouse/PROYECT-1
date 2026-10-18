import { z } from "zod";
import { EditPlanSchema } from "./agent.js";
import { CutRangeSchema } from "./ai.js";
import { IdSchema, SecondsSchema } from "./common.js";
import { SubtitleSegmentSchema, TranscriptSchema, WhisperModelSchema } from "./subtitles.js";

/**
 * Sprint 6 M1 (docs/trabajo/sprint6-contratos.md): word-level script. The single source of word
 * timings is `project.subtitles[].words` (timeline seconds); `Script` is a computed view (never a
 * second copy of the timings). Energy envelope and acoustic gaps come from the `script.transcribe`
 * job artifact. The logic (buildScript, fillers, cuts, fitDuration, fixWords) lives in
 * script-words.ts (M1).
 */

export const FillerLevelSchema = z.enum(["safe", "probable", "doubtful"]);
export type FillerLevel = z.infer<typeof FillerLevelSchema>;

export const FillerCategorySchema = z.enum([
  "vocalization",
  "empty_connector",
  "closing_tag",
  "wildcard",
  "repetition",
  "false_start",
  "acoustic",
]);
export type FillerCategory = z.infer<typeof FillerCategorySchema>;

export const ScriptFillerSchema = z
  .object({
    category: FillerCategorySchema,
    level: FillerLevelSchema,
    confidence: z.number().min(0).max(1),
    reason_es: z.string().max(160),
  })
  .strict();
export type ScriptFiller = z.infer<typeof ScriptFillerSchema>;

/** One word of the script ("<segment>:<word>" id, timeline seconds). */
export const WordSchema = z
  .object({
    id: z.string().regex(/^\d+:\d+$/, { error: "id de palabra inválido (segmento:palabra)" }),
    text: z.string(),
    /** Lowercase, no punctuation, no accents (diff and lexicon key). */
    norm: z.string(),
    start: SecondsSchema,
    end: SecondsSchema,
    probability: z.number().min(0).max(1).optional(),
    segment: z.int().nonnegative(),
    filler: ScriptFillerSchema.optional(),
    /** Timings estimated by a text correction (not measured). */
    corrected: z.boolean().optional(),
    /** «Evitar corte brusco»: gap < 30 ms on a side or probability < 0.4. */
    harsh: z.boolean().optional(),
  })
  .strict()
  .refine((w) => w.end >= w.start, { error: "end < start", path: ["end"] });
export type Word = z.infer<typeof WordSchema>;

export const ScriptPauseSchema = z
  .object({
    kind: z.literal("pause"),
    /** Id of the word before the pause. */
    after: z.string(),
    start: SecondsSchema,
    end: SecondsSchema,
    long: z.boolean(),
  })
  .strict();
export type ScriptPause = z.infer<typeof ScriptPauseSchema>;

/** GET /api/projects/:id/script. */
export const ScriptSchema = z
  .object({
    version: z.literal(1),
    projectId: IdSchema,
    language: z.string(),
    words: z.array(WordSchema),
    pauses: z.array(ScriptPauseSchema),
    stats: z
      .object({
        words: z.int().nonnegative(),
        duration_s: z.number().nonnegative(),
        long_pauses: z.int().nonnegative(),
        fillers: z
          .object({
            safe: z.int().nonnegative(),
            probable: z.int().nonnegative(),
            doubtful: z.int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    /** Audio artifact of script.transcribe (absent: no acoustic gaps, no energy refinement). */
    audio: z.object({ jobId: IdSchema, noise_floor_db: z.number() }).strict().optional(),
    /** The subtitles no longer match the timeline. */
    stale: z.boolean().default(false),
  })
  .strict();
export type Script = z.infer<typeof ScriptSchema>;

/** Tunables of the script editor (docs/trabajo/fuentes-sprint6.md §1.3–§1.6). */
export const SCRIPT_RULES = {
  pause_long_ms: 600,
  pause_target_ms: 250,
  natural_pause_max_ms: 400,
  cut_pad_max_ms: 60,
  energy_search_ms: 60,
  energy_window_ms: 5,
  min_cut_ms: 40,
  join_fade_ms: 12,
  join_fade_max_ms: 15,
  harsh_gap_ms: 30,
  harsh_probability: 0.4,
  acoustic_min_ms: 250,
  acoustic_db_over_floor: 10,
  sentence_pause_ms: 700,
  paragraph_pause_ms: 1500,
  corrected_min_word_ms: 80,
  insert_max_gap_ratio: 0.6,
  fit_tolerance_s: 0.5,
  fit_max_speed: 1.1,
  fit_min_confidence: 0.6,
} as const;

export interface FillerLexiconEntry {
  /** Normalized form (see WordSchema.norm); multi-word entries separated by a space. */
  text: string;
  category: FillerCategory;
  level: FillerLevel;
  /** Only a filler with a pause ≥ 120 ms before/after (or at the start of a sentence). */
  needs_pause?: boolean;
  reason_es: string;
}

/** Base Rioplatense lexicon (contextual rules for «este», «tipo», «nada», «viste» are M1's). */
export const FILLER_LEXICON_ES: readonly FillerLexiconEntry[] = [
  { text: "eh", category: "vocalization", level: "safe", reason_es: "Vocalización" },
  { text: "ehh", category: "vocalization", level: "safe", reason_es: "Vocalización" },
  { text: "em", category: "vocalization", level: "safe", reason_es: "Vocalización" },
  { text: "mm", category: "vocalization", level: "safe", reason_es: "Vocalización" },
  { text: "mmm", category: "vocalization", level: "safe", reason_es: "Vocalización" },
  {
    text: "ah",
    category: "vocalization",
    level: "probable",
    reason_es: "«Ah» (puede ser una respuesta)",
  },
  { text: "o sea", category: "empty_connector", level: "probable", reason_es: "Conector vacío" },
  { text: "digamos", category: "empty_connector", level: "probable", reason_es: "Conector vacío" },
  {
    text: "este",
    category: "empty_connector",
    level: "probable",
    needs_pause: true,
    reason_es: "«Este» de relleno (con pausa)",
  },
  {
    text: "bueno",
    category: "empty_connector",
    level: "probable",
    needs_pause: true,
    reason_es: "«Bueno» al arrancar la frase",
  },
  { text: "no", category: "closing_tag", level: "doubtful", reason_es: "Apoyo de cierre «¿no?»" },
  { text: "viste", category: "closing_tag", level: "doubtful", reason_es: "Apoyo de cierre" },
  { text: "entendes", category: "closing_tag", level: "doubtful", reason_es: "Apoyo de cierre" },
  { text: "si", category: "closing_tag", level: "doubtful", reason_es: "Apoyo de cierre «¿sí?»" },
  { text: "tipo", category: "wildcard", level: "doubtful", reason_es: "Comodín" },
  { text: "nada", category: "wildcard", level: "doubtful", reason_es: "Comodín al inicio" },
  { text: "literal", category: "wildcard", level: "doubtful", reason_es: "Comodín" },
  { text: "basicamente", category: "wildcard", level: "doubtful", reason_es: "Comodín" },
  { text: "mira", category: "wildcard", level: "doubtful", reason_es: "Comodín" },
  { text: "dale", category: "wildcard", level: "doubtful", reason_es: "Comodín" },
];

/** POST /api/projects/:id/script/transcribe -> 202 JobAccepted (job script.transcribe). */
export const ScriptTranscribeRequestSchema = z
  .object({
    clipId: IdSchema,
    model: WhisperModelSchema.optional(),
    language: z.string().default("es"),
    /** Keep «eh/em» (no VAD); the default for the script. */
    keepFillers: z.boolean().default(true),
  })
  .strict();
export type ScriptTranscribeRequest = z.infer<typeof ScriptTranscribeRequestSchema>;

/** POST /api/projects/:id/script/cuts: computes (does not apply) the cuts of a selection. */
export const ScriptCutsRequestSchema = z
  .object({
    wordIds: z.array(z.string()).max(2000).optional(),
    /** Timeline seconds. */
    ranges: z.array(CutRangeSchema).max(500).optional(),
    fillers: z.union([FillerLevelSchema, z.literal("all")]).optional(),
    shortenLongPauses: z.boolean().optional(),
    avoidHarsh: z.boolean().default(true),
  })
  .strict()
  .refine(
    (r) =>
      (r.wordIds?.length ?? 0) > 0 ||
      (r.ranges?.length ?? 0) > 0 ||
      r.fillers !== undefined ||
      r.shortenLongPauses === true,
    { error: "Elegí palabras, tramos, muletillas o pausas para cortar.", path: ["wordIds"] },
  );
export type ScriptCutsRequest = z.infer<typeof ScriptCutsRequestSchema>;

export const ScriptCutReasonSchema = z.enum(["words", "filler", "pause", "sentence"]);
export type ScriptCutReason = z.infer<typeof ScriptCutReasonSchema>;

export const ScriptCutSchema = z
  .object({
    /** Timeline seconds. */
    start: SecondsSchema,
    end: SecondsSchema,
    fade_ms: z.int().min(0).max(30),
    reason: ScriptCutReasonSchema,
  })
  .strict();
export type ScriptCut = z.infer<typeof ScriptCutSchema>;

export const ScriptCutsResponseSchema = z.object({
  cuts: z.array(ScriptCutSchema),
  removed_s: z.number().nonnegative(),
  skipped: z.array(z.object({ wordId: z.string(), reason_es: z.string() })),
});
export type ScriptCutsResponse = z.infer<typeof ScriptCutsResponseSchema>;

export const FitLevelSchema = z.enum([
  "pauses",
  "fillers_safe",
  "fillers_other",
  "sentences",
  "speed",
]);
export type FitLevel = z.infer<typeof FitLevelSchema>;

/** POST /api/projects/:id/script/fit -> FitDurationPreview («dejalo en 45 s»). */
export const FitDurationRequestSchema = z
  .object({
    target_s: z.number().min(3).max(3600),
    tolerance_s: z.number().min(0).max(5).default(0.5),
    allow_speedup: z.boolean().default(false),
    max_speed: z.number().min(1).max(1.25).default(1.1),
    allow_sentences: z.boolean().default(false),
  })
  .strict();
export type FitDurationRequest = z.infer<typeof FitDurationRequestSchema>;

export const FitDurationPreviewSchema = z.object({
  from_s: z.number().nonnegative(),
  to_s: z.number().nonnegative(),
  reached: z.boolean(),
  groups: z.array(
    z.object({
      level: FitLevelSchema,
      removed_s: z.number().nonnegative(),
      count: z.int().nonnegative(),
      label_es: z.string(),
    }),
  ),
  cuts: z.array(ScriptCutSchema),
  speed: z.number().min(1).max(1.25).optional(),
  question_es: z.string().optional(),
  /** Ready for the Assistant / studio_validate_plan. */
  plan: EditPlanSchema.optional(),
});
export type FitDurationPreview = z.infer<typeof FitDurationPreviewSchema>;

/** Workers POST /transcribe/words (area transcribe of the TaskQueue) -> {task_id}. */
export const WorkerSttWordsRequestSchema = z
  .object({
    input_path: z.string().min(1),
    language: z.string().default("es"),
    model: z.string().optional(),
    job_id: z.string().optional(),
    clip_in_s: SecondsSchema.optional(),
    clip_out_s: SecondsSchema.optional(),
    /** "renders/<jobId>": transcript.json + script-audio.json + script-rms.f32. */
    output_base: z.string().min(1),
    hallucination_silence_threshold: z.number().positive().default(2),
  })
  .strict();
export type WorkerSttWordsRequest = z.input<typeof WorkerSttWordsRequestSchema>;

export const ScriptAudioGapSchema = z
  .object({ start: SecondsSchema, end: SecondsSchema, rms_db: z.number(), voiced: z.boolean() })
  .strict();
export type ScriptAudioGap = z.infer<typeof ScriptAudioGapSchema>;

export const ScriptAudioSchema = z
  .object({
    noise_floor_db: z.number(),
    window_ms: z.literal(5),
    /** Float32 LE RMS in dB, one value every 5 ms (STORAGE_DIR-relative). */
    rms_db_path: z.string(),
    gaps: z.array(ScriptAudioGapSchema),
  })
  .strict();
export type ScriptAudio = z.infer<typeof ScriptAudioSchema>;

/** `result` of the stt.words worker task. */
export const WorkerSttWordsResultSchema = z.object({
  transcript: TranscriptSchema,
  audio: ScriptAudioSchema,
});
export type WorkerSttWordsResult = z.infer<typeof WorkerSttWordsResultSchema>;

/**
 * Result of the `script.transcribe` job (integration S6: one definition for api and web). The web
 * applies `segments` to the span `range` in one undo step.
 */
export const ScriptTranscribeResultSchema = z.object({
  projectId: IdSchema,
  clipId: IdSchema,
  assetId: IdSchema,
  /** Timeline span whose subtitles were replaced. */
  range: z.object({ start: z.number(), end: z.number() }),
  /** New subtitles of that span (timeline seconds, with words). */
  segments: z.array(SubtitleSegmentSchema),
  words: z.int().nonnegative(),
  noise_floor_db: z.number(),
  gaps: z.int().nonnegative(),
  voiced_gaps: z.int().nonnegative(),
  audioPath: z.string(),
  warnings: z.array(z.string()).optional(),
});
export type ScriptTranscribeResult = z.infer<typeof ScriptTranscribeResultSchema>;
