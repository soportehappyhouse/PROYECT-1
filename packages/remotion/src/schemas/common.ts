// Shared zod building blocks for template props. Browser-safe (bundled by Remotion's webpack):
// only `zod` may be imported here, never node:* or @studio/shared runtime code.
import { z } from "zod";

/** Props that the brand kit (or the legacy default) always fills before the component renders. */
export type Filled<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

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

/** OFL families bundled in public/fonts (see src/fonts.ts; = BUNDLED_FONT_FAMILIES of shared). */
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

/** Family names are proper nouns: shown as is. */
const FONT_LABELS: Record<string, string> = Object.fromEntries(FONT_FAMILIES.map((f) => [f, f]));

export function fontFamily(defaultFont: FontFamily) {
  return z
    .enum(FONT_FAMILIES)
    .meta({ title: "Tipografía", [ENUM_LABELS]: FONT_LABELS })
    .default(defaultFont);
}

/**
 * Sprint 6 M2: JSON Schema keywords read by the web Motion form.
 * - ENUM_LABELS: Spanish label of each enum value (the raw ids are never shown).
 * - ADVANCED_PROP: the field goes in the folded «Avanzado» section.
 * - TOKEN_PROP: absent = taken from the brand kit (`font.title`, `color.accent`…); the form
 *   shows «Del kit» until the user sets a value (explicit props still win).
 */
export const ENUM_LABELS = "x-enum-labels";
export const ADVANCED_PROP = "x-advanced";
export const TOKEN_PROP = "x-token";

/**
 * Spanish labels of every enum value used by the templates (UI_ENGLISH_DENYLIST never shows).
 * One dictionary so the same value reads the same everywhere.
 */
export const OPTION_LABELS_ES: Record<string, string> = {
  // positions
  "bottom-left": "Abajo a la izquierda",
  "bottom-center": "Abajo al centro",
  "bottom-right": "Abajo a la derecha",
  "top-left": "Arriba a la izquierda",
  "top-right": "Arriba a la derecha",
  top: "Arriba",
  bottom: "Abajo",
  center: "Al centro",
  left: "A la izquierda",
  // lower-third styles
  bar: "Barra",
  box: "Caja",
  underline: "Subrayado",
  split: "Dividido",
  // animations
  slide: "Deslizar",
  fade: "Fundido",
  wipe: "Barrido",
  pop: "Rebote",
  none: "Sin animación",
  "fade-up": "Subir con fundido",
  typewriter: "Máquina de escribir",
  boxed: "En caja",
  slam: "Golpe",
  "slide-up": "Subir",
  rotate: "Girar",
  stagger: "Letra por letra",
  flip: "Voltear",
  // captions
  highlight: "Resaltar la palabra",
  karaoke: "Karaoke",
  // misc
  word: "Palabra",
  phrase: "Frase",
  youtube: "Con recuadros (YouTube)",
  minimal: "Simple",
  bars: "Barras",
  wave: "Onda",
  "mirror-bars": "Barras espejadas",
  linear: "Lineal",
  spring: "Elástica",
  cover: "Llenar el cuadro",
  contain: "Mostrar entero",
  "from-left": "Desde la izquierda",
  "from-right": "Desde la derecha",
  "from-top": "Desde arriba",
  "from-bottom": "Desde abajo",
  "400": "Normal",
  "700": "Negrita",
  "900": "Extra negrita",
};

/** Enum prop with Spanish labels (from OPTION_LABELS_ES). */
export function choice<const T extends readonly [string, ...string[]]>(values: T, title: string) {
  const labels = Object.fromEntries(values.map((v) => [v, OPTION_LABELS_ES[v] ?? v]));
  return z.enum(values).meta({ title, [ENUM_LABELS]: labels });
}

/** Font prop filled from the brand kit role when absent (Sprint 6 M2). */
export function kitFontFamily(role: "title" | "caption" | "body" | "display") {
  return z
    .enum(FONT_FAMILIES)
    .meta({ title: "Tipografía", [ENUM_LABELS]: FONT_LABELS, [TOKEN_PROP]: `font.${role}` })
    .optional();
}

/** Color prop filled from the brand kit when absent (Sprint 6 M2). */
export function kitColor(title: string, token: "text" | "text_outline" | "accent" | "plate") {
  return z
    .string()
    .refine(isColor, { message: "Color inválido" })
    .meta({ title, [TOKEN_PROP]: `color.${token}` })
    .describe(REMOTION_COLOR_BRAND)
    .optional();
}

/** Brand-kit tokens injected by the api as `__design` (mirror of shared TemplateDesign). */
export interface DesignMeta {
  font: Record<"title" | "caption" | "body" | "display", { family: FontFamily; weight: number }>;
  color: { text: string; text_outline: string; accent: string; plate: string; palette: string[] };
  safe_zone: { top: number; bottom: number; left: number; right: number };
  motion: { enter_ms: number; exit_ms: number; transition_s: number };
  caption: { size_px_1080: number; min_size_px_1080: number; outline_pct_size: number };
}

/** Caption page computed node-side by shared paginateCaptions (ms; `lines` = word counts per line). */
export interface CaptionPageMeta {
  startMs: number;
  endMs: number;
  lines: number[];
  tokens: { text: string; fromMs: number; toMs: number }[];
}

export const FONT_WEIGHTS = ["400", "700", "900"] as const;
export const fontWeight = (def: (typeof FONT_WEIGHTS)[number]) =>
  z
    .enum(FONT_WEIGHTS)
    .meta({
      title: "Grosor",
      [ENUM_LABELS]: { "400": "Normal", "700": "Negrita", "900": "Extra negrita" },
    })
    .default(def);

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
  /** Kept for old payloads; ignored since Sprint 6 (fonts are bundled, never downloaded). */
  __fontMode?: "google" | "system";
  /** Sprint 6 M2: brand-kit tokens (absent = the old built-in defaults). */
  __design?: DesignMeta;
  /** Sprint 6 M2: animated-captions pages paginated by the design rules (absent = old grouping). */
  __pages?: CaptionPageMeta[];
}

/**
 * JSON Schema keyword of props filled by the api, never by the user: forms (web Motion panel)
 * must not render them. Kept by z.toJSONSchema (metadata is copied to the output).
 */
export const INTERNAL_PROP = "x-internal";

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
  .meta({ title: "Seguimiento (lo completa la api)", [INTERNAL_PROP]: true });
export type TrackProp = z.infer<typeof TrackPropSchema>;

export const TRACK_ANCHORS = ["center", "top", "bottom"] as const;

/**
 * Optional follow-a-track props shared by lower-third and animated-captions. All three are filled
 * by the api from the clip's `trackRef` (motion.render), so they are marked internal: the web
 * motion form hides them (anchor/offset are edited in the inspector «Seguimiento»).
 */
export const trackProps = {
  track: TrackPropSchema.optional(),
  trackAnchor: z
    .enum(TRACK_ANCHORS)
    .meta({ title: "Ancla del seguimiento", [INTERNAL_PROP]: true })
    .optional(),
  trackOffset: z
    .object({ x: z.number(), y: z.number() })
    .meta({ title: "Desplazamiento (fracción del cuadro)", [INTERNAL_PROP]: true })
    .optional(),
};
