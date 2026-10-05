// Shared zod building blocks for template props. Browser-safe (bundled by Remotion's webpack):
// only `zod` may be imported here, never node:* or @studio/shared runtime code.
import { z } from "zod";

/** Remotion Studio shows a color picker for strings described with this brand. */
export const REMOTION_COLOR_BRAND = "__remotion-color";
/** Remotion Studio shows a textarea for strings described with this brand. */
export const REMOTION_TEXTAREA_BRAND = "__remotion-textarea";

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/]+\)$/i;
const NAMED = /^[a-z]{3,20}$/i;

/** Accepts #rgb(a), #rrggbb(aa), rgb()/rgba()/hsl()/hsla(), CSS named colors and "transparent". */
export function isColor(value: string): boolean {
  return HEX.test(value) || FN.test(value) || NAMED.test(value);
}

/** Color prop: validated, exposed as JSON Schema `format: "color"` and as a picker in Studio. */
export function color(title: string) {
  return z
    .string()
    .refine(isColor, { message: "Color inválido" })
    .meta({ title })
    .describe(REMOTION_COLOR_BRAND);
}

/** Multi-line text prop (textarea in Studio and in the dashboard form). */
export function textarea(title: string) {
  return z.string().max(2000).meta({ title }).describe(REMOTION_TEXTAREA_BRAND);
}

export function text(title: string, max = 200) {
  return z.string().max(max).meta({ title });
}

/** Media URL resolved by the api from MotionSpec.media (http://127.0.0.1:3001/files/...). */
export function mediaSrc(title: string) {
  return z.string().meta({ title, format: "uri" }).optional();
}

/** Google Fonts bundled through @remotion/google-fonts (see src/fonts.ts). */
export const FONT_FAMILIES = [
  "Inter",
  "Montserrat",
  "Poppins",
  "Roboto",
  "Oswald",
  "Playfair Display",
  "Bebas Neue",
  "Anton",
  "Archivo Black",
  "Bangers",
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export function fontFamily(defaultFont: FontFamily) {
  return z.enum(FONT_FAMILIES).meta({ title: "Tipografía" }).default(defaultFont);
}

export const FONT_WEIGHTS = ["400", "700", "900"] as const;
export const fontWeight = (def: (typeof FONT_WEIGHTS)[number]) =>
  z.enum(FONT_WEIGHTS).meta({ title: "Grosor" }).default(def);

/** Optional background: a color, or "transparent" for alpha output (webm/prores). */
export const background = (def: string) => color("Fondo").default(def);

export const DIRECTIONS = ["from-left", "from-right", "from-top", "from-bottom"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Safe-area margins in % of the frame (UI of TikTok/Reels/YouTube overlays the edges). */
export const SafeAreaSchema = z
  .object({
    top: z.number().min(0).max(45),
    bottom: z.number().min(0).max(45),
    left: z.number().min(0).max(45),
    right: z.number().min(0).max(45),
  })
  .meta({ title: "Zona segura (%)" });
export type SafeArea = z.infer<typeof SafeAreaSchema>;

/** Keys injected by the render pipeline (see src/props.ts); never part of template schemas. */
export interface RenderMetaProps {
  __width?: number;
  __height?: number;
  __fps?: number;
  __durationInFrames?: number;
  /** "system" skips Google Fonts downloads (offline PCs). */
  __fontMode?: "google" | "system";
}

/**
 * Sprint 2: object track in COMPOSITION space (the api maps the TrackFile through the video clip:
 * `t` = seconds from frame 0, boxes in fractions 0..1 of the composition, x,y = top-left). Mirrors
 * @studio/shared TrackFileSchema; filled by the api (motion.render with a clip `trackRef`).
 */
export const TrackPropSchema = z
  .object({
    version: z.literal(1).default(1),
    fps: z.number().positive(),
    frames: z.array(
      z.object({
        t: z.number(),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        conf: z.number().optional(),
      }),
    ),
    smoothed: z.boolean().optional(),
    source: z.object({ assetId: z.string(), method: z.string() }).optional(),
  })
  .meta({ title: "Seguimiento (lo completa la api)" });
export type TrackProp = z.infer<typeof TrackPropSchema>;

export const TRACK_ANCHORS = ["center", "top", "bottom"] as const;

/** Optional follow-a-track props shared by lower-third and animated-captions. */
export const trackProps = {
  track: TrackPropSchema.optional(),
  trackAnchor: z.enum(TRACK_ANCHORS).meta({ title: "Ancla del seguimiento" }).optional(),
  trackOffset: z
    .object({ x: z.number(), y: z.number() })
    .meta({ title: "Desplazamiento (fracción del cuadro)" })
    .optional(),
};
