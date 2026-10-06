import { z } from "zod";
import {
  AnchorSchema,
  CaptionStyleIdSchema,
  PresetIdSchema,
  TemplateIdSchema,
  validateEditPlan,
  type AgentPlanRecord,
  type EditOp,
  type EditOpInput,
  type EditPlan,
} from "./agent.js";
import type { Project } from "./timeline.js";

/**
 * Sprint 3b «Perfil de estilo» (docs/trabajo/sprint3b-contratos.md, section B). The workers analyze
 * a reference video (`StyleAnalysis`: cuts, motion, audio, on-screen text, contact sheet); a local
 * vision LLM (Ollama qwen2.5vl:3b, pack `vision-llm`) or Claude in the console turns it into a
 * `StylePreset`; `compileStylePreset` turns a preset into an `EditPlan` for the Assistant
 * (deterministic: no LLM). SINGLE SOURCE: the workers give Ollama the JSON Schema exported by
 * `pnpm --filter @studio/shared export-schemas` (apps/workers/studio_workers/style/
 * stylepreset.schema.json). Field names keep the snake_case of the Python contract.
 */

// ---------- StyleAnalysis (written by the workers) ----------

export const STYLE_CANVASES = ["16:9", "9:16", "1:1"] as const;
export const StyleCanvasSchema = z
  .enum(STYLE_CANVASES)
  .describe("Lienzo: 16:9 (horizontal), 9:16 (vertical, Reels/TikTok) o 1:1 (cuadrado).");
export type StyleCanvas = z.infer<typeof StyleCanvasSchema>;

export const StyleZoomEventSchema = z.object({
  t: z.number().nonnegative(),
  kind: z.enum(["zoom_in", "zoom_out", "punch_in"]),
  /** >1 = closer (zoom in / punch-in), <1 = wider. */
  scale: z.number().positive(),
});
export type StyleZoomEvent = z.infer<typeof StyleZoomEventSchema>;

export const StyleAnalysisSchema = z
  .object({
    version: z.literal(1).default(1),
    source_path: z.string().optional(),
    /** api asset id of the reference video (set by the api). */
    source_asset_id: z.string().optional(),
    duration_s: z.number().nonnegative(),
    fps: z.number().nonnegative(),
    canvas: z.object({ w: z.int().positive(), h: z.int().positive(), aspect: z.string() }),
    scenes: z.array(z.object({ start: z.number(), end: z.number() })),
    /** "scenedetect" (pack scenes) or "ffmpeg" (select scene-change fallback). */
    scenes_method: z.string().optional(),
    shot_stats: z.object({
      count: z.int().nonnegative(),
      mean_s: z.number().nonnegative(),
      median_s: z.number().nonnegative(),
      cuts_per_min: z.number().nonnegative(),
      /** Shot length buckets: shots with length < max_s (the last bucket has max_s = null). */
      histogram: z.array(z.object({ max_s: z.number().nullable(), count: z.int().nonnegative() })),
    }),
    motion: z.object({
      zoom_events: z.array(StyleZoomEventSchema),
      pan_estimate: z.object({
        /** Share of sampled frame pairs (inside a shot) with a camera shift. */
        moving_ratio: z.number().min(0).max(1),
        /** Mean shift in frame widths per second. */
        mean_speed: z.number().nonnegative(),
        level: z.enum(["static", "low", "high"]),
      }),
      method: z.string().optional(),
    }),
    audio: z.object({
      has_audio: z.boolean(),
      loudness_lufs: z.number().nullable(),
      speech_ratio: z.number().min(0).max(1).nullable(),
      music_detected: z.boolean().nullable(),
      silence_ratio: z.number().min(0).max(1).nullable(),
      speech_method: z.string().nullish(), // null without an audio stream
      music_method: z.string().nullish(),
    }),
    text_on_screen: z
      .array(
        z.object({
          t: z.number().nonnegative(),
          text: z.string(),
          /** [x, y, w, h] as fractions of the frame. */
          bbox: z.array(z.number()).length(4),
          score: z.number().optional(),
        }),
      )
      .optional(),
    transcript_excerpt: z.string().optional(),
    /** Relative to STORAGE_DIR (served by /files). */
    contact_sheet_path: z.string(),
    contact_sheet: z
      .object({
        columns: z.int().positive(),
        rows: z.int().positive(),
        width: z.int().positive(),
        height: z.int().positive(),
        times: z.array(z.number()),
        timestamps: z.boolean().optional(),
      })
      .optional(),
    thumbnails: z.array(z.string()),
    thumbnail_times: z.array(z.number()).optional(),
    warnings: z.array(z.string()).default([]),
    elapsed_s: z.number().optional(),
  })
  .loose();
export type StyleAnalysis = z.infer<typeof StyleAnalysisSchema>;

// ---------- StylePreset ----------

/** Same types as Clip.transitionIn/Out (timeline.ts) plus "cut" (no transition). */
export const STYLE_TRANSITION_TYPES = [
  "cut",
  "fade",
  "crossfade",
  "wipe",
  "slide",
  "zoom",
] as const;

const ParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const StyleTitleParamsSchema = z
  .object({
    title: z.string().max(200).optional().describe("Texto del título."),
    subtitle: z.string().max(200).optional().describe("Subtítulo opcional."),
    style: z
      .string()
      .optional()
      .describe("Animación del título: fade-up, pop, slide, typewriter o boxed."),
    accentColor: z.string().optional().describe("Color de acento (#rrggbb)."),
  })
  .catchall(ParamValueSchema)
  .describe("Parámetros de la plantilla del título.");

export const StyleLowerThirdParamsSchema = z
  .object({
    name: z.string().max(120).optional().describe("Nombre que muestra el rótulo."),
    role: z.string().max(120).optional().describe("Cargo o descripción."),
    style: z.string().optional().describe("Estilo del rótulo (p. ej. bar)."),
    position: z.string().optional().describe("bottom-left, bottom-right, top-left o top-right."),
    accentColor: z.string().optional().describe("Color de acento (#rrggbb)."),
  })
  .catchall(ParamValueSchema)
  .describe("Parámetros del rótulo (lower third).");

const presetFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Nombre corto del estilo (p. ej. «Reels dinámico»)."),
  canvas: StyleCanvasSchema,
  cut_rhythm: z
    .object({
      target_shot_s: z
        .number()
        .min(0.3)
        .max(120)
        .describe("Duración típica de cada plano, en segundos (mediana de la referencia)."),
      remove_silences: z.boolean().describe("Cortar los silencios de la voz."),
      min_silence_ms: z
        .int()
        .min(100)
        .max(10_000)
        .describe("Silencio mínimo a cortar, en milisegundos (300 = ritmo rápido, 700 = calmo)."),
    })
    .strict()
    .describe("Ritmo de cortes."),
  captions: z
    .object({
      enabled: z.boolean().optional().describe("La referencia tiene subtítulos (por defecto sí)."),
      style: CaptionStyleIdSchema,
      animated: z.boolean().describe("Subtítulos animados palabra a palabra."),
      position: AnchorSchema,
    })
    .strict()
    .describe("Subtítulos."),
  titles: z
    .object({
      enabled: z.boolean().optional().describe("Poner un título al inicio (por defecto sí)."),
      template: TemplateIdSchema,
      params: StyleTitleParamsSchema.optional(),
      duration_s: z.number().positive().max(30).optional().describe("Duración del título (s)."),
    })
    .strict()
    .describe("Título de apertura."),
  lower_third: z
    .object({
      enabled: z.boolean().optional().describe("Mostrar un rótulo con nombre (por defecto sí)."),
      params: StyleLowerThirdParamsSchema.optional(),
      duration_s: z.number().positive().max(30).optional().describe("Duración del rótulo (s)."),
    })
    .strict()
    .optional()
    .describe("Rótulo con nombre y cargo (lower third), si la referencia lo usa."),
  transitions: z
    .object({
      type: z
        .enum(STYLE_TRANSITION_TYPES)
        .describe("Transición entre planos: cut (corte seco), fade, crossfade, wipe, slide, zoom."),
      every_n_cuts: z
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Cada cuántos cortes hay una transición (1 = en todos)."),
    })
    .strict()
    .describe("Transiciones."),
  music: z
    .object({
      duck: z.boolean().describe("Bajar la música cuando hay voz."),
      volume_db: z
        .number()
        .min(-60)
        .max(12)
        .describe("Volumen de la música en dB (-12 = de fondo, -60 = sin música)."),
    })
    .strict()
    .describe("Música."),
  zoom_punch_in: z
    .object({
      every_s: z.number().min(0.5).max(120).describe("Cada cuántos segundos hay un zoom."),
      scale: z.number().min(1.01).max(2).describe("Cuánto acerca (1.15 = 15 %)."),
    })
    .strict()
    .optional()
    .describe("Zoom de golpe (punch-in) periódico, si la referencia lo usa."),
  ai_label: z
    .boolean()
    .optional()
    .describe("Quemar la etiqueta «Contenido alterado con IA» al exportar."),
  export_preset: PresetIdSchema,
  notes_es: z
    .string()
    .max(1000)
    .describe("Qué observaste en la referencia, en 1-3 frases en español rioplatense."),
};

/** What the vision LLM / Claude produce (no id): the JSON Schema given to Ollama `format`. */
export const StylePresetDraftSchema = z
  .object(presetFields)
  .strict()
  .describe("Perfil de estilo deducido de un video de referencia.");
export type StylePresetDraft = z.infer<typeof StylePresetDraftSchema>;
export type StylePresetDraftInput = z.input<typeof StylePresetDraftSchema>;

export const StylePresetSourceSchema = z
  .object({
    assetId: z.string().optional(),
    analysisId: z.string().optional(),
    analysis_path: z.string().optional(),
    /** Who deduced it. */
    via: z.enum(["manual", "local-llm", "claude"]).optional(),
  })
  .strict();
export type StylePresetSource = z.infer<typeof StylePresetSourceSchema>;

/** Stored preset (SQLite style_presets). */
export const StylePresetSchema = z
  .object({
    id: z.string().min(1),
    ...presetFields,
    source: StylePresetSourceSchema.optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .strict();
export type StylePreset = z.infer<typeof StylePresetSchema>;
export type StylePresetInput = z.input<typeof StylePresetSchema>;

/** POST /api/style/presets: a draft (+ optional id to overwrite, + source). */
export const StylePresetSaveRequestSchema = StylePresetDraftSchema.extend({
  id: z.string().min(1).max(64).optional(),
  source: StylePresetSourceSchema.optional(),
});
export type StylePresetSaveRequest = z.infer<typeof StylePresetSaveRequestSchema>;

/** JSON Schema (draft 2020-12) of StylePresetDraft for the workers / Ollama `format`. */
export function stylePresetJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(StylePresetDraftSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

export type StylePresetValidation =
  | { ok: true; preset: StylePresetDraft; errors: [] }
  | { ok: false; preset: null; errors: string[] };

/** Validates a draft with Spanish messages ("cut_rhythm.min_silence_ms: …"). */
export function validateStylePreset(input: unknown): StylePresetValidation {
  const parsed = StylePresetDraftSchema.safeParse(input, { error: z.locales.es().localeError });
  if (parsed.success) return { ok: true, preset: parsed.data, errors: [] };
  return {
    ok: false,
    preset: null,
    errors: parsed.error.issues.map((i) => {
      const where = i.path.map(String).join(".");
      return where ? `${where}: ${i.message}` : i.message;
    }),
  };
}

/** A neutral starting point for the manual form (16:9, no silences cut, classic captions). */
export const DEFAULT_STYLE_PRESET: StylePresetDraft = {
  name: "Mi estilo",
  canvas: "16:9",
  cut_rhythm: { target_shot_s: 4, remove_silences: true, min_silence_ms: 500 },
  captions: { enabled: true, style: "clasico", animated: false, position: "bottom" },
  titles: { enabled: true, template: "title-card", params: { title: "Mi título" } },
  transitions: { type: "cut" },
  music: { duck: true, volume_db: -14 },
  export_preset: "youtube-1080p",
  notes_es: "",
};

// ---------- compile: StylePreset -> EditPlan (deterministic) ----------

export interface StyleCompileOptions {
  /** Scene starts in timeline seconds (from the assets' detected scenes); [0, ...]. */
  scenes?: readonly number[];
  /** Asset lookup (name) so voice assets (TTS, stems «voz», voz limpia, RVC) are not «music». */
  asset?: (id: string) => { name: string } | undefined;
}

/** Tracks that carry voice, never touched by `music.volume_db`. */
const VOICE_TRACK = /voz|voice|tts|locuci/i;
/** Voice assets by id/name: voice-*, tts-*, stem-voc*, «Voz (…)» (TTS), «… (voz)», «… (RVC …)». */
const VOICE_ASSET = /^(voice-|tts-|stem-voc)|^voz\b|\((voz|voz limpia|rvc\b[^)]*)\)\s*$/i;
const MUSIC_TRACK = /m[uú]sica|music/i;

const MAX_MUSIC_OPS = 4;

const round2 = (n: number) => Math.round(n * 100) / 100;

function clipEnd(c: { start: number; in?: number; out: number; speed?: number }): number {
  return c.start + (c.out - (c.in ?? 0)) / (c.speed || 1);
}

/** "16:9" | "9:16" | "1:1" | null for other sizes. */
export function canvasAspect(w: number, h: number): StyleCanvas | null {
  if (!w || !h) return null;
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.02) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.02) return "9:16";
  if (Math.abs(r - 1) < 0.02) return "1:1";
  return null;
}

/** Export presets whose canvas is vertical (used to pick a sensible default). */
export const VERTICAL_EXPORT_PRESETS: readonly string[] = ["reels-tiktok", "youtube-shorts"];

const TRANSITION_ES: Record<(typeof STYLE_TRANSITION_TYPES)[number], string> = {
  cut: "corte seco",
  fade: "fundido",
  crossfade: "fundido cruzado",
  wipe: "barrido",
  slide: "deslizamiento",
  zoom: "zoom",
};

type ProjectLike = Pick<Project, "settings" | "tracks">;

/**
 * Turns a StylePreset into an EditPlan for the Assistant (validated with EditPlanSchema; always
 * the same plan for the same preset + project). Order: canvas → cut silences → scenes →
 * captions → title (t=0) → lower third (2nd scene or 2 s) → music volume → social label → export
 * (confirm). What Studio has no operation for (transitions between clips, periodic punch-in zoom)
 * becomes a `note_es` the user reads before applying.
 */
export function compileStylePreset(
  preset: StylePresetDraft | StylePreset,
  project: ProjectLike,
  opts: StyleCompileOptions = {},
): EditPlan {
  const ops: EditOpInput[] = [];
  const notes: string[] = [];
  const summary: string[] = [];
  const clips = project.tracks.flatMap((t) => t.clips.map((c) => ({ c, t })));
  const videoClips = clips.filter((x) => x.t.kind === "video" && x.c.assetId);
  const duration = clips.reduce((m, x) => Math.max(m, clipEnd(x.c)), 0);
  const scenes = [...new Set((opts.scenes ?? []).map(round2))]
    .filter((s) => s >= 0 && (duration === 0 || s < duration))
    .sort((a, b) => a - b);

  // 1. canvas
  const current = canvasAspect(project.settings.width, project.settings.height);
  if (current !== preset.canvas) {
    ops.push({ op: "set_canvas", preset: preset.canvas });
    summary.push(`lienzo ${preset.canvas}`);
  }

  // 2. rhythm
  const withAudio = clips.some(
    (x) => (x.t.kind === "video" || x.t.kind === "audio") && x.c.assetId,
  );
  if (preset.cut_rhythm.remove_silences && withAudio) {
    ops.push({
      op: "cut_silences",
      min_silence_ms: preset.cut_rhythm.min_silence_ms,
      padding_ms: preset.cut_rhythm.min_silence_ms <= 350 ? 80 : 120,
      fillers: true,
    });
    summary.push(`cortar silencios de ${preset.cut_rhythm.min_silence_ms} ms o más`);
  }
  const shot = round2(preset.cut_rhythm.target_shot_s);
  if (preset.transitions.type !== "cut") {
    const every = preset.transitions.every_n_cuts ?? 1;
    notes.push(
      `Transiciones: la referencia usa ${TRANSITION_ES[preset.transitions.type]}` +
        `${every > 1 ? ` cada ${every} cortes` : " en los cortes"}; ponelas desde Propiedades → ` +
        `Transición de cada clip (el asistente todavía no las agrega).`,
    );
  }
  if (preset.zoom_punch_in) {
    notes.push(
      `Zoom de golpe: la referencia acerca ×${round2(preset.zoom_punch_in.scale)} cada ` +
        `~${round2(preset.zoom_punch_in.every_s)} s; hacelo con keyframes de escala en ` +
        `Propiedades (el asistente todavía no anima la escala).`,
    );
  }
  if (videoClips.length) {
    ops.push({
      op: "detect_scenes",
      split: shot <= 3,
      note_es: `Ritmo de la referencia: un plano cada ~${shot} s.`.slice(0, 300),
    });
    summary.push(shot <= 3 ? "dividir en escenas" : "detectar escenas");
  }

  // 3. captions (they need a clip with voice)
  if (preset.captions.enabled !== false && withAudio) {
    ops.push({
      op: "add_captions",
      style: preset.captions.style,
      animated: preset.captions.animated,
      language: "es",
      ...(preset.captions.position !== "bottom" && {
        note_es: `En la referencia los subtítulos van ${
          preset.captions.position === "top" ? "arriba" : "al centro"
        }.`,
      }),
    });
    summary.push(
      `subtítulos ${preset.captions.style}${preset.captions.animated ? " animados" : ""}`,
    );
  }

  // 4. title at t = 0
  if (preset.titles.enabled !== false) {
    const params = preset.titles.params ?? {};
    ops.push({
      op: "add_motion",
      template: preset.titles.template,
      t: 0,
      ...(preset.titles.duration_s !== undefined && { duration_s: preset.titles.duration_s }),
      ...(Object.keys(params).length > 0 && { params: { ...params } }),
    });
    summary.push("título al inicio");
  }

  // 5. lower third at the 2nd scene (or 2 s)
  if (preset.lower_third && preset.lower_third.enabled !== false) {
    const params = preset.lower_third.params ?? {};
    const second = scenes.find((s) => s > 0.5);
    const t = second ?? (duration === 0 || duration > 4 ? 2 : 0);
    ops.push({
      op: "add_motion",
      template: "lower-third",
      t,
      ...(preset.lower_third.duration_s !== undefined && {
        duration_s: preset.lower_third.duration_s,
      }),
      ...(Object.keys(params).length > 0 && { params: { ...params } }),
      ...(second === undefined && { note_es: "Sin escenas detectadas: el rótulo va a los 2 s." }),
    });
    summary.push("rótulo con nombre");
  }

  // 6. music: volume of the music clips (fixed background level). Voice tracks/assets are skipped;
  // when a track is named «Música»/«Music» only its clips count.
  const audioClips = clips.filter((x) => {
    if (x.t.kind !== "audio" || !x.c.assetId || VOICE_TRACK.test(x.t.name)) return false;
    const name = opts.asset?.(x.c.assetId)?.name ?? "";
    return !VOICE_ASSET.test(x.c.assetId) && !VOICE_ASSET.test(name);
  });
  const onMusicTracks = audioClips.filter((x) => MUSIC_TRACK.test(x.t.name));
  const music = (onMusicTracks.length ? onMusicTracks : audioClips)
    .sort((a, b) => a.c.start - b.c.start || a.c.id.localeCompare(b.c.id))
    .slice(0, MAX_MUSIC_OPS);
  for (const { c } of music)
    ops.push({
      op: "set_volume",
      clip: { id: c.id },
      volume_db: preset.music.volume_db,
      ...(preset.music.duck && {
        note_es: "Música de fondo: volumen fijo debajo de la voz (como la referencia).",
      }),
    });
  if (music.length) summary.push(`música a ${preset.music.volume_db} dB`);
  else if (preset.music.duck && preset.music.volume_db > -60)
    notes.push(
      `La referencia tiene música de fondo (≈ ${preset.music.volume_db} dB): agregá una desde ` +
        `Biblioteca y volvé a aplicar el estilo para ajustar su volumen.`,
    );

  // 7. social label
  if (preset.ai_label) {
    ops.push({ op: "set_publish", for_social: true, ai_label: true });
    summary.push("etiqueta de IA");
  }

  // 8. export (always confirmed apart)
  const exportName = preset.name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  ops.push({
    op: "export",
    preset: preset.export_preset,
    confirm: true,
    ...(exportName && { name: `estilo-${exportName}` }),
  });
  summary.push(`exportar con ${preset.export_preset}`);

  // Notes go on the first op the user reads (one line each, ≤ 300 chars per op).
  if (notes.length) {
    const target = ops.find((o) => o.op === "detect_scenes") ?? ops[0]!;
    const joined = [target.note_es, ...notes].filter(Boolean).join(" ");
    target.note_es = joined.length > 300 ? `${joined.slice(0, 297)}…` : joined;
  }

  let summaryEs = `Aplico el estilo «${preset.name}»: ${summary.join(", ")}.`;
  if (summaryEs.length > 500) summaryEs = `${summaryEs.slice(0, 497)}…`;
  const v = validateEditPlan({ version: 1, summary_es: summaryEs, ops });
  if (!v.ok) throw new Error(`compileStylePreset: plan inválido: ${v.errors.join("; ")}`);
  return v.plan;
}

/** Notes (`note_es`) of a compiled plan, for the preview. */
export function stylePlanNotes(plan: EditPlan): string[] {
  return plan.ops.map((o: EditOp) => o.note_es).filter((n): n is string => !!n);
}

// ---------- routes ----------

/** Workers routes (apps/workers/studio_workers/routers/style.py). */
export const WORKER_STYLE_ROUTES = {
  analyze: "/style/analyze", // POST WorkerStyleAnalyzeRequest -> {task_id}
  infer: "/style/infer", // POST {analysis_path, contact_sheet_path, model?} -> WorkerStyleInferResponse
  task: "/style/tasks/:id", // GET task (result = {analysis_path, analysis})
} as const;

export const STYLE_VISION_PACK_ID = "vision-llm";
export const STYLE_OCR_PACK_ID = "ocr";
export const STYLE_VISION_DEFAULT_MODEL = "qwen2.5vl:3b";

export const WorkerStyleAnalyzeRequestSchema = z.object({
  path: z.string().min(1),
  /** Output folder relative to STORAGE_DIR (analysis.json, contact_sheet.png, thumbs). */
  output_dir: z.string().min(1),
  max_frames: z.int().min(4).max(24).default(24),
  ocr: z.boolean().optional(),
  /** Segments of an existing transcript (speech ratio + excerpt). */
  transcript: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .optional(),
});
export type WorkerStyleAnalyzeRequest = z.input<typeof WorkerStyleAnalyzeRequestSchema>;

export const WorkerStyleInferResponseSchema = z.object({
  preset: z.unknown(),
  model: z.string().nullish(),
  latency_ms: z.number().nonnegative().default(0),
  attempts: z.int().nonnegative().default(1),
  warnings: z.array(z.string()).default([]),
});
export type WorkerStyleInferResponse = z.infer<typeof WorkerStyleInferResponseSchema>;

/** api routes (apps/api/src/routes/style.ts). */
export const STYLE_API_ROUTES = {
  analyze: "/api/style/analyze", // POST {assetId} -> JobAccepted (style.analyze)
  analyses: "/api/style/analyses", // GET ?assetId -> StyleAnalysisRecord[]
  analysis: "/api/style/analyses/:id", // GET StyleAnalysisRecord
  infer: "/api/style/infer", // POST {analysisId} -> JobAccepted (style.infer) | 409 PACK_REQUIRED
  presets: "/api/style/presets", // GET StylePreset[] | POST StylePresetSaveRequest -> StylePreset
  preset: "/api/style/presets/:id", // GET | DELETE
  apply: "/api/style/presets/:id/apply", // POST {projectId} -> StyleApplyResponse
} as const;

export const StyleAnalyzeRequestSchema = z.object({
  assetId: z.string().min(1),
  ocr: z.boolean().optional(),
});
export const StyleInferRequestSchema = z.object({
  analysisId: z.string().min(1),
  model: z.string().min(1).optional(),
});
export const StyleApplyRequestSchema = z.object({ projectId: z.string().min(1) });

/** Analysis asset (kind "analysis") + its parsed JSON. */
export interface StyleAnalysisRecord {
  id: string;
  name: string;
  path: string;
  sourceAssetId?: string;
  createdAt: string;
  analysis: StyleAnalysis;
}

/** style.analyze job result. */
export interface StyleAnalyzeJobResult {
  analysisId: string;
  path: string;
  contactSheetPath: string;
  analysis: StyleAnalysis;
}

/** style.infer job result: a validated draft (save it with POST /api/style/presets). */
export interface StyleInferJobResult {
  analysisId: string;
  preset: StylePresetDraft;
  model?: string | null;
  latency_ms?: number;
  warnings: string[];
}

/** POST /api/style/presets/:id/apply: the plan is stored as an Assistant plan (proposed). */
export interface StyleApplyResponse {
  planId: string;
  preview_es: string[];
  risks: string[];
  unresolved: string[];
  notes_es: string[];
  /** The stored Assistant plan (open it with the agent store's receivePlan). */
  plan: AgentPlanRecord;
}
