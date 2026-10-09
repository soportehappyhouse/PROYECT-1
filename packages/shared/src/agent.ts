import { z } from "zod";
import { PackRequiredBodySchema } from "./ai.js";
import { IdSchema } from "./common.js";
import { FaceSwapperModelSchema } from "./face.js";
import { REMOTION_TEMPLATE_IDS } from "./motion.js";
import { CAPTION_STYLE_IDS } from "./subtitles.js";

/**
 * Sprint 3 (docs/trabajo/sprint3-contratos.md): local command agent. The local LLM (Ollama) only
 * proposes an `EditPlan`; the api validates it with these schemas, resolves ClipRef/Time against
 * the project and the user confirms before `agent.apply` runs it. SINGLE SOURCE OF TRUTH: the
 * workers validate with the JSON Schema exported by `pnpm --filter @studio/shared export-schemas`
 * (apps/workers/studio_workers/agent/editplan.schema.json). Field names keep the snake_case of the
 * Python contract; every field carries a Spanish `.describe()` (it ends up in the JSON Schema the
 * model sees through Ollama structured outputs).
 */

// ---------- ids known by the agent ----------

export const AGENT_TRACK_KINDS = ["video", "audio", "text", "motion"] as const;
export const AgentTrackKindSchema = z
  .enum(AGENT_TRACK_KINDS)
  .describe("Tipo de pista: video, audio, text (textos/rótulos) o motion (gráficos animados).");
export type AgentTrackKind = z.infer<typeof AgentTrackKindSchema>;

export const AGENT_TEMPLATE_IDS = REMOTION_TEMPLATE_IDS;
export const TemplateIdSchema = z
  .enum(AGENT_TEMPLATE_IDS)
  .describe(
    "Plantilla de motion: title-card (título), lower-third (rótulo con nombre), animated-captions " +
      "(subtítulos animados), transition, audio-visualizer, lottie-overlay, end-screen (pantalla " +
      "final), progress-bar (barra de progreso), kinetic-typography (texto cinético).",
  );
export type TemplateId = z.infer<typeof TemplateIdSchema>;

// CAPTION_STYLE_IDS (the single list of caption style ids) lives next to CAPTION_STYLE_PRESETS
// in subtitles.ts.
export const CaptionStyleIdSchema = z
  .enum(CAPTION_STYLE_IDS)
  .describe(
    "Estilo de subtítulos: clasico (abajo con fondo), reels (palabra a palabra, grande, centro), " +
      "karaoke (resalta la palabra dicha), minimal (sin fondo), titular (arriba, amarillo).",
  );
export type CaptionStyleId = z.infer<typeof CaptionStyleIdSchema>;

/** Same ids as VOICE_EFFECT_PRESETS (voice.ts). */
export const VOICE_EFFECT_IDS = [
  "pitch-up",
  "pitch-down",
  "chipmunk",
  "deep",
  "robot",
  "telephone",
  "radio",
  "reverb",
  "echo",
  "clean-voice",
  "monstruo",
  "catedral",
  "bajo-agua",
  "megafono",
] as const;
export const VoiceEffectIdSchema = z
  .enum(VOICE_EFFECT_IDS)
  .describe(
    "Efecto de voz: pitch-up (tono +4), pitch-down (tono -4), chipmunk (ardilla), deep (grave), " +
      "robot, telephone (teléfono), radio (radio AM), reverb (sala), echo (eco), clean-voice " +
      "(voz limpia: reduce ruido y normaliza), monstruo (tono -10 + reverberación), catedral " +
      "(reverberación grande), bajo-agua (bajo el agua), megafono (megáfono).",
  );
export type VoiceEffectId = z.infer<typeof VoiceEffectIdSchema>;

export const VoiceIdSchema = z
  .string()
  .min(1)
  .describe("Voz de TTS (id de Piper, p. ej. es_AR-daniela-high). Omitir para la voz por defecto.");
export type VoiceId = z.infer<typeof VoiceIdSchema>;

/** Built-in export presets (DEFAULT_EXPORT_PRESETS + EXTRA_EXPORT_PRESETS); users may add more. */
export const AGENT_KNOWN_PRESET_IDS = [
  "youtube-1080p",
  "youtube-4k",
  "reels-tiktok",
  "youtube-shorts",
  "gif-480",
  "webm-alpha",
] as const;
export const PresetIdSchema = z
  .string()
  .min(1)
  .describe(
    "Id del preset de exportación: youtube-1080p (horizontal), youtube-4k, reels-tiktok " +
      "(vertical 9:16 para Reels/TikTok), youtube-shorts (vertical), gif-480, webm-alpha, o un " +
      "preset propio del usuario.",
  );
export type PresetId = z.infer<typeof PresetIdSchema>;

// ---------- Time / ClipRef ----------

/** Times that do not reference a clip (the inner level of the non-recursive Time). */
export const PointTimeSchema = z
  .union([
    z.number().nonnegative().describe("Segundos desde el inicio de la línea de tiempo."),
    z
      .enum(["start", "end", "cursor"])
      .describe("start = inicio del video, end = final del video, cursor = posición del cabezal."),
    z
      .object({
        scene: z
          .int()
          .min(1)
          .describe("Número de escena detectada (1 = primera escena); se usa su inicio."),
      })
      .strict()
      .describe("Inicio de una escena detectada."),
  ])
  .meta({ id: "PointTime" });
export type PointTime = z.infer<typeof PointTimeSchema>;

const clipRefFields = {
  id: z.string().min(1).optional().describe("Id exacto del clip (solo si figura en el resumen)."),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Nombre (o parte del nombre) del clip o de su archivo, como lo dijo el usuario."),
  index: z
    .int()
    .refine((n) => n !== 0, { error: "index empieza en 1 (o -1 para el último)" })
    .optional()
    .describe(
      "Posición del clip por orden de inicio: 1 = primero, 2 = segundo; -1 = último, -2 = " +
        "anteúltimo. Si se da `track`, cuenta solo en ese tipo de pista.",
    ),
  track: AgentTrackKindSchema.optional().describe(
    "Tipo de pista donde está el clip (filtra la búsqueda).",
  ),
};

/** ClipRef whose `at` is a PointTime (used inside `after_clip`, keeps the schema non-recursive). */
export const BaseClipRefSchema = z
  .object({
    ...clipRefFields,
    at: PointTimeSchema.optional().describe("Clip que está en pantalla en ese momento."),
  })
  .strict()
  .describe("Referencia a un clip del proyecto.")
  .meta({ id: "BaseClipRef" });
export type BaseClipRef = z.infer<typeof BaseClipRefSchema>;

export const TimeSchema = z
  .union([
    ...PointTimeSchema.options,
    z
      .object({
        after_clip: BaseClipRefSchema.describe("Clip de referencia; se usa el final de ese clip."),
      })
      .strict()
      .describe("Justo después de que termina un clip."),
  ])
  .describe(
    "Momento en la línea de tiempo: segundos, 'start', 'end', 'cursor', {scene: n} o " +
      "{after_clip: ClipRef}. Nunca inventar tiempos: si el usuario no lo dijo, preguntar.",
  )
  .meta({ id: "Time" });
export type Time = z.infer<typeof TimeSchema>;

export const ClipRefSchema = z
  .object({
    ...clipRefFields,
    at: TimeSchema.optional().describe("Clip que está en pantalla en ese momento."),
  })
  .strict()
  .describe(
    "Referencia a un clip: id, nombre, posición (index), tipo de pista y/o momento (at). La API " +
      "la resuelve a un id; si es ambigua, devuelve una pregunta.",
  )
  .meta({ id: "ClipRef" });
export type ClipRef = z.infer<typeof ClipRefSchema>;

// ---------- EditOp ----------

const common = {
  confirm: z
    .boolean()
    .optional()
    .describe("Si el usuario debe confirmar esta operación antes de aplicarla (por defecto sí)."),
  note_es: z.string().max(300).optional().describe("Aclaración breve en español para el usuario."),
};

const op = <T extends string>(name: T, desc: string) => z.literal(name).describe(desc);

export const TextStyleArgSchema = z
  .object({
    font_family: z.string().min(1).optional().describe("Tipografía (p. ej. Inter, Georgia)."),
    font_size: z.number().positive().max(400).optional().describe("Tamaño en píxeles."),
    color: z.string().min(1).optional().describe("Color del texto (#rrggbb)."),
    background: z.string().optional().describe("Color de fondo de la caja (#rrggbb o rgba)."),
  })
  .strict()
  .describe("Estilo del texto.");
export type TextStyleArg = z.infer<typeof TextStyleArgSchema>;

export const AnchorSchema = z
  .enum(["top", "center", "bottom"])
  .describe("Ubicación vertical en pantalla: top (arriba), center (centro), bottom (abajo).");
export type Anchor = z.infer<typeof AnchorSchema>;

export const AssetRefSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Id exacto del asset (solo si figura en el resumen)."),
    name: z.string().min(1).optional().describe("Nombre (o parte) del archivo de la biblioteca."),
  })
  .strict()
  .describe("Referencia a un archivo ya importado o de la biblioteca.");
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const BackgroundArgSchema = z
  .object({
    type: z
      .enum(["color", "image", "video", "blur"])
      .describe("Fondo detrás de la persona recortada: color, imagen, video o desenfoque."),
    value: z
      .string()
      .optional()
      .describe("Color (#rrggbb) o nombre del archivo de imagen/video; vacío para blur."),
  })
  .strict()
  .describe("Fondo nuevo.");
export type BackgroundArg = z.infer<typeof BackgroundArgSchema>;

export const CanvasPresetSchema = z
  .union([
    z.enum(["16:9", "9:16", "1:1"]).describe("Relación de aspecto estándar."),
    z
      .object({
        w: z.int().min(16).max(7680).describe("Ancho en píxeles."),
        h: z.int().min(16).max(7680).describe("Alto en píxeles."),
      })
      .strict()
      .describe("Tamaño exacto en píxeles."),
  ])
  .describe("Lienzo: 16:9 (horizontal), 9:16 (vertical), 1:1 (cuadrado) o {w, h}.");
export type CanvasPreset = z.infer<typeof CanvasPresetSchema>;

export const PublishFlagsArgSchema = z
  .object({
    ai_face: z.boolean().optional().describe("El video tiene una cara generada o cambiada por IA."),
    ai_voice: z.boolean().optional().describe("El video tiene voz generada o clonada por IA."),
    ai_other: z.boolean().optional().describe("Otro contenido generado por IA."),
    music: z.boolean().optional().describe("Tiene música."),
    third_party: z.boolean().optional().describe("Tiene material de terceros."),
  })
  .strict()
  .describe("Checklist de la Revisión para redes.");
export type PublishFlagsArg = z.infer<typeof PublishFlagsArgSchema>;

export const CutSilencesOpSchema = z
  .object({
    op: op("cut_silences", "Cortar silencios (y muletillas) de un clip."),
    clip: ClipRefSchema.optional().describe(
      "Clip a procesar; omitir = el clip de video principal.",
    ),
    min_silence_ms: z
      .int()
      .min(100)
      .max(10_000)
      .optional()
      .describe("Duración mínima del silencio a cortar, en milisegundos (por defecto 500)."),
    padding_ms: z
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe("Margen que se deja antes y después de cada corte, en milisegundos (120)."),
    fillers: z.boolean().optional().describe("También cortar muletillas (eh, este, o sea)."),
    ...common,
  })
  .strict()
  .describe("Cortar silencios.");

export const DetectScenesOpSchema = z
  .object({
    op: op("detect_scenes", "Detectar cambios de escena."),
    clip: ClipRefSchema.optional().describe(
      "Clip a analizar; omitir = el clip de video principal.",
    ),
    split: z.boolean().optional().describe("Además dividir el clip en cada cambio de escena."),
    ...common,
  })
  .strict()
  .describe("Detectar escenas.");

export const SplitOpSchema = z
  .object({
    op: op("split", "Dividir un clip en dos en un momento."),
    clip: ClipRefSchema.describe("Clip a dividir."),
    t: TimeSchema.describe("Momento del corte (en la línea de tiempo)."),
    ...common,
  })
  .strict()
  .describe("Dividir clip.");

export const TrimOpSchema = z
  .object({
    op: op("trim", "Recortar el inicio y/o el final de un clip."),
    clip: ClipRefSchema.describe("Clip a recortar."),
    in: TimeSchema.optional().describe("Nuevo inicio del clip (en la línea de tiempo)."),
    out: TimeSchema.optional().describe("Nuevo final del clip (en la línea de tiempo)."),
    ...common,
  })
  .strict()
  .describe("Recortar clip.");

export const DeleteClipOpSchema = z
  .object({
    op: op("delete_clip", "Borrar un clip (siempre pide confirmación)."),
    clip: ClipRefSchema.describe("Clip a borrar."),
    ...common,
  })
  .strict()
  .describe("Borrar clip.");

export const SetSpeedOpSchema = z
  .object({
    op: op("set_speed", "Cambiar la velocidad de un clip."),
    clip: ClipRefSchema.describe("Clip a acelerar o ralentizar."),
    speed: z
      .number()
      .min(0.1)
      .max(16)
      .describe("Factor de velocidad: 2 = doble de rápido, 0.5 = cámara lenta."),
    ...common,
  })
  .strict()
  .describe("Cambiar velocidad.");

export const SetVolumeOpSchema = z
  .object({
    op: op("set_volume", "Cambiar el volumen de un clip que ya está en el proyecto."),
    clip: ClipRefSchema.describe("Clip de audio o video cuyo volumen cambia."),
    volume_db: z
      .number()
      .min(-60)
      .max(12)
      .describe(
        "Volumen en dB respecto del original: 0 = original, -12 = de fondo, -60 = silenciado, " +
          "+6 = más fuerte.",
      ),
    ...common,
  })
  .strict()
  .describe("Cambiar volumen.");

export const MoveClipOpSchema = z
  .object({
    op: op("move_clip", "Mover un clip a otro momento de la línea de tiempo (misma pista)."),
    clip: ClipRefSchema.describe("Clip a mover."),
    t: TimeSchema.describe("Nuevo inicio del clip en la línea de tiempo."),
    ...common,
  })
  .strict()
  .describe("Mover clip.");

export const AddTextOpSchema = z
  .object({
    op: op("add_text", "Agregar un texto o rótulo simple en la pista de texto."),
    text: z.string().min(1).max(500).describe("Texto exacto a mostrar."),
    t: TimeSchema.describe("Momento en que aparece."),
    duration_s: z
      .number()
      .positive()
      .max(3600)
      .optional()
      .describe("Duración en pantalla, en segundos (por defecto 3)."),
    style: TextStyleArgSchema.optional(),
    position: AnchorSchema.optional(),
    ...common,
  })
  .strict()
  .describe("Agregar texto.");

export const AddMotionOpSchema = z
  .object({
    op: op("add_motion", "Agregar un gráfico animado (plantilla de motion)."),
    template: TemplateIdSchema,
    t: TimeSchema.describe("Momento en que aparece."),
    duration_s: z
      .number()
      .positive()
      .max(3600)
      .optional()
      .describe("Duración en segundos (por defecto la de la plantilla)."),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Parámetros de la plantilla (p. ej. {title, subtitle} o {name, role})."),
    follow: z
      .union([ClipRefSchema, z.literal("face").describe("Seguir la cara detectada.")])
      .optional()
      .describe("Hacer que el gráfico siga a un clip con tracking o a la cara ('face')."),
    ...common,
  })
  .strict()
  .describe("Agregar motion.");

export const AddCaptionsOpSchema = z
  .object({
    op: op("add_captions", "Generar subtítulos (transcribe si hace falta)."),
    clip: ClipRefSchema.optional().describe("Clip con la voz; omitir = el clip principal."),
    style: CaptionStyleIdSchema.optional(),
    animated: z
      .boolean()
      .optional()
      .describe("Subtítulos animados palabra a palabra (motion) en vez de quemados simples."),
    language: z.literal("es").optional().describe("Idioma de la transcripción (es)."),
    ...common,
  })
  .strict()
  .describe("Agregar subtítulos.");

export const TranscribeOpSchema = z
  .object({
    op: op("transcribe", "Transcribir la voz de un clip a texto."),
    clip: ClipRefSchema.optional().describe("Clip a transcribir; omitir = el clip principal."),
    ...common,
  })
  .strict()
  .describe("Transcribir.");

export const TtsOpSchema = z
  .object({
    op: op("tts", "Generar una voz que lee un texto y colocarla en la pista de audio."),
    text: z.string().min(1).max(5000).describe("Texto exacto a leer."),
    voice: VoiceIdSchema.optional(),
    t: TimeSchema.describe("Momento en que empieza la voz."),
    effect: VoiceEffectIdSchema.optional(),
    ...common,
  })
  .strict()
  .describe("Texto a voz.");

export const VoiceEffectOpSchema = z
  .object({
    op: op("voice_effect", "Aplicar un efecto de voz a un clip."),
    clip: ClipRefSchema.describe("Clip con la voz."),
    effect: VoiceEffectIdSchema,
    ...common,
  })
  .strict()
  .describe("Efecto de voz.");

export const DenoiseOpSchema = z
  .object({
    op: op("denoise", "Limpiar el ruido de fondo de la voz de un clip."),
    clip: ClipRefSchema.describe("Clip con la voz."),
    ...common,
  })
  .strict()
  .describe("Limpiar voz.");

export const AddAudioOpSchema = z
  .object({
    op: op("add_audio", "Agregar música o un efecto de sonido."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe("Búsqueda en la biblioteca de audio (p. ej. 'música alegre', 'aplausos')."),
    asset: AssetRefSchema.optional(),
    t: TimeSchema.describe("Momento en que empieza el audio."),
    volume_db: z
      .number()
      .min(-60)
      .max(12)
      .optional()
      .describe("Volumen en dB (0 = original, -12 = de fondo)."),
    duck: z.boolean().optional().describe("Bajar la música automáticamente cuando hay voz."),
    ...common,
  })
  .strict()
  .describe("Agregar audio.");

export const RemoveBackgroundOpSchema = z
  .object({
    op: op("remove_background", "Recortar a la persona y reemplazar el fondo."),
    clip: ClipRefSchema.describe("Clip con la persona."),
    background: BackgroundArgSchema,
    ...common,
  })
  .strict()
  .describe("Quitar fondo.");

export const ReframeOpSchema = z
  .object({
    op: op("reframe", "Reencuadrar el video a otra relación de aspecto siguiendo al sujeto."),
    target: z.enum(["9:16", "1:1", "4:5"]).describe("Relación de aspecto de destino."),
    subject: z
      .enum(["face", "center"])
      .optional()
      .describe("Qué seguir: face (la cara) o center (el centro)."),
    ...common,
  })
  .strict()
  .describe("Reencuadrar.");

export const SetCanvasOpSchema = z
  .object({
    op: op("set_canvas", "Cambiar el tamaño del lienzo del proyecto."),
    preset: CanvasPresetSchema,
    ...common,
  })
  .strict()
  .describe("Cambiar lienzo.");

export const SetPublishOpSchema = z
  .object({
    op: op("set_publish", "Configurar la Revisión para redes y la etiqueta de IA."),
    for_social: z.boolean().describe("El video se va a subir a redes."),
    flags: PublishFlagsArgSchema.optional(),
    ai_label: z
      .boolean()
      .optional()
      .describe("Quemar la etiqueta 'Contenido alterado con IA' (solo si es para redes)."),
    ...common,
  })
  .strict()
  .describe("Revisión para redes.");

/** Sprint 5: how to bring a video to a different aspect (e.g. horizontal -> 9:16). */
export const AspectFitSchema = z.enum(["reframe", "center", "blur"]);
export type AspectFit = z.infer<typeof AspectFitSchema>;

export const ExportOpSchema = z
  .object({
    op: op("export", "Exportar el video final (siempre pide confirmación)."),
    preset: PresetIdSchema,
    name: z.string().min(1).max(120).optional().describe("Nombre del archivo de salida."),
    burn_subtitles: z.boolean().optional().describe("Quemar los subtítulos en el video."),
    aspect_fit: AspectFitSchema.optional().describe("Cómo llevar un video horizontal a vertical."),
    ...common,
  })
  .strict()
  .describe("Exportar.");

export const ReportBugOpSchema = z
  .object({
    op: op("report_bug", "Redactar un reporte de error de Studio."),
    title: z.string().min(1).max(200).describe("Título breve del problema."),
    steps_es: z.string().min(1).max(4000).describe("Qué hizo el usuario y qué pasó, en español."),
    ...common,
  })
  .strict()
  .describe("Reportar error.");

/**
 * Sprint 4 (docs/trabajo/sprint4-contratos.md, M1): face swap with a registered Person (consent
 * checked by the api). Always confirmed (ALWAYS_CONFIRM_OPS): consent + nobody is a minor.
 */
export const FaceSwapOpSchema = z
  .object({
    op: op(
      "face_swap",
      "Cambiar la cara de un clip por la de una Persona registrada con consentimiento.",
    ),
    clip: ClipRefSchema.describe("Clip de video cuya cara se cambia."),
    person: z
      .union([
        z.object({ id: IdSchema.describe("Id exacto de la Persona.") }).strict(),
        z
          .object({
            name: z.string().min(1).describe("Nombre de la Persona, como lo dijo el usuario."),
          })
          .strict(),
      ])
      .describe(
        "Persona registrada en Ajustes → Personas (con consentimiento de rostro vigente) cuya " +
          "cara se pone: {id} o {name}.",
      ),
    t: TimeSchema.optional().describe(
      "Momento del fotograma donde se elige la cara a cambiar (junto con face_index); omitir = " +
        "la única cara del clip.",
    ),
    face_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Cara a cambiar en ese fotograma, de izquierda a derecha (0 = la primera)."),
    model: FaceSwapperModelSchema.optional().describe(
      "Modelo: hyperswap_1a_256 (recomendado), ghost_1_256 o inswapper_128_fp16 (más rápido).",
    ),
    enhancer: z
      .boolean()
      .optional()
      .describe("Mejorar la nitidez de la cara resultante (por defecto sí)."),
    strength: z
      .number()
      .min(0.1)
      .max(1)
      .optional()
      .describe("Intensidad del cambio: 1 = completo, 0.5 = mitad mezclada con el original."),
    ...common,
  })
  .strict()
  .describe("Cambiar cara.");

export const EditOpSchema = z
  .discriminatedUnion("op", [
    CutSilencesOpSchema,
    DetectScenesOpSchema,
    SplitOpSchema,
    TrimOpSchema,
    DeleteClipOpSchema,
    SetSpeedOpSchema,
    SetVolumeOpSchema,
    MoveClipOpSchema,
    AddTextOpSchema,
    AddMotionOpSchema,
    AddCaptionsOpSchema,
    TranscribeOpSchema,
    TtsOpSchema,
    VoiceEffectOpSchema,
    DenoiseOpSchema,
    AddAudioOpSchema,
    RemoveBackgroundOpSchema,
    ReframeOpSchema,
    SetCanvasOpSchema,
    SetPublishOpSchema,
    ExportOpSchema,
    ReportBugOpSchema,
    FaceSwapOpSchema,
  ])
  .describe("Una operación de edición; el campo `op` indica cuál.");
export type EditOp = z.infer<typeof EditOpSchema>;
export type EditOpInput = z.input<typeof EditOpSchema>;
export type EditOpName = EditOp["op"];
export type EditOpOf<K extends EditOpName> = Extract<EditOp, { op: K }>;

export const EDIT_OP_NAMES = EditOpSchema.options.map((o) => o.shape.op.value) as EditOpName[];

/**
 * Ops that always need confirmation whatever `confirm` says (destructive: the web leaves them
 * unchecked and asks for a separate «Confirmar borrado/exportación» click; the api needs their
 * indexes in `confirmedIndexes`). Sprint 4: face_swap (consent + nobody in the video is a minor).
 */
export const ALWAYS_CONFIRM_OPS: readonly EditOpName[] = ["delete_clip", "export", "face_swap"];

export const EDIT_PLAN_MAX_OPS = 20;

export const EditPlanSchema = z
  .object({
    version: z.literal(1).describe("Versión del esquema; siempre 1."),
    summary_es: z
      .string()
      .min(1)
      .max(500)
      .describe("Resumen en una frase, en español rioplatense, de lo que va a hacer el plan."),
    ops: z
      .array(EditOpSchema)
      .max(EDIT_PLAN_MAX_OPS)
      .describe("Operaciones en el orden en que se aplican. Vacío si solo hay preguntas."),
    questions: z
      .array(z.string().min(1).max(300))
      .max(5)
      .optional()
      .describe(
        "Preguntas al usuario cuando falta un dato (clip, momento, texto). Nunca inventar ids " +
          "ni tiempos: preguntar.",
      ),
  })
  .strict()
  .refine((p) => p.ops.length > 0 || (p.questions?.length ?? 0) > 0, {
    error: "El plan no tiene operaciones ni preguntas.",
    path: ["ops"],
  })
  .describe("Plan de edición propuesto por el asistente local.");
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type EditPlanInput = z.input<typeof EditPlanSchema>;

export type EditPlanValidation =
  { ok: true; plan: EditPlan; errors: [] } | { ok: false; plan: null; errors: string[] };

/** "ops[2].clip.index" style path. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

/**
 * Validates an EditPlan with Spanish error messages ("ops[1].speed: Demasiado grande: …").
 * Unknown `op` values get an explicit message listing the valid ones.
 */
export function validateEditPlan(input: unknown): EditPlanValidation {
  const parsed = EditPlanSchema.safeParse(input, { error: z.locales.es().localeError });
  if (parsed.success) return { ok: true, plan: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((iss) => {
    const where = formatPath(iss.path);
    let msg = iss.message;
    if (iss.code === "invalid_union" && "discriminator" in iss && iss.discriminator === "op") {
      msg = `operación desconocida; válidas: ${EDIT_OP_NAMES.join(", ")}`;
    }
    return where ? `${where}: ${msg}` : msg;
  });
  return { ok: false, plan: null, errors };
}

/** JSON Schema (draft 2020-12) of EditPlan for the workers / Ollama `format`. */
export function editPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EditPlanSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

// ---------- workers contract ----------

export const WORKER_AGENT_ROUTES = {
  status: "/agent/status", // GET AgentWorkerStatus
  plan: "/agent/plan", // POST WorkerAgentPlanRequest -> WorkerAgentPlanResponse
  evaluate: "/agent/eval", // POST {models?, dataset?} -> {task_id}
  bugreport: "/agent/bugreport", // POST WorkerBugreportRequest -> {markdown_es}
} as const;

export const AGENT_LLM_PACK_ID = "agent-llm";
export const AGENT_DEFAULT_MODEL = "qwen3:8b";
export const OLLAMA_URL = "http://127.0.0.1:11434";

export const AgentWorkerStatusSchema = z.object({
  ollama: z.boolean(),
  model: z.string().nullable().default(null),
  models_installed: z.array(z.string()).default([]),
  ready: z.boolean(),
  gpu_mode: z.string().nullish(),
  /** The model is resident in Ollama right now (/api/ps): false = the next call loads it first. */
  loaded: z.boolean().optional(),
  /** Spanish hint with the exact manual commands (ollama pull …, doctor.cmd). */
  hint_es: z.string().nullish(),
});
export type AgentWorkerStatus = z.infer<typeof AgentWorkerStatusSchema>;

export const AgentLlmSettingsSchema = z.object({
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type AgentLlmSettings = z.infer<typeof AgentLlmSettingsSchema>;

/**
 * Compact project summary sent to the workers as `project_summary` (same JSON shape as the dataset
 * rows, apps/workers/studio_workers/agent/dataset/README.md). The workers render it as prompt text
 * (`summary.as_text`: compact JSON). Built by the api (services/agent/summary.ts), ≤ ~1500 tokens.
 */
export const AgentProjectSummarySchema = z
  .object({
    canvas: z.object({ w: z.number(), h: z.number(), fps: z.number().optional() }),
    cursor_s: z.number(),
    tracks: z.array(
      z.object({
        kind: AgentTrackKindSchema,
        clips: z.array(
          z.object({ id: z.string(), name: z.string(), start: z.number(), end: z.number() }),
        ),
      }),
    ),
    scenes: z.array(z.object({ n: z.int(), start: z.number() })).optional(),
    assets: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })).optional(),
    transcript_excerpt: z
      .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
      .optional(),
  })
  .strict();
export type AgentProjectSummary = z.infer<typeof AgentProjectSummarySchema>;

export const WorkerAgentPlanRequestSchema = z.object({
  command: z.string().min(1),
  /** JSON shape above (a plain string is still accepted by the workers). */
  project_summary: z.union([AgentProjectSummarySchema, z.string()]),
  settings: AgentLlmSettingsSchema.default({}),
});
export type WorkerAgentPlanRequest = z.infer<typeof WorkerAgentPlanRequestSchema>;

/** Workers answer; `plan` is validated separately with validateEditPlan (Spanish errors). */
export const WorkerAgentPlanResponseSchema = z.object({
  plan: z.unknown(),
  model: z.string().nullish(),
  latency_ms: z.number().nonnegative().default(0),
  attempts: z.int().nonnegative().default(1),
  warnings: z.array(z.string()).default([]),
  route: z.enum(["deterministic", "llm"]).default("llm"),
  /** Prompt size estimate (chars / 3.5) of the LLM route, logged by the api. */
  prompt_tokens: z.int().nonnegative().optional(),
});
export type WorkerAgentPlanResponse = z.infer<typeof WorkerAgentPlanResponseSchema>;

export const WorkerBugreportRequestSchema = z.object({
  title: z.string().optional(),
  steps_text: z.string(),
  breadcrumbs: z.array(z.unknown()).default([]),
  errors: z.array(z.unknown()).default([]),
  env: z.record(z.string(), z.unknown()).default({}),
  /** Model to draft with (default: the workers' AGENT_MODEL). */
  model: z.string().min(1).optional(),
});
export type WorkerBugreportRequest = z.infer<typeof WorkerBugreportRequestSchema>;

export const BugreportResponseSchema = z.object({
  markdown_es: z.string(),
  /** "template" when the workers had no model (deterministic draft). */
  source: z.enum(["llm", "template"]).optional(),
});
export type BugreportResponse = z.infer<typeof BugreportResponseSchema>;

// ---------- api contract ----------

export const AgentPlanStatusSchema = z.enum(["proposed", "applied", "rejected"]);
export type AgentPlanStatus = z.infer<typeof AgentPlanStatusSchema>;

/** POST /api/agent/plan. */
export const AgentPlanRequestSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  /** Absent: the most recently saved project. */
  projectId: z.string().min(1).optional(),
  /** Playhead (seconds) used by Time "cursor". */
  cursor: z.number().nonnegative().optional(),
  settings: AgentLlmSettingsSchema.optional(),
});
export type AgentPlanRequest = z.infer<typeof AgentPlanRequestSchema>;

/**
 * Validation/resolution of a plan. `resolved` has the same shape as `plan.ops` with every ClipRef
 * reduced to `{id}` and every Time to seconds (null entries = op that could not be resolved, see
 * `unresolved`). `preview_es` has one line per op.
 */
/** Sprint 5: one option of a plan choice; picking it inserts an op and/or patches an export. */
export const PlanChoiceOptionSchema = z.object({
  id: AspectFitSchema,
  label_es: z.string(),
  /** Op to insert (e.g. the reframe) before index `before`. */
  insert: z.object({ before: z.number().int().min(0), op: EditOpSchema }).optional(),
  patch: z.object({ index: z.number().int().min(0), aspect_fit: AspectFitSchema }).optional(),
});
export type PlanChoiceOption = z.infer<typeof PlanChoiceOptionSchema>;

/** Sprint 5: a question the api leaves in the plan (e.g. how to frame horizontal -> 9:16). */
export const PlanChoiceSchema = z.object({
  id: z.string(),
  question_es: z.string(),
  options: z.array(PlanChoiceOptionSchema).min(2),
});
export type PlanChoice = z.infer<typeof PlanChoiceSchema>;

export const AgentPlanValidationSchema = z.object({
  ok: z.boolean(),
  plan: EditPlanSchema.nullable(),
  resolved: z.array(EditOpSchema.nullable()),
  preview_es: z.array(z.string()),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  errors: z.array(z.string()).default([]),
  /** Sprint 5: ops the api inserted while expanding the plan (e.g. reframe before a 9:16 export). */
  added: z.array(z.object({ index: z.number().int(), reason_es: z.string() })).default([]),
  /** Sprint 5: pending choices (the affected op stays in `unresolved` until one is picked). */
  choices: z.array(PlanChoiceSchema).default([]),
});
export type AgentPlanValidation = z.infer<typeof AgentPlanValidationSchema>;

/** POST /api/agent/apply -> JobAccepted (job agent.apply). `ops` = confirmed subset (indexes). */
export const AgentApplyRequestSchema = z.object({
  planId: z.string().min(1),
  ops: z.array(z.int().nonnegative()).optional(),
  /**
   * Ops with the params the user edited inline (same order and length as plan.ops). The api
   * validates each one with EditOpSchema, resolves them again, recomputes preview/risks and stores
   * them as the plan's final ops before queuing agent.apply.
   */
  edited_ops: z.array(z.unknown()).max(EDIT_PLAN_MAX_OPS).optional(),
  /** Playhead (seconds) for a Time "cursor" typed in an edited op. */
  cursor: z.number().nonnegative().optional(),
  /**
   * Destructive ops (delete_clip / export, ALWAYS_CONFIRM_OPS) the user confirmed with the separate
   * «Confirmar borrado/exportación» click. The api refuses (409 CONFIRM_REQUIRED) any delete/export
   * op it would run that is not listed here.
   */
  confirmedIndexes: z.array(z.int().nonnegative()).optional(),
});
export type AgentApplyRequest = z.infer<typeof AgentApplyRequestSchema>;

export const AgentApplyPayloadSchema = AgentApplyRequestSchema.omit({
  edited_ops: true,
  cursor: true,
  confirmedIndexes: true,
}).extend({
  projectId: z.string().min(1),
});
export type AgentApplyPayload = z.infer<typeof AgentApplyPayloadSchema>;

export const AgentApplyResultSchema = z.object({
  applied: z.int().nonnegative(),
  failed: z
    .object({
      index: z.int().nonnegative(),
      error: z.string(),
      /** Set when the op needs a model pack (the web opens the "Paquete requerido" dialog). */
      packRequired: PackRequiredBodySchema.optional(),
    })
    .optional(),
  undoSnapshotId: z.string(),
  /** Per applied op: index + short Spanish line + sub-job ids. */
  steps: z
    .array(
      z.object({
        index: z.int().nonnegative(),
        preview_es: z.string(),
        jobIds: z.array(z.string()).default([]),
        result: z.unknown().optional(),
      }),
    )
    .default([]),
});
export type AgentApplyResult = z.infer<typeof AgentApplyResultSchema>;

/** Stored plan (SQLite agent_plans) + validation; answer of POST /api/agent/plan. */
export const AgentPlanRecordSchema = AgentPlanValidationSchema.extend({
  id: z.string().min(1),
  projectId: z.string().min(1),
  command: z.string(),
  status: AgentPlanStatusSchema,
  created_at: z.string(),
  model: z.string().nullish(),
  route: z.enum(["deterministic", "llm"]).nullish(),
  latency_ms: z.number().nullish(),
  attempts: z.number().nullish(),
  warnings: z.array(z.string()).default([]),
  /** Set once applied (POST /api/agent/plans/:id/undo restores it). */
  undoSnapshotId: z.string().nullish(),
  applyJobId: z.string().nullish(),
  /** Result of the last agent.apply. */
  applyResult: AgentApplyResultSchema.nullish(),
  /** Set by POST /api/agent/plans/:id/undo (the plan goes back to "proposed"). */
  undoneAt: z.string().nullish(),
  /** True once POST /api/agent/apply stored the user's inline edits (`edited_ops`). */
  edited: z.boolean().optional(),
  /**
   * Content hash (projectContentHash) and updatedAt of the project right after agent.apply. The
   * undo compares them with the current project: changed -> 409 PROJECT_CHANGED unless force.
   */
  postApplyHash: z.string().nullish(),
  postApplyUpdatedAt: z.string().nullish(),
});
export type AgentPlanRecord = z.infer<typeof AgentPlanRecordSchema>;

/**
 * POST /api/agent/plans/:id/undo. Restores the project saved before agent.apply. When the project
 * changed after the apply (other edits) it answers 409 PROJECT_CHANGED unless `force: true`.
 * Undo never deletes files: exported videos and media created by the plan stay on disk.
 */
export const AgentUndoRequestSchema = z.object({
  undoSnapshotId: z.string().min(1).optional(),
  force: z.boolean().optional(),
});
export type AgentUndoRequest = z.infer<typeof AgentUndoRequestSchema>;

/** GET /api/agent/status (workers proxy + pack state). */
export const AgentStatusSchema = z.object({
  workers: z.boolean(),
  ollama: z.boolean(),
  model: z.string().nullable(),
  models_installed: z.array(z.string()),
  ready: z.boolean(),
  gpu_mode: z.string().nullish(),
  pack: z
    .object({ id: z.string(), installed: z.boolean(), name_es: z.string().optional() })
    .nullable(),
  /** Spanish hint when something is missing (install Ollama / download the model). */
  hint_es: z.string().nullish(),
  /** The model is already in memory (Ollama /api/ps): false = the first call has to load it. */
  loaded: z.boolean().optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** POST /api/agent/bugreport. */
export const AgentBugreportRequestSchema = z.object({
  title: z.string().max(200).optional(),
  steps_text: z.string().max(20_000).default(""),
  breadcrumbs: z.array(z.unknown()).max(500).default([]),
  errors: z.array(z.unknown()).max(200).default([]),
  /** Appends the markdown to storage/reports/<reportId>/reporte.md when given. */
  reportId: z.string().min(1).optional(),
  /** Model to draft with (Ajustes → «Asistente local»; default AGENT_MODEL). */
  model: z.string().min(1).optional(),
});
export type AgentBugreportRequest = z.infer<typeof AgentBugreportRequestSchema>;

/** POST /api/agent/eval -> job agent.eval (result = storage/run/agent-eval.json). */
export const AgentEvalRequestSchema = z.object({
  models: z.array(z.string().min(1)).max(10).optional(),
  dataset: z.enum(["golden", "all"]).default("golden"),
  /** Sprint 5: quick = AGENT_EVAL_QUICK_N deterministic examples; full = the whole dataset. */
  mode: z.enum(["quick", "full"]).default("quick"),
});
export type AgentEvalRequest = z.infer<typeof AgentEvalRequestSchema>;

/** Examples of the quick «Evaluar modelos» run (round-robin by first op, sorted by id). */
export const AGENT_EVAL_QUICK_N = 20;

/** Relative to STORAGE_DIR. */
export const AGENT_EVAL_RESULT_PATH = "run/agent-eval.json";

export const AgentBugreportResponseSchema = z.object({
  markdown_es: z.string(),
  source: z.enum(["llm", "template"]),
  reportId: z.string().optional(),
});
export type AgentBugreportResponse = z.infer<typeof AgentBugreportResponseSchema>;
