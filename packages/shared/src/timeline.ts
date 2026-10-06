import { z } from "zod";
import { PublishSettingsSchema } from "./ai.js";
import { ClipKeyframesSchema } from "./keyframes.js";
import { IdSchema, SecondsSchema, TimestampSchema } from "./common.js";
import { MotionSpecSchema } from "./motion.js";
import { CaptionStyleSchema, SubtitleSegmentSchema } from "./subtitles.js";
import { ClipMatteSchema, ProjectReframeSchema, TrackRefSchema } from "./vision.js";
import { VoiceEffectSchema } from "./voice.js";

export const TrackKindSchema = z.enum(["video", "audio", "text", "motion"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TransitionSchema = z.object({
  type: z.enum(["fade", "crossfade", "wipe", "slide", "zoom"]),
  durationSec: z.number().positive().max(10),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const CropSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type Crop = z.infer<typeof CropSchema>;

/**
 * Picture-in-picture placement: anchor of the scaled clip inside the free canvas space
 * (0 = left/top edge, 0.5 = centered, 1 = right/bottom edge).
 */
export const ClipPositionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type ClipPosition = z.infer<typeof ClipPositionSchema>;

export const TextStyleSchema = z.object({
  fontFamily: z.string().default("Inter"),
  fontSize: z.number().positive().default(64),
  color: z.string().default("#ffffff"),
  background: z.string().optional(),
  position: z.enum(["top", "center", "bottom"]).default("bottom"),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

/**
 * Sprint 3b «Capas y fusiones» (docs/trabajo/sprint3b-contratos.md §E): how a video/motion clip is
 * composited over the layers below it. Absent = "normal" (source-over).
 */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "add",
  "difference",
  "lighten",
  "darken",
] as const;
export const BlendModeSchema = z.enum(BLEND_MODES);
export type BlendMode = z.infer<typeof BlendModeSchema>;

/**
 * Clip mask. "asset": a SAM mask (asset kind "mask": folder of %05d.png per source frame, or one
 * PNG), an image (luma, or alpha when it has one) or an alpha video; aligned to the clip source.
 * "shape": rectangle / ellipse in fractions 0..1 of the clip's visible frame (x,y = top-left),
 * `feather` = gaussian edge softness in project pixels at clip scale 100 % (sigma = feather / 2),
 * `invert` keeps the outside instead.
 */
export const ClipMaskAssetSchema = z.object({ type: z.literal("asset"), assetId: IdSchema });
export const ClipMaskShapeSchema = z.object({
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse"]),
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  w: z.number().min(0.001).max(3),
  h: z.number().min(0.001).max(3),
  feather: z.number().min(0).max(500).default(0),
  invert: z.boolean().default(false),
});
export const ClipMaskSchema = z.discriminatedUnion("type", [
  ClipMaskAssetSchema,
  ClipMaskShapeSchema,
]);
export type ClipMaskAsset = z.infer<typeof ClipMaskAssetSchema>;
export type ClipMaskShape = z.infer<typeof ClipMaskShapeSchema>;
export type ClipMask = z.infer<typeof ClipMaskSchema>;

/** FFmpeg `blend` all_mode of a blend mode (undefined = "normal": plain overlay). */
export function blendModeToFfmpeg(mode: BlendMode | undefined): string | undefined {
  switch (mode ?? "normal") {
    case "normal":
      return undefined;
    case "add":
      return "addition";
    default:
      return mode;
  }
}

/** Canvas 2D `globalCompositeOperation` of a blend mode ("add" = "lighter"). */
export function blendModeToCanvas(mode: BlendMode | undefined): GlobalCompositeOp {
  switch (mode ?? "normal") {
    case "normal":
      return "source-over";
    case "add":
      return "lighter";
    default:
      return mode as GlobalCompositeOp;
  }
}
/** The canvas operations blendModeToCanvas returns (no DOM lib needed in shared). */
export type GlobalCompositeOp =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "lighter"
  | "difference"
  | "lighten"
  | "darken";

/**
 * Reference result (W3C Compositing Level 1, separable modes) of one 8-bit channel: `top` over an
 * opaque `base` with `alpha` (clip opacity × mask): (1 − α)·base + α·B(base, top); "add" is the
 * canvas "lighter" plus: min(1, base + α·top). Preview and export both match
 * it (parity tests in apps/api and apps/web).
 */
export function blendChannel(mode: BlendMode, base: number, top: number, alpha = 1): number {
  const b = base / 255;
  const s = top / 255;
  let m: number;
  switch (mode) {
    case "normal":
      m = s;
      break;
    case "multiply":
      m = b * s;
      break;
    case "screen":
      m = b + s - b * s;
      break;
    case "overlay":
      m = b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      break;
    case "add":
      // Porter-Duff "plus" like canvas "lighter": the layer light is added scaled by its alpha.
      return Math.round(255 * Math.min(1, b + alpha * s));
    case "difference":
      m = Math.abs(b - s);
      break;
    case "lighten":
      m = Math.max(b, s);
      break;
    case "darken":
      m = Math.min(b, s);
      break;
  }
  return Math.round(255 * ((1 - alpha) * b + alpha * m));
}

/** blendChannel on an RGB triple. */
export function blendRgb(
  mode: BlendMode,
  base: readonly [number, number, number],
  top: readonly [number, number, number],
  alpha = 1,
): [number, number, number] {
  return [0, 1, 2].map((i) => blendChannel(mode, base[i]!, top[i]!, alpha)) as [
    number,
    number,
    number,
  ];
}

/** Canvas rect (px) of a shape mask inside the clip's displayed rect (same math in export/preview). */
export function maskShapeRect(
  clipRect: { x: number; y: number; width: number; height: number },
  shape: Pick<ClipMaskShape, "x" | "y" | "w" | "h">,
): { x: number; y: number; width: number; height: number } {
  return {
    x: clipRect.x + shape.x * clipRect.width,
    y: clipRect.y + shape.y * clipRect.height,
    width: shape.w * clipRect.width,
    height: shape.h * clipRect.height,
  };
}

/** Default shape mask of the inspector (centered, 80 % of the clip). */
export function defaultMaskShape(shape: ClipMaskShape["shape"]): ClipMaskShape {
  return { type: "shape", shape, x: 0.1, y: 0.1, w: 0.8, h: 0.8, feather: 0, invert: false };
}

/**
 * Parity fixture (export pixel tests and preview tests): `top` composited over `base` with
 * `mode` must give `blendRgb(mode, base, top)` within LAYER_PARITY_TOLERANCE.
 */
export const LAYER_PARITY_BASE: readonly [number, number, number] = [0x80, 0x40, 0xc0];
export const LAYER_PARITY_TOP: readonly [number, number, number] = [0x60, 0xa0, 0xff];
export const LAYER_PARITY_TOLERANCE = 8;

/** Sprint 4: `Clip.faceSwap` (docs/trabajo/sprint4-contratos.md, M1). */
export const ClipFaceSwapSchema = z.object({
  prev: z.object({
    assetId: IdSchema,
    in: SecondsSchema,
    out: SecondsSchema,
    matte: ClipMatteSchema.optional(),
    maskRef: ClipMaskSchema.optional(),
  }),
  personId: IdSchema,
  consentId: IdSchema,
  jobId: IdSchema,
});
export type ClipFaceSwap = z.infer<typeof ClipFaceSwapSchema>;

/** A clip placed on a track. Times are in seconds. */
export const ClipSchema = z.object({
  id: IdSchema,
  trackId: IdSchema,
  /** Source media (video/audio/image tracks); absent for text/motion clips. */
  assetId: IdSchema.optional(),
  /** Position on the timeline. */
  start: SecondsSchema,
  /** Source in/out points (trim). duration on timeline = (out - in) / speed. */
  in: SecondsSchema.default(0),
  out: SecondsSchema,
  speed: z.number().min(0.1).max(16).default(1),
  volume: z.number().min(0).max(4).default(1),
  opacity: z.number().min(0).max(1).default(1),
  crop: CropSchema.optional(),
  /** PiP: size relative to the fitted full frame (1 = full frame). Absent = full frame. */
  scale: z.number().min(0.05).max(1).optional(),
  /** PiP: placement of the scaled clip (absent = centered). */
  position: ClipPositionSchema.optional(),
  transitionIn: TransitionSchema.optional(),
  transitionOut: TransitionSchema.optional(),
  /** Text track payload. */
  text: z.string().optional(),
  textStyle: TextStyleSchema.optional(),
  /** Motion track payload (rendered to renders/ by the motion engine). */
  motion: MotionSpecSchema.optional(),
  /** Rendered motion asset id once the motion job finished. */
  renderedAssetId: IdSchema.optional(),
  /** Audio effects chain applied on export. */
  voiceEffects: z.array(VoiceEffectSchema).default([]),
  /**
   * Sprint 2: animated properties (see keyframes.ts). When a property has keyframes they win over
   * the fixed `position` / `scale` / `opacity` / `crop`.
   */
  keyframes: ClipKeyframesSchema.optional(),
  /** Sprint 2: follow a track (asset kind "track"); derived at export/preview time. */
  trackRef: TrackRefSchema.optional(),
  /** Sprint 2: cut-out (alpha WebM of the same source) drawn over `matte.background`. */
  matte: ClipMatteSchema.optional(),
  /** Sprint 3b: blend mode over the lower layers (absent = normal). */
  blendMode: BlendModeSchema.optional(),
  /** Sprint 3b: mask (asset or shape) multiplied into the clip alpha. */
  maskRef: ClipMaskSchema.optional(),
  /**
   * Sprint 4: the clip shows a face-swapped render (job face.swap). `prev` keeps what the clip had
   * before (POST /api/face/undo restores it); asset mattes/masks are dropped and come back on undo.
   */
  faceSwap: ClipFaceSwapSchema.optional(),
});
export type Clip = z.infer<typeof ClipSchema>;
export type ClipInput = z.input<typeof ClipSchema>;

export const TrackSchema = z.object({
  id: IdSchema,
  kind: TrackKindSchema,
  name: z.string(),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /**
   * Sprint 3b: explicit z-order (higher = drawn on top). Absent = its index in `tracks`. Ties keep
   * the array order. Use tracksInZOrder() to iterate tracks bottom to top.
   */
  order: z.number().int().min(0).optional(),
  clips: z.array(ClipSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

/** Effective z-order of the track at `index` (Track.order, else the index). */
export function trackZ(track: Pick<Track, "order">, index: number): number {
  return track.order ?? index;
}

/**
 * `order` for a track appended to `tracks` so it lands on top: max effective z + 1 when the project
 * uses explicit `order` (after deleting tracks, its index alone could tie below the top one);
 * undefined when no track has `order` (the array index already puts it on top).
 */
export function nextTrackOrder(tracks: readonly Pick<Track, "order">[]): number | undefined {
  if (!tracks.some((t) => t.order !== undefined)) return undefined;
  return tracks.reduce((m, t, i) => Math.max(m, trackZ(t, i)), -1) + 1;
}

/** Tracks bottom to top (Track.order, else array index; stable). Export and preview use this. */
export function tracksInZOrder<T extends Pick<Track, "order">>(tracks: readonly T[]): T[] {
  return tracks
    .map((t, i) => ({ t, i, z: trackZ(t, i) }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((x) => x.t);
}

/** Tracks sorted by z-order with `order` rewritten to 0..n-1 (array order = z-order). */
export function normalizeTrackOrder<T extends Pick<Track, "order">>(tracks: readonly T[]): T[] {
  return tracksInZOrder(tracks).map((t, i) => ({ ...t, order: i }));
}

/**
 * Move a track to z position `to` (0 = bottom), clamped; returns normalized tracks (array order =
 * z-order, `order` = index). Unknown id = normalized copy.
 */
export function moveTrackZ<T extends Pick<Track, "order"> & { id: string }>(
  tracks: readonly T[],
  trackId: string,
  to: number,
): T[] {
  const sorted = tracksInZOrder(tracks);
  const from = sorted.findIndex((t) => t.id === trackId);
  if (from >= 0) {
    const [t] = sorted.splice(from, 1);
    sorted.splice(Math.max(0, Math.min(sorted.length, Math.round(to))), 0, t!);
  }
  return sorted.map((t, i) => ({ ...t, order: i }));
}

export const ProjectSettingsSchema = z.object({
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  fps: z.number().positive().default(30),
  sampleRate: z.number().int().positive().default(48_000),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  settings: ProjectSettingsSchema,
  tracks: z.array(TrackSchema).default([]),
  /** Subtitles generated by Whisper or typed manually. */
  subtitles: z.array(SubtitleSegmentSchema).default([]),
  /** Style used to burn/animate `subtitles` (absent = api default). */
  captionStyle: CaptionStyleSchema.optional(),
  /**
   * "Quemar subtítulos" chosen in the Export panel (absent = defaultBurnSubtitles). The preview
   * uses the same value so both show the same subtitles.
   */
  burnSubtitles: z.boolean().optional(),
  /** "Revisión para redes" + optional burned AI label (Sprint 1). */
  publish: PublishSettingsSchema.optional(),
  /** Sprint 2: crop keyframes for vertical/square exports (replaces the blurred background). */
  reframe: ProjectReframeSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/** True when a visible motion track has an `animated-captions` clip (subtitles already on screen). */
export function hasAnimatedCaptions(project: Pick<Project, "tracks">): boolean {
  return project.tracks.some(
    (t) =>
      t.kind === "motion" &&
      !t.hidden &&
      t.clips.some((c) => c.motion?.template === "animated-captions"),
  );
}

/**
 * Default of ExportRequest.burnSubtitles: burn `project.subtitles` unless an animated-captions
 * clip already shows them (otherwise they appear twice).
 */
export function defaultBurnSubtitles(project: Pick<Project, "tracks">): boolean {
  return !hasAnimatedCaptions(project);
}

/** ExportRequest.burnSubtitles ?? Project.burnSubtitles ?? defaultBurnSubtitles(project). */
export function effectiveBurnSubtitles(
  project: Pick<Project, "tracks" | "burnSubtitles">,
  override?: boolean,
): boolean {
  return override ?? project.burnSubtitles ?? defaultBurnSubtitles(project);
}

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  settings: ProjectSettingsSchema.partial().optional(),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;
