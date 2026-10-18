import { z } from "zod";
import { IdSchema, SecondsSchema, TimestampSchema } from "./common.js";
import { STYLE_TRANSITION_TYPES } from "./style.js";

/**
 * Sprint 6 M2 (docs/trabajo/sprint6-contratos.md «Contratos compartidos»): design tokens and the
 * user's single brand kit. Captions (ASS + Remotion), motion templates and style presets read
 * these values instead of loose props; every number here is an editable token (never hardcode a
 * size, color, font, margin or text duration elsewhere). The logic (contrast, layout, caption
 * pagination, checks and auto-fixes) lives in design-rules.ts (M2).
 */

export const DESIGN_ASPECTS = ["9:16", "1:1", "16:9"] as const;
export const DesignAspectSchema = z.enum(DESIGN_ASPECTS);
export type DesignAspect = z.infer<typeof DesignAspectSchema>;

/** #rrggbb or #rrggbbaa. */
export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i, { error: "Color inválido: usá #rrggbb o #rrggbbaa" });

/**
 * OFL families bundled with Studio (packages/remotion/public/fonts/<Family>/): the same list as
 * FONT_FAMILIES of @studio/remotion (M2 keeps both equal with a test). No render downloads fonts.
 */
export const BUNDLED_FONT_FAMILIES = [
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
export type BundledFontFamily = (typeof BUNDLED_FONT_FAMILIES)[number];
export const BUNDLED_FONT_WEIGHTS = [400, 700, 900] as const;
export type BundledFontWeight = (typeof BUNDLED_FONT_WEIGHTS)[number];

/**
 * Weights that really exist as a TTF of each bundled family (audit S6 E1). Display families have
 * one face (400): asking them for 700/900 must reuse that face, never a synthetic bold (libass
 * emboldens when the requested weight is ≥ 150 above the face; browsers do the same). Oswald's
 * variable axis stops at 700. Kept equal to the files and manifest.json by a test in remotion.
 */
export const BUNDLED_FONT_FACES: Record<BundledFontFamily, readonly BundledFontWeight[]> = {
  Inter: [400, 700, 900],
  Montserrat: [400, 700, 900],
  Poppins: [400, 700, 900],
  Roboto: [400, 700, 900],
  Oswald: [400, 700],
  "Playfair Display": [400, 700, 900],
  "Bebas Neue": [400],
  Anton: [400],
  "Archivo Black": [400],
  Bangers: [400],
};

export function isBundledFontFamily(family: string): family is BundledFontFamily {
  return (BUNDLED_FONT_FAMILIES as readonly string[]).includes(family);
}

/**
 * Weight that is actually drawn for `family` at `weight`: the heaviest bundled face ≤ the request
 * (the lightest one when none is), so no renderer fakes a bold. Non-bundled families keep it.
 */
export function bundledFontWeight(family: string, weight: number): number {
  if (!isBundledFontFamily(family)) return weight;
  const faces = BUNDLED_FONT_FACES[family];
  return [...faces].reverse().find((w) => w <= weight) ?? faces[0]!;
}

/** TTF file name of the face drawn for `family` at `weight` (`<Family sin espacios>-<peso>.ttf`). */
export function bundledFontFileName(family: BundledFontFamily, weight: number): string {
  return `${family.replace(/ /g, "")}-${bundledFontWeight(family, weight)}.ttf`;
}
/** Folder of the bundled fonts, relative to the repo root (served by GET /fonts/*, libass fontsdir). */
export const FONTS_DIR_REL = "packages/remotion/public/fonts";

export const FontTokenSchema = z
  .object({
    family: z.enum(BUNDLED_FONT_FAMILIES),
    weight: z.union([z.literal(400), z.literal(700), z.literal(900)]),
  })
  .strict();
export type FontToken = z.infer<typeof FontTokenSchema>;

const pct = () => z.number().min(0).max(45);
/** Safe zone in % of the canvas (same convention as SafeAreaPercent in frame.ts). */
export const SafeZoneSchema = z
  .object({ top: pct(), bottom: pct(), left: pct(), right: pct() })
  .strict();
export type SafeZone = z.infer<typeof SafeZoneSchema>;

/** Hard caption rules (docs/trabajo/fuentes-sprint6.md §2.3); all editable from the kit. */
export const CaptionRulesSchema = z
  .object({
    max_lines: z.union([z.literal(1), z.literal(2)]).default(2),
    max_chars_line: z
      .object({
        "9:16": z.int().min(12).max(60).default(30),
        "1:1": z.int().min(12).max(60).default(34),
        "16:9": z.int().min(12).max(60).default(42),
      })
      .strict(),
    /** Default size, % of the short side of the canvas (1080 → 65 px). */
    size_pct_short_side: z.number().min(3).max(12).default(6),
    /** Hard minimum, % of the short side (1080 → 49 px). */
    min_size_pct_short_side: z.number().min(3).max(10).default(4.5),
    /** Outline width, % of the font size. */
    outline_pct_size: z.number().min(0).max(20).default(8),
    /** Minimum alpha of the box when the style uses a box instead of an outline. */
    box_min_alpha: z.number().min(0).max(1).default(0.6),
    /** Minimum contrast ratio between text and its outline/box (WCAG formula). */
    min_contrast: z.number().min(3).max(21).default(7),
    min_duration_s: z.number().min(0.3).max(2).default(0.83),
    max_duration_s: z.number().min(2).max(10).default(7),
    /** Reading speed limit, characters per second. */
    max_cps: z.number().min(10).max(30).default(17),
    /** A pause this long starts a new caption page. */
    page_break_pause_ms: z.int().min(100).max(2000).default(300),
  })
  .strict();
export type CaptionRules = z.infer<typeof CaptionRulesSchema>;

/** On-screen titles: duration = max(min_duration_s, s_per_word × words + extra_s). */
export const TitleRulesSchema = z
  .object({
    min_duration_s: z.number().min(0.5).max(10).default(1.5),
    s_per_word: z.number().min(0.1).max(1).default(0.35),
    extra_s: z.number().min(0).max(3).default(0.7),
    lower_third_min_s: z.number().min(1).max(15).default(3),
  })
  .strict();
export type TitleRules = z.infer<typeof TitleRulesSchema>;

export const MotionTokensSchema = z
  .object({
    transition: z.enum(STYLE_TRANSITION_TYPES).default("fade"),
    transition_s: z.number().min(0.1).max(2).default(0.3),
    enter_ms: z.int().min(100).max(1500).default(350),
    exit_ms: z.int().min(100).max(1500).default(250),
    easing: z.enum(["ease-out", "ease-in-out", "linear", "spring"]).default("ease-out"),
  })
  .strict();
export type MotionTokens = z.infer<typeof MotionTokensSchema>;

export const ColorTokensSchema = z
  .object({
    text: HexColorSchema,
    text_outline: HexColorSchema,
    accent: HexColorSchema,
    /** Box behind the text (with alpha). */
    plate: HexColorSchema,
    palette: z.array(HexColorSchema).min(2).max(8),
  })
  .strict();
export type ColorTokens = z.infer<typeof ColorTokensSchema>;

export const DesignTokensSchema = z
  .object({
    version: z.literal(1),
    color: ColorTokensSchema,
    font: z
      .object({
        title: FontTokenSchema,
        caption: FontTokenSchema,
        body: FontTokenSchema,
        display: FontTokenSchema,
      })
      .strict(),
    caption: CaptionRulesSchema,
    title: TitleRulesSchema,
    safe_zone: z
      .object({ "9:16": SafeZoneSchema, "1:1": SafeZoneSchema, "16:9": SafeZoneSchema })
      .strict(),
    motion: MotionTokensSchema,
  })
  .strict();
export type DesignTokens = z.infer<typeof DesignTokensSchema>;
export type DesignTokensInput = z.input<typeof DesignTokensSchema>;

/**
 * Defaults. 9:16 safe zone = conservative Reels/TikTok/Shorts profile (15 % top, 35 % bottom,
 * 11 % sides): a guide to calibrate with screenshots of the user's phone, not an official spec.
 */
export const DEFAULT_DESIGN_TOKENS: DesignTokens = DesignTokensSchema.parse({
  version: 1,
  color: {
    text: "#FFFFFF",
    text_outline: "#000000",
    accent: "#FFD400",
    plate: "#000000B3",
    palette: ["#FFFFFF", "#000000", "#FFD400", "#FF3B6B"],
  },
  font: {
    title: { family: "Montserrat", weight: 900 },
    caption: { family: "Inter", weight: 900 },
    body: { family: "Inter", weight: 400 },
    display: { family: "Anton", weight: 400 },
  },
  caption: { max_chars_line: {} },
  title: {},
  safe_zone: {
    "9:16": { top: 15, bottom: 35, left: 11, right: 11 },
    "1:1": { top: 5, bottom: 8, left: 5, right: 5 },
    "16:9": { top: 5, bottom: 10, left: 5, right: 5 },
  },
  motion: {},
});

export const BrandLogoPositionSchema = z.enum([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
export type BrandLogoPosition = z.infer<typeof BrandLogoPositionSchema>;

/** The user's single brand kit (decision 2026-10-08: one kit, the user's channel). */
export const BrandKitSchema = z
  .object({
    id: z.literal("default"),
    name: z.string().trim().min(1).max(80),
    logo_asset_id: IdSchema.nullable(),
    logo_position: BrandLogoPositionSchema.default("top-right"),
    logo_opacity: z.number().min(0.2).max(1).default(0.9),
    /** Logo width, % of the canvas width. */
    logo_scale_pct: z.number().min(4).max(30).default(12),
    tokens: DesignTokensSchema,
    /** Safe zone calibrated over a screenshot of the user's phone. */
    calibration: z
      .object({
        aspect: DesignAspectSchema,
        screenshot_asset_id: IdSchema.optional(),
        calibrated_at: TimestampSchema,
      })
      .strict()
      .optional(),
    updated_at: TimestampSchema.optional(),
  })
  .strict();
export type BrandKit = z.infer<typeof BrandKitSchema>;
export type BrandKitInput = z.input<typeof BrandKitSchema>;

/** PUT /api/brand-kit: replaces only the fields sent (tokens as a whole); no defaults. */
export const BrandKitUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    logo_asset_id: IdSchema.nullable().optional(),
    logo_position: BrandLogoPositionSchema.optional(),
    logo_opacity: z.number().min(0.2).max(1).optional(),
    logo_scale_pct: z.number().min(4).max(30).optional(),
    tokens: DesignTokensSchema.optional(),
    calibration: BrandKitSchema.shape.calibration,
  })
  .strict();
export type BrandKitUpdate = z.infer<typeof BrandKitUpdateSchema>;

export const DEFAULT_BRAND_KIT: BrandKit = BrandKitSchema.parse({
  id: "default",
  name: "Mi canal",
  logo_asset_id: null,
  tokens: DEFAULT_DESIGN_TOKENS,
});

/** The 10 rules of the design checklist (criterion C2). */
export const DESIGN_RULE_IDS = [
  "caption.max_lines",
  "caption.chars_per_line",
  "caption.min_size",
  "caption.outline_or_box",
  "caption.contrast",
  "caption.safe_zone",
  "caption.timing",
  "title.safe_zone",
  "title.duration",
  "brand.consistency",
] as const;
export const DesignRuleIdSchema = z.enum(DESIGN_RULE_IDS);
export type DesignRuleId = z.infer<typeof DesignRuleIdSchema>;

/** hard = fixed automatically on generation/export; guide = warning only. */
export const DesignRuleSeveritySchema = z.enum(["hard", "guide"]);
export type DesignRuleSeverity = z.infer<typeof DesignRuleSeveritySchema>;

export interface DesignRuleDef {
  id: DesignRuleId;
  severity: DesignRuleSeverity;
  label_es: string;
  help_es: string;
}

export const DESIGN_RULES: readonly DesignRuleDef[] = [
  {
    id: "caption.max_lines",
    severity: "hard",
    label_es: "Subtítulos en 2 líneas como máximo",
    help_es: "Cada subtítulo ocupa una o dos líneas; nunca tres.",
  },
  {
    id: "caption.chars_per_line",
    severity: "hard",
    label_es: "Largo de línea",
    help_es: "Hasta 30 caracteres por línea en 9:16, 34 en 1:1 y 42 en 16:9 (ajustable en el kit).",
  },
  {
    id: "caption.min_size",
    severity: "hard",
    label_es: "Tamaño mínimo de letra",
    help_es: "La letra mide al menos el 4,5 % del lado corto del video.",
  },
  {
    id: "caption.outline_or_box",
    severity: "hard",
    label_es: "Contorno o caja",
    help_es: "El texto lleva contorno o una caja detrás para leerse sobre cualquier imagen.",
  },
  {
    id: "caption.contrast",
    severity: "hard",
    label_es: "Contraste",
    help_es: "El texto contrasta al menos 7:1 con su contorno o su caja.",
  },
  {
    id: "caption.safe_zone",
    severity: "hard",
    label_es: "Subtítulos en zona segura",
    help_es: "Los subtítulos quedan fuera de los botones y textos de la app (zona segura del kit).",
  },
  {
    id: "caption.timing",
    severity: "hard",
    label_es: "Tiempo de lectura",
    help_es: "Cada subtítulo dura entre 0,83 y 7 s y no pasa de 17 caracteres por segundo.",
  },
  {
    id: "title.safe_zone",
    severity: "hard",
    label_es: "Títulos en zona segura",
    help_es: "Títulos, rótulos y pantallas finales quedan adentro de la zona segura.",
  },
  {
    id: "title.duration",
    severity: "guide",
    label_es: "Duración de títulos",
    help_es: "Un título dura al menos 1,5 s (más 0,35 s por palabra); un rótulo, al menos 3 s.",
  },
  {
    id: "brand.consistency",
    severity: "guide",
    label_es: "Tipografías y colores del kit",
    help_es: "Se usan como mucho 2 tipografías y los colores del kit de marca.",
  },
];

export const DesignIssueSchema = z
  .object({
    rule: DesignRuleIdSchema,
    severity: DesignRuleSeveritySchema,
    target: z
      .object({
        kind: z.enum(["caption", "motion", "text"]),
        clipId: IdSchema.optional(),
        segmentIndex: z.int().nonnegative().optional(),
        t_s: SecondsSchema.optional(),
      })
      .strict(),
    message_es: z.string().max(300),
    autofix: z.boolean(),
    measured: z.number().optional(),
    limit: z.number().optional(),
  })
  .strict();
export type DesignIssue = z.infer<typeof DesignIssueSchema>;

/** POST /api/design/check. `fix` applies the automatic fixes (hard rules). */
export const DesignCheckRequestSchema = z
  .object({
    projectId: IdSchema,
    aspect: DesignAspectSchema.optional(),
    fix: z.boolean().default(false),
  })
  .strict();
export type DesignCheckRequest = z.infer<typeof DesignCheckRequestSchema>;

export const DesignCheckResultSchema = z.object({
  aspect: DesignAspectSchema,
  rules: z
    .array(z.object({ id: DesignRuleIdSchema, passed: z.boolean(), issues: z.int().nonnegative() }))
    .length(DESIGN_RULE_IDS.length),
  passed: z.int().min(0).max(DESIGN_RULE_IDS.length),
  issues: z.array(DesignIssueSchema),
  fixed: z.int().nonnegative(),
  /** With fix:true, the fixed project (the web pushes it as one undo step). */
  project: z.unknown().optional(),
  checkedAt: TimestampSchema,
});
export type DesignCheckResult = z.infer<typeof DesignCheckResultSchema>;

const px = () => z.number().nonnegative();
/** GET /api/design/tokens: tokens resolved for a canvas (pixels). */
export const ResolvedDesignSchema = z.object({
  aspect: DesignAspectSchema,
  canvas: z.object({ w: z.int().positive(), h: z.int().positive() }),
  tokens: DesignTokensSchema,
  safe_zone_px: z.object({ top: px(), bottom: px(), left: px(), right: px() }),
  caption_px: z.object({
    size: px(),
    min_size: px(),
    outline: px(),
    max_chars_line: z.int().positive(),
    max_lines: z.union([z.literal(1), z.literal(2)]),
  }),
});
export type ResolvedDesign = z.infer<typeof ResolvedDesignSchema>;

/** POST /api/motion/still -> image/png | image/jpeg (one frame, no full render). */
export const MotionStillRequestSchema = z
  .object({
    template: z.string().min(1),
    props: z.record(z.string(), z.unknown()).default({}),
    width: z.int().min(16).max(8192),
    height: z.int().min(16).max(8192),
    frame: z.int().nonnegative().optional(),
    t_s: SecondsSchema.optional(),
    format: z.enum(["png", "jpeg"]).default("png"),
    /** Apply the brand kit tokens to the props (explicit props still win). */
    brand: z.boolean().default(true),
    /** Video frame behind the template («cómo quedará»). */
    background_asset_id: IdSchema.optional(),
  })
  .strict();
export type MotionStillRequest = z.infer<typeof MotionStillRequestSchema>;
