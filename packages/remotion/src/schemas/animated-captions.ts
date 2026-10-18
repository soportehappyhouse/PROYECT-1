import { z } from "zod";
import {
  ADVANCED_PROP,
  choice,
  color,
  type Filled,
  FONT_WEIGHTS,
  kitColor,
  kitFontFamily,
  mediaSrc,
  SafeAreaSchema,
  background,
  trackProps,
} from "./common.js";

/** x/y/width/height in % of the composition. */
export const VideoRectSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100),
  })
  .meta({ title: "Rectángulo del video (%)" });
export type VideoRect = z.infer<typeof VideoRectSchema>;

/** Mirrors @studio/shared TranscriptSchema (faster-whisper output, times in seconds). */
export const TranscriptWordSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  word: z.string(),
  probability: z.number().min(0).max(1).optional(),
});
export const TranscriptSegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
  words: z.array(TranscriptWordSchema).optional(),
});
export const TranscriptLikeSchema = z.object({
  language: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  segments: z.array(TranscriptSegmentSchema),
});
export type TranscriptLike = z.infer<typeof TranscriptLikeSchema>;

/** Remotion `Caption` (@remotion/captions), times in ms; `text` carries its leading space. */
export const CaptionSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  timestampMs: z.number().nullable().default(null),
  confidence: z.number().nullable().default(null),
});

export const CAPTION_STYLES = ["highlight", "karaoke", "pop", "box"] as const;
export const CAPTION_POSITIONS = ["bottom", "center", "top"] as const;

/** Spanish demo transcript (shown in Studio / dashboard previews). */
export const DEMO_TRANSCRIPT: TranscriptLike = {
  language: "es",
  durationSec: 4.6,
  segments: [
    {
      start: 0.2,
      end: 2.2,
      text: "Hola, bienvenidos a Studio.",
      words: [
        { start: 0.2, end: 0.6, word: " Hola," },
        { start: 0.7, end: 1.3, word: " bienvenidos" },
        { start: 1.35, end: 1.5, word: " a" },
        { start: 1.55, end: 2.2, word: " Studio." },
      ],
    },
    {
      start: 2.4,
      end: 4.5,
      text: "Así se ven los subtítulos animados.",
      words: [
        { start: 2.4, end: 2.7, word: " Así" },
        { start: 2.75, end: 2.9, word: " se" },
        { start: 2.95, end: 3.2, word: " ven" },
        { start: 3.25, end: 3.4, word: " los" },
        { start: 3.45, end: 3.95, word: " subtítulos" },
        { start: 4.0, end: 4.5, word: " animados." },
      ],
    },
  ],
};

export const animatedCaptionsSchema = z.object({
  transcript: TranscriptLikeSchema.meta({ title: "Transcripción (palabra a palabra)" }).default(
    DEMO_TRANSCRIPT,
  ),
  /** Alternative input: Remotion Caption[]; takes precedence over `transcript` when non-empty. */
  captions: z
    .array(CaptionSchema)
    .meta({ title: "Subtítulos (formato Remotion)", [ADVANCED_PROP]: true })
    .optional(),
  style: choice(CAPTION_STYLES, "Estilo").default("highlight"),
  position: choice(CAPTION_POSITIONS, "Posición").default("bottom"),
  /** Absent = kit `font.caption` (Montserrat without a kit). */
  fontFamily: kitFontFamily("caption"),
  fontWeight: choice(FONT_WEIGHTS, "Grosor").default("900"),
  fontSize: z.number().min(16).max(300).meta({ title: "Tamaño (px a 1080 de ancho)" }).default(88),
  uppercase: z.boolean().meta({ title: "Mayúsculas" }).default(true),
  textColor: kitColor("Color del texto", "text"),
  highlightColor: kitColor("Color de resaltado", "accent"),
  boxColor: color("Color de la caja").default("#e13238"),
  strokeColor: kitColor("Color del borde", "text_outline"),
  strokeWidth: z.number().min(0).max(40).meta({ title: "Grosor del borde" }).default(10),
  combineWithinMs: z
    .number()
    .min(0)
    .max(5000)
    .meta({ title: "Agrupar palabras dentro de (ms)", [ADVANCED_PROP]: true })
    .default(900),
  /** When absent, computed from the aspect ratio (9:16 leaves room for TikTok/Reels UI). */
  safeArea: SafeAreaSchema.meta({ title: "Zona segura (%)", [ADVANCED_PROP]: true }).optional(),
  /**
   * Rect of the video inside the canvas (% of the canvas). With a vertical clip pillarboxed in a
   * 16:9 project the captions are laid out, wrapped and sized inside it instead of the canvas.
   */
  videoRect: VideoRectSchema.optional(),
  videoSrc: mediaSrc("Video de fondo"),
  background: background("transparent"),
  /** Sprint 2: follow a track (each caption page is centered on the anchor point + offset). */
  ...trackProps,
});
export type AnimatedCaptionsProps = Filled<
  z.infer<typeof animatedCaptionsSchema>,
  "fontFamily" | "textColor" | "highlightColor" | "strokeColor"
>;
