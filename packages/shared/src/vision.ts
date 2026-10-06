import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";
import {
  interpolate,
  KeyframeSchema,
  normalizeCropRect,
  Vec2Schema,
  type CropRect,
  type Keyframe,
} from "./keyframes.js";
import type { Project } from "./timeline.js";

/**
 * Sprint 2 (docs/trabajo/sprint2-contratos.md): matting, SAM 2 masks, tracking, reframe.
 * Coordinates exchanged with the workers (bbox, points, TrackFile) are fractions 0..1 of the
 * SOURCE frame; times of the workers are SOURCE seconds of the asset.
 */

// ---------- data model ----------

/** One tracked box (fractions 0..1 of the source; x,y = top-left corner). `t` in source seconds. */
export const TrackFrameSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  conf: z.number().min(0).max(1).default(1),
});
export type TrackFrame = z.infer<typeof TrackFrameSchema>;

export const TrackMethodSchema = z.enum(["sam2", "csrt"]);
export type TrackMethod = z.infer<typeof TrackMethodSchema>;
/**
 * Method asked by POST /api/ai/vision/track: "auto" = the api picks "sam2" when the workers list
 * the sam2 pack as installed (GET /packs), else "csrt" (OpenCV; template matching when headless).
 */
export const TrackRequestMethodSchema = z.enum(["auto", "sam2", "csrt"]);
export type TrackRequestMethod = z.infer<typeof TrackRequestMethodSchema>;

/** track.json (asset kind "track"). */
export const TrackFileSchema = z.object({
  version: z.literal(1).default(1),
  fps: z.number().positive(),
  frames: z.array(TrackFrameSchema),
  smoothed: z.boolean().default(false),
  source: z.object({ assetId: z.string(), method: z.string() }),
});
export type TrackFile = z.infer<typeof TrackFileSchema>;

export const TrackAnchorSchema = z.enum(["center", "top", "bottom"]);
export type TrackAnchor = z.infer<typeof TrackAnchorSchema>;

/**
 * `Clip.trackRef`: the clip follows a track. Its CENTER goes to the anchor point of the tracked
 * box (center / top-middle / bottom-middle) mapped onto the canvas through the video clip that
 * shows the tracked asset, plus `offset` (canvas fractions). Derived at export / preview time.
 */
export const TrackRefSchema = z.object({
  assetId: IdSchema,
  anchor: TrackAnchorSchema.default("center"),
  offset: Vec2Schema.default({ x: 0, y: 0 }),
});
export type TrackRef = z.infer<typeof TrackRefSchema>;

export const MatteBackgroundTypeSchema = z.enum(["color", "image", "video", "blur"]);
export type MatteBackgroundType = z.infer<typeof MatteBackgroundTypeSchema>;

/**
 * Background behind the cut-out person. `value`: CSS hex colour for "color", media asset id for
 * "image"/"video", blur sigma (string number, default 25) for "blur" (blurred original clip).
 */
export const MatteBackgroundSchema = z.object({
  type: MatteBackgroundTypeSchema,
  value: z.string().optional(),
});
export type MatteBackground = z.infer<typeof MatteBackgroundSchema>;

/**
 * `Clip.matte`: the clip is drawn as `background` + the alpha video (WebM VP9 yuva420p, same
 * timing as the source asset) on top. Without background the cut-out is drawn over the lower
 * tracks (transparent background).
 */
export const ClipMatteSchema = z.object({
  assetId: IdSchema,
  background: MatteBackgroundSchema.optional(),
});
export type ClipMatte = z.infer<typeof ClipMatteSchema>;

export const ReframeTargetSchema = z.enum(["9:16", "1:1", "4:5"]);
export type ReframeTarget = z.infer<typeof ReframeTargetSchema>;

/** Width / height of a reframe target. */
export function reframeAspect(target: ReframeTarget): number {
  return target === "9:16" ? 9 / 16 : target === "1:1" ? 1 : 4 / 5;
}

/**
 * `Project.reframe`: crop keyframes ({x,y,w,h} fractions 0..1 of the CANVAS, `t` in absolute
 * timeline seconds). Applied by the export when the preset aspect differs from the canvas (instead
 * of the blurred background): a crop of the target aspect whose center follows the keyframes.
 */
export const ProjectReframeSchema = z.object({
  target: ReframeTargetSchema,
  keyframes: z.array(KeyframeSchema),
  mode: z.enum(["auto", "manual"]).default("auto"),
});
export type ProjectReframe = z.infer<typeof ProjectReframeSchema>;

/**
 * Size of the reframe window in fractions of the canvas: the largest rect of the target aspect
 * that fits the canvas (16:9 canvas -> 9:16 window = full height, 0.316 of the width).
 */
export function reframeWindow(
  canvas: { width: number; height: number },
  target: ReframeTarget,
): { w: number; h: number } {
  const ta = reframeAspect(target);
  const ca = canvas.width / canvas.height;
  return ca > ta ? { w: ta / ca, h: 1 } : { w: 1, h: ca / ta };
}

/**
 * Reframe crop (fractions of the CANVAS) at `t` (absolute timeline seconds), the same window the
 * export crops: target-aspect window of `reframeWindow` size whose CENTER follows the center of
 * the interpolated keyframe rects (fractions or percent, see normalizeCropRect), clamped inside
 * the canvas. Shared by the export compiler (crop expressions) and the web preview.
 */
export function reframeCropAt(
  reframe: { target: ReframeTarget; keyframes: readonly Keyframe[] },
  canvas: { width: number; height: number },
  t: number,
): CropRect | undefined {
  const rects = reframe.keyframes
    .filter((k) => typeof k.v === "object" && "w" in k.v)
    .map((k) => ({ ...k, v: normalizeCropRect(k.v as CropRect) }));
  const v = interpolate(rects, t);
  if (!v) return undefined;
  const { w, h } = reframeWindow(canvas, reframe.target);
  const clamp = (x: number, hi: number) => Math.min(Math.max(0, x), Math.max(0, hi));
  return {
    x: clamp(v.x + v.w / 2 - w / 2, 1 - w),
    y: clamp(v.y + v.h / 2 - h / 2, 1 - h),
    w,
    h,
  };
}

/** Motion templates that position themselves on a track (the api passes `props.track`). */
export const TRACK_AWARE_TEMPLATES = ["animated-captions", "lower-third"] as const;

// ---------- workers (internal) ----------

/** Workers GET /vision/tasks/{id}. `result` depends on the task (see the request types). */
export const VisionTaskSchema = z.object({
  status: z.enum(["queued", "running", "done", "error"]),
  progress: z.number().min(0).max(1).default(0),
  message: z.string().nullish(),
  result: z.unknown().optional(),
  error: z.string().nullish(),
  warnings: z.array(z.string()).nullish(),
});
export type VisionTask = z.infer<typeof VisionTaskSchema>;

/**
 * Sprint 3b «Recorte de calidad alta» (docs/trabajo/modulo-sprint3b-recorte.md). `fast` = RVM
 * mobilenetv3 (pack matting); `high` = RVM resnet50 (pack matting-hq) + alpha refinement.
 */
export const MatteQualitySchema = z.enum(["fast", "high"]);
export type MatteQuality = z.infer<typeof MatteQualitySchema>;

/** Alpha refinement (absent field = default of the quality: high = erode 1, feather 0.7, despill). */
export const MatteRefineSchema = z.object({
  /** «Reducción de borde»: grey erosion of the alpha, px. */
  erode: z.number().int().min(0).max(20).optional(),
  /** «Suavizado de borde»: gaussian sigma of the alpha edge, px. */
  feather: z.number().min(0).max(20).optional(),
  /** «Eliminar halos de color»: background colour decontamination of the edges. */
  despill: z.boolean().optional(),
  /** Temporal EMA of the edges (0 = off, anti-flicker). */
  temporal: z.number().min(0).max(0.9).optional(),
  /** SAM mask guide: px of dilation around the mask. */
  maskDilate: z.number().int().min(0).max(200).optional(),
});
export type MatteRefine = z.infer<typeof MatteRefineSchema>;

/** No-reference edge halo score (0..255, lower = cleaner) before/after the refinement. */
export const MatteHaloSchema = z.object({
  before: z.number(),
  after: z.number(),
  frames: z.number().int().nonnegative().optional(),
  reduction: z.number().nullish(),
});
export type MatteHalo = z.infer<typeof MatteHaloSchema>;

export const WorkerMatteResultSchema = z.object({
  alpha_path: z.string(),
  preview_path: z.string().nullish(),
  fps: z.number().positive().nullish(),
  warnings: z.array(z.string()).nullish(),
  /** RVM: "vp9" (WebM alpha, default) or "split" (.mkv colour + alpha, docs/trabajo/perf-rvm.md). */
  alpha_codec: z.string().nullish(),
  /** RVM stage timings of the run (`done.timings` + startup_s / preview_s). */
  timings: z.record(z.string(), z.unknown()).nullish(),
  /** Sprint 3b: quality used, refinement parameters, halo score, before|after PNG. */
  quality: z.string().nullish(),
  rvm_model: z.string().nullish(),
  refine: z.record(z.string(), z.unknown()).nullish(),
  halo: MatteHaloSchema.nullish(),
  preview_compare_path: z.string().nullish(),
  mask_frames: z.number().int().nonnegative().nullish(),
});
export type WorkerMatteResult = z.infer<typeof WorkerMatteResultSchema>;

export const WorkerSamSessionSchema = z.object({
  session_id: z.string().min(1),
  frames: z.number().int().nonnegative(),
  fps: z.number().positive(),
});
export type WorkerSamSession = z.infer<typeof WorkerSamSessionSchema>;

export const BBoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBoxSchema>;

export const WorkerSamPointsResultSchema = z.object({
  mask_png_path: z.string(),
  bbox: BBoxSchema.nullish(),
});

export const WorkerPropagateResultSchema = z.object({
  masks_dir: z.string().nullish(),
  track: TrackFileSchema.partial({ source: true }).nullish(),
  track_path: z.string().nullish(),
  alpha_path: z.string().nullish(),
});

export const WorkerTrackResultSchema = z.object({
  track_path: z.string(),
  smoothed: z.boolean().default(true),
});

export const WorkerReframeResultSchema = z.object({
  keyframes: z.array(KeyframeSchema),
  per_scene: z.array(z.unknown()).default([]),
});

// ---------- api requests / job payloads ----------

export const ClipTargetSchema = z.object({ projectId: IdSchema, clipId: IdSchema });
export type ClipTarget = z.infer<typeof ClipTargetSchema>;

/** POST /api/ai/vision/matte -> job vision.matte (RVM for video, BiRefNet for images). */
export const VisionMatteRequestSchema = z.object({
  assetId: IdSchema,
  /** Absent: "rvm" for video, "birefnet" for images. */
  model: z.enum(["rvm", "birefnet"]).optional(),
  background: MatteBackgroundSchema.optional(),
  /** Sets `clip.matte = {assetId: <alpha>, background}` on that clip when done. */
  target: ClipTargetSchema.optional(),
  downsample: z.number().min(0.25).max(1).optional(),
  chunkFrames: z.number().int().positive().optional(),
  /** Sprint 3b: "high" needs the matting-hq pack (video only; images always use BiRefNet). */
  quality: MatteQualitySchema.optional(),
  refine: MatteRefineSchema.optional(),
  /** SAM mask asset (kind "mask": folder of %05d.png or one PNG) used as a guide. */
  maskAssetId: IdSchema.optional(),
});
export type VisionMatteRequest = z.infer<typeof VisionMatteRequestSchema>;

export interface VisionMatteResult {
  /** New asset: WebM VP9 alpha (video, hasAlpha) or PNG RGBA (image). */
  assetId: string;
  path: string;
  previewPath?: string;
  sourceAssetId: string;
  linkedClip?: ClipTarget;
  warnings?: string[];
  /** Sprint 3b: quality used and, when refined, the before|after PNG + halo score. */
  quality?: MatteQuality;
  previewComparePath?: string;
  halo?: MatteHalo;
  refine?: Record<string, unknown>;
}

/** POST /api/ai/vision/sam/session. */
export const SamSessionRequestSchema = z.object({
  assetId: IdSchema,
  /** Source frame range [a, b] (frame numbers). */
  frameRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});
export type SamSessionRequest = z.infer<typeof SamSessionRequestSchema>;

export interface SamSessionResponse {
  sessionId: string;
  assetId: string;
  frames: number;
  fps: number;
}

export const SamPointSchema = z.object({
  /** Fractions 0..1 of the source frame. */
  x: z.number(),
  y: z.number(),
  /** 1 = include (+), 0 = exclude (−). */
  label: z.union([z.literal(0), z.literal(1)]),
});
export type SamPoint = z.infer<typeof SamPointSchema>;

/** POST /api/ai/vision/sam/session/:id/points. */
export const SamPointsRequestSchema = z.object({
  frame: z.number().int().nonnegative(),
  points: z.array(SamPointSchema).min(1),
  objId: z.number().int().nonnegative().default(1),
});
export type SamPointsRequest = z.infer<typeof SamPointsRequestSchema>;

export interface SamPointsResponse {
  frame: number;
  objId: number;
  /** Copy of the mask PNG under storage (relative to STORAGE_DIR). */
  maskPath: string;
  /** `/files/<maskPath>` (served by the api). */
  maskUrl: string;
  bbox?: BBox;
}

/** POST /api/ai/vision/sam/session/:id/propagate -> job vision.mask. */
export const SamPropagateRequestSchema = z.object({
  chunkFrames: z.number().int().positive().optional(),
  /** Asset of the session (the api remembers it; send it if the api restarted). */
  assetId: IdSchema.optional(),
});
export type SamPropagateRequest = z.infer<typeof SamPropagateRequestSchema>;

/** Job payload of vision.mask. */
export const VisionMaskPayloadSchema = SamPropagateRequestSchema.extend({
  sessionId: z.string().min(1),
});
export type VisionMaskPayload = z.infer<typeof VisionMaskPayloadSchema>;

export interface VisionMaskResult {
  sessionId: string;
  /** Asset kind "track" (track.json). */
  trackAssetId?: string;
  /** Asset kind "mask": folder of mask PNGs copied under storage/masks/<jobId>/. */
  maskAssetId?: string;
  /** Alpha WebM (video asset, hasAlpha) when the workers produced it. */
  alphaAssetId?: string;
}

/** POST /api/ai/vision/track -> job vision.track (bbox in fractions 0..1 of the source). */
export const VisionTrackRequestSchema = z
  .object({
    assetId: IdSchema,
    bbox: BBoxSchema.optional(),
    /** Asset kind "mask" (folder) or image: its PNG is sent as `mask_png`. */
    maskAssetId: IdSchema.optional(),
    method: TrackRequestMethodSchema.default("csrt"),
    /** Source frame range. */
    frameRange: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .optional(),
    /** Optional: set `clip.trackRef` on this clip when done. */
    target: ClipTargetSchema.extend({
      anchor: z.enum(["center", "top", "bottom"]).default("center"),
      offset: Vec2Schema.default({ x: 0, y: 0 }),
    }).optional(),
  })
  .refine((r) => r.bbox !== undefined || r.maskAssetId !== undefined, {
    message: "Indica bbox o maskAssetId",
  });
export type VisionTrackRequest = z.infer<typeof VisionTrackRequestSchema>;

export interface VisionTrackResult {
  assetId: string;
  path: string;
  frames: number;
  smoothed: boolean;
  /**
   * Tracker that really ran (`TrackFile.source.method`): "csrt", "sam2", or "template" when
   * OpenCV has no CSRT (headless build) and the workers fell back to template matching.
   */
  method?: string;
  linkedClip?: ClipTarget;
}

/** POST /api/ai/vision/reframe -> job vision.reframe (stores `project.reframe`). */
export const VisionReframeRequestSchema = z.object({
  projectId: IdSchema,
  target: ReframeTargetSchema.default("9:16"),
  subject: z.enum(["face", "track"]).default("face"),
  /** Video clip to analyze (default: first visible video clip with media). */
  clipId: IdSchema.optional(),
  /** Required with subject "track". */
  trackAssetId: IdSchema.optional(),
});
export type VisionReframeRequest = z.infer<typeof VisionReframeRequestSchema>;

/** POST /api/ai/timeline/track-to-keyframes -> job timeline.track-to-keyframes. */
export const TrackToKeyframesRequestSchema = z.object({
  projectId: IdSchema,
  clipId: IdSchema,
  /** Max keyframes per second after RDP (default 2). */
  perSecond: z.number().positive().max(30).default(2),
});
export type TrackToKeyframesRequest = z.infer<typeof TrackToKeyframesRequestSchema>;

/** Seconds range helper (scenes sent to /vision/reframe). */
export const TimeRangeSchema = z.object({ start: SecondsSchema, end: SecondsSchema });

/** Result of vision.reframe: the saved project (undo = PUT the previous one). */
export interface VisionReframeResult {
  project: Project;
  reframe: ProjectReframe;
  clipId: string;
  assetId: string;
}

/** Result of timeline.track-to-keyframes: the saved project with `clip.keyframes.position`. */
export interface TrackToKeyframesResult {
  project: Project;
  clipId: string;
  keyframes: number;
}
