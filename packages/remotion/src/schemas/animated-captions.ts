import { z } from "zod";
import {
  color,
  fontFamily,
  fontWeight,
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
  captions: z.array(CaptionSchema).meta({ title: "Captions (formato Remotion)" }).optional(),
  style: z.enum(CAPTION_STYLES).meta({ title: "Estilo" }).default("highlight"),
  position: z.enum(CAPTION_POSITIONS).meta({ title: "Posición" }).default("bottom"),
  fontFamily: fontFamily("Montserrat"),
  fontWeight: fontWeight("900"),
  fontSize: z.number().min(16).max(300).meta({ title: "Tamaño (px a 1080 de ancho)" }).default(88),
  uppercase: z.boolean().meta({ title: "Mayúsculas" }).default(true),
  textColor: color("Color del texto").default("#ffffff"),
  highlightColor: color("Color de resaltado").default("#ffd400"),
  boxColor: color("Color de la caja").default("#e13238"),
  strokeColor: color("Color del borde").default("#000000"),
  strokeWidth: z.number().min(0).max(40).meta({ title: "Grosor del borde" }).default(10),
  combineWithinMs: z
    .number()
    .min(0)
    .max(5000)
    .meta({ title: "Agrupar palabras dentro de (ms)" })
    .default(900),
  /** When absent, computed from the aspect ratio (9:16 leaves room for TikTok/Reels UI). */
  safeArea: SafeAreaSchema.optional(),
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
export type AnimatedCaptionsProps = z.infer<typeof animatedCaptionsSchema>;
