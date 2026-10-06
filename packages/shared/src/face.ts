import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";
import { LicenceIdSchema } from "./consent.js";

/**
 * Sprint 4 (docs/trabajo/sprint4-contratos.md, M1): face detection on a frame and face swap
 * (FaceFusion 3.9.1 in the isolated tools/facefusion venv) with a registered Person's consent.
 */

/** Fractions 0..1 of the frame. */
export const FaceBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type FaceBox = z.infer<typeof FaceBoxSchema>;

/** POST /api/face/detect (`t` in seconds of the asset). */
export const FaceDetectRequestSchema = z.object({ assetId: IdSchema, t: SecondsSchema });
export type FaceDetectRequest = z.infer<typeof FaceDetectRequestSchema>;

export const DetectedFaceSchema = z.object({
  index: z.number().int().nonnegative(),
  box: FaceBoxSchema,
  score: z.number(),
});
export type DetectedFace = z.infer<typeof DetectedFaceSchema>;

export const FaceDetectResultSchema = z.object({
  t: SecondsSchema,
  width: z.number().int(),
  height: z.number().int(),
  framePath: z.string(),
  /** Sorted left to right. */
  faces: z.array(DetectedFaceSchema),
});
export type FaceDetectResult = z.infer<typeof FaceDetectResultSchema>;

export const FaceSwapperModelSchema = z.enum([
  "hyperswap_1a_256",
  "ghost_1_256",
  "inswapper_128_fp16",
]);
export type FaceSwapperModel = z.infer<typeof FaceSwapperModelSchema>;

/** The UI shows the licence next to each option. */
export const FACE_SWAPPER_INFO = {
  hyperswap_1a_256: {
    name_es: "HyperSwap 1a (256 px, recomendado)",
    licence: "ResearchRAIL",
    pack: "faceswap",
  },
  ghost_1_256: { name_es: "Ghost 1 (256 px)", licence: "Apache-2.0", pack: "faceswap-extra" },
  inswapper_128_fp16: {
    name_es: "InSwapper (128 px, rápido)",
    licence: "No comercial (InsightFace)",
    pack: "faceswap-extra",
  },
} as const;

export const FaceSelectorSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("reference"),
    t: SecondsSchema,
    /** Index left to right. */
    faceIndex: z.number().int().min(0),
    /** --reference-face-distance (3.9.1 default). */
    distance: z.number().min(0.05).max(1.5).default(0.3),
  }),
  z.object({ mode: z.literal("one") }),
]);
export type FaceSelector = z.infer<typeof FaceSelectorSchema>;

export const FaceSwapOptionsSchema = z.object({
  model: FaceSwapperModelSchema.default("hyperswap_1a_256"),
  enhancer: z.boolean().default(true),
  enhancerBlend: z.number().int().min(0).max(100).default(80),
  /** Blend with the original (ffmpeg). */
  strength: z.number().min(0.1).max(1).default(1),
});
export type FaceSwapOptions = z.infer<typeof FaceSwapOptionsSchema>;

const FaceSwapBase = z.object({
  personId: IdSchema,
  assetId: IdSchema,
  selector: FaceSelectorSchema.default({ mode: "one" }),
  options: FaceSwapOptionsSchema.default({
    model: "hyperswap_1a_256",
    enhancer: true,
    enhancerBlend: 80,
    strength: 1,
  }),
});

/** POST /api/face/preview -> job face.preview. */
export const FacePreviewRequestSchema = FaceSwapBase.extend({ t: SecondsSchema });
export type FacePreviewRequest = z.infer<typeof FacePreviewRequestSchema>;
export type FacePreviewRequestInput = z.input<typeof FacePreviewRequestSchema>;

export const FacePreviewResultSchema = z.object({
  beforePath: z.string(),
  afterPath: z.string(),
  device: z.enum(["cuda", "cpu"]),
  ms: z.number(),
  warnings: z.array(z.string()).optional(),
});
export type FacePreviewResult = z.infer<typeof FacePreviewResultSchema>;

/** POST /api/face/swap -> job face.swap. */
export const FaceSwapRequestSchema = FaceSwapBase.extend({
  /** Seconds of the asset; with `target` = in/out of the clip. */
  range: z.object({ start: SecondsSchema, end: SecondsSchema }).optional(),
  target: z.object({ projectId: IdSchema, clipId: IdSchema }).optional(),
  /** Consent + nobody in the video is a minor (decision 6). */
  confirmed: z.literal(true),
});
export type FaceSwapRequest = z.infer<typeof FaceSwapRequestSchema>;
export type FaceSwapRequestInput = z.input<typeof FaceSwapRequestSchema>;

export const FaceSwapResultSchema = z.object({
  assetId: IdSchema,
  path: z.string(),
  frames: z.number().int(),
  fps: z.number(),
  device: z.enum(["cuda", "cpu"]),
  model: z.string(),
  consentId: IdSchema,
  licences: z.array(LicenceIdSchema),
  clipId: IdSchema.optional(),
  warnings: z.array(z.string()).optional(),
});
export type FaceSwapResult = z.infer<typeof FaceSwapResultSchema>;

/** POST /api/face/undo -> Project. */
export const FaceUndoRequestSchema = z.object({ projectId: IdSchema, clipId: IdSchema });
export type FaceUndoRequest = z.infer<typeof FaceUndoRequestSchema>;

/** Workers routes (preview = /face/swap with preview_t). */
export const WORKER_FACE_ROUTES = {
  detect: "/face/detect",
  swap: "/face/swap",
  task: "/face/tasks/:id",
  cancel: "/face/tasks/:id/cancel",
} as const;
