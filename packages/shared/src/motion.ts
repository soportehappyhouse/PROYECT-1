import { z } from "zod";

/** See docs/trabajo/fuentes-motion.md §5 for the design rationale of this contract. */
export const MotionEngineIdSchema = z.enum(["remotion", "motion-canvas", "ffmpeg-lottie"]);
export type MotionEngineId = z.infer<typeof MotionEngineIdSchema>;

/** Built-in Remotion template ids (= <Composition id> in @studio/remotion). */
export const REMOTION_TEMPLATE_IDS = [
  "title-card",
  "lower-third",
  "animated-captions",
  "transition",
  "audio-visualizer",
  "lottie-overlay",
  "end-screen",
  "progress-bar",
  "kinetic-typography",
] as const;

export const MotionOutputFormatSchema = z.enum([
  "mp4-h264", // no alpha
  "webm-vp9-alpha", // yuva420p — default for overlays inside the editor
  "prores-4444", // .mov with alpha — for external editors
  "png-sequence", // folder of PNGs with alpha
]);
export type MotionOutputFormat = z.infer<typeof MotionOutputFormatSchema>;

export const ALPHA_OUTPUT_FORMATS: readonly MotionOutputFormat[] = [
  "webm-vp9-alpha",
  "prores-4444",
  "png-sequence",
];

/** Media referenced by key from `props` (e.g. { captions: {...}, music: {...} }). */
export const MotionMediaRefSchema = z.object({
  kind: z.enum(["video", "audio", "image", "lottie", "captions"]),
  /** Relative to STORAGE_DIR; adapters expose it over HTTP (/files/...) to headless browsers. */
  path: z.string(),
});
export type MotionMediaRef = z.infer<typeof MotionMediaRefSchema>;

/** Versioned, serializable request to render a motion graphic (stored as job payload). */
export const MotionSpecSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Preferred engine; when absent the registry picks the first one supporting the template. */
  engine: MotionEngineIdSchema.optional(),
  /** Template id inside the engine (e.g. "title-card", "lower-third"). */
  template: z.string().min(1),
  /** Template props; validated by the engine against the template's own zod schema. */
  props: z.record(z.string(), z.unknown()).default({}),
  media: z.record(z.string(), MotionMediaRefSchema).optional(),
  durationSec: z.number().positive(),
  fps: z.number().int().positive().default(30),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  format: MotionOutputFormatSchema.default("mp4-h264"),
  /** Overlays have no audio by default; audio is mixed later with FFmpeg. */
  includeAudio: z.boolean().default(false),
  seed: z.number().int().optional(),
});
export type MotionSpec = z.infer<typeof MotionSpecSchema>;
export type MotionSpecInput = z.input<typeof MotionSpecSchema>;

export const MotionTemplateInfoSchema = z.object({
  engine: MotionEngineIdSchema,
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** JSON Schema of the props (z.toJSONSchema) so the dashboard can render a form. */
  propsSchema: z.unknown().optional(),
  /** Default props, shown/edited in the Inspector panel. */
  defaultProps: z.record(z.string(), z.unknown()),
  defaultDurationSec: z.number().positive(),
  supportsAlpha: z.boolean(),
  /** Grouping in the Motion panel (e.g. "Títulos", "Subtítulos"). */
  category: z.string().optional(),
  /** Natural canvas size of the template. */
  defaultSize: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  /** Still composition for previews (Remotion: `<id>-thumb`, rendered at `frame`). */
  thumbnail: z
    .object({ compositionId: z.string(), frame: z.number().int().nonnegative() })
    .optional(),
});
export type MotionTemplateInfo = z.infer<typeof MotionTemplateInfoSchema>;

/** Project/clip that a motion render belongs to; the api links the result to the clip. */
export const MotionRenderTargetSchema = z.object({
  projectId: z.string().min(1),
  clipId: z.string().min(1),
});
export type MotionRenderTarget = z.infer<typeof MotionRenderTargetSchema>;

/**
 * Body of POST /api/motion/render: a MotionSpec plus an optional `target`. With a target the
 * `motion.render` job sets `clip.renderedAssetId` in the stored project when it finishes.
 */
export const MotionRenderRequestSchema = MotionSpecSchema.extend({
  target: MotionRenderTargetSchema.optional(),
});
export type MotionRenderRequest = z.infer<typeof MotionRenderRequestSchema>;
export type MotionRenderRequestInput = z.input<typeof MotionRenderRequestSchema>;
