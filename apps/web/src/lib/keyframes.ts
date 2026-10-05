import { fitRect, type Clip, type MediaAsset, type TrackKind } from "@studio/shared";
import { cropFraction, interpolate, sortKeyframes } from "./interpolate";
import { clipDuration } from "./timeline";
import type {
  ClipKeyframes,
  CropBox,
  Ease,
  Keyframe,
  KeyframeProp,
  KeyframeValue,
  Vec2,
  VisionClip,
} from "./vision-types";

/**
 * Pure keyframe operations on a clip. They return the `Partial<Clip>` patch that
 * project-store.updateClip applies, so every change is one undo step (drags use checkpoint +
 * record=false). Times are seconds from the clip start on the timeline.
 */

export type ClipPatch = Partial<Omit<VisionClip, "id" | "trackId">>;

/** Two keyframes closer than this are the same one (half a frame at 60 fps). */
export const SAME_TIME = 1 / 120;

const round = (t: number) => Math.round(t * 1000) / 1000;

/** Properties that make sense for a track kind. */
export function keyframeProps(kind: TrackKind): KeyframeProp[] {
  if (kind === "text") return ["position", "opacity"];
  if (kind === "video") return ["position", "scale", "opacity", "crop"];
  if (kind === "motion") return ["position", "scale", "opacity"];
  return [];
}

export function keyframesOf(clip: Clip, prop: KeyframeProp): Keyframe[] {
  return clip.keyframes?.[prop] ?? [];
}

export function hasKeyframes(clip: VisionClip): boolean {
  const k = clip.keyframes;
  return !!k && Object.values(k).some((l) => Array.isArray(l) && l.length > 0);
}

/** Canvas + media of a clip (what a static position/crop depends on). */
export interface ValueContext {
  canvas: { width: number; height: number };
  asset?: Pick<MediaAsset, "width" | "height"> | undefined;
}

/**
 * Center (canvas fractions) of a text clip laid out like the export: centered horizontally,
 * 8 % margin at the top/bottom (one line of `fontSize` px).
 */
export function textAnchor(clip: Clip, canvasHeight = 1080): Vec2 {
  const p = clip.textStyle?.position ?? "bottom";
  const half = ((clip.textStyle?.fontSize ?? 64) * 0.6) / canvasHeight;
  return { x: 0.5, y: p === "top" ? 0.08 + half : p === "center" ? 0.5 : 0.92 - half };
}

function mediaSize(a: ValueContext["asset"]) {
  return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
}

/** Static Clip.crop (source pixels) as fractions; full frame without a crop. */
export function staticCrop(clip: Clip, asset: ValueContext["asset"]): CropBox {
  const size = mediaSize(asset);
  if (!clip.crop || !size) return { x: 0, y: 0, w: 1, h: 1 };
  return cropFraction({
    x: clip.crop.x / size.width,
    y: clip.crop.y / size.height,
    w: clip.crop.width / size.width,
    h: clip.crop.height / size.height,
  });
}

/**
 * Static (non animated) value of a property, in keyframe units: position = center in canvas
 * fractions (from Clip.scale/position, same fit as the export), crop = fractions of the source.
 */
export function staticValue(
  clip: Clip,
  prop: KeyframeProp,
  kind: TrackKind,
  ctx: ValueContext = { canvas: { width: 1920, height: 1080 } },
): KeyframeValue {
  switch (prop) {
    case "position": {
      if (kind === "text") return textAnchor(clip, ctx.canvas.height);
      const r = fitRect(ctx.canvas, mediaSize(ctx.asset), clip);
      return {
        x: (r.x + r.width / 2) / ctx.canvas.width,
        y: (r.y + r.height / 2) / ctx.canvas.height,
      };
    }
    case "scale":
      return kind === "text" ? 1 : (clip.scale ?? 1);
    case "opacity":
      return clip.opacity;
    case "crop":
      return staticCrop(clip, ctx.asset);
  }
}

/** Value of `prop` at timeline time `time` (keyframes win over the static value). */
export function valueAt(
  clip: Clip,
  prop: KeyframeProp,
  kind: TrackKind,
  time: number,
  ctx?: ValueContext,
): KeyframeValue {
  return (
    interpolate(keyframesOf(clip, prop), time - clip.start) ?? staticValue(clip, prop, kind, ctx)
  );
}

/** Patch that stores `list` for `prop` (removing empty lists / the whole object). */
export function keyframesPatch(
  clip: Clip,
  prop: KeyframeProp,
  list: readonly Keyframe[],
): ClipPatch {
  const next: ClipKeyframes = { ...(clip.keyframes ?? {}) };
  if (list.length === 0) delete next[prop];
  else (next as Record<KeyframeProp, Keyframe[]>)[prop] = sortKeyframes(list);
  return { keyframes: Object.keys(next).length > 0 ? next : undefined };
}

/** Add (or replace at the same time) a keyframe. `t` is clamped to the clip. */
export function addKeyframe(
  clip: Clip,
  prop: KeyframeProp,
  t: number,
  v: KeyframeValue,
  ease: Ease = "linear",
): { patch: ClipPatch; index: number } {
  const at = round(Math.min(Math.max(0, t), clipDuration(clip)));
  const list = keyframesOf(clip, prop).filter((k) => Math.abs(k.t - at) >= SAME_TIME);
  const kf: Keyframe = { t: at, v, ease };
  const sorted = sortKeyframes([...list, kf]);
  return { patch: keyframesPatch(clip, prop, sorted), index: sorted.indexOf(kf) };
}

/** Move keyframe `index` to time `t` (clamped); answers its new index. */
export function moveKeyframe(
  clip: Clip,
  prop: KeyframeProp,
  index: number,
  t: number,
): { patch: ClipPatch; index: number } {
  const list = sortKeyframes(keyframesOf(clip, prop));
  const kf = list[index];
  if (!kf) return { patch: {}, index };
  const at = round(Math.min(Math.max(0, t), clipDuration(clip)));
  const moved: Keyframe = { ...kf, t: at };
  // Landing on another keyframe replaces it.
  const others = list.filter((k, i) => i !== index && Math.abs(k.t - at) >= SAME_TIME);
  const sorted = sortKeyframes([...others, moved]);
  return { patch: keyframesPatch(clip, prop, sorted), index: sorted.indexOf(moved) };
}

export function removeKeyframe(clip: Clip, prop: KeyframeProp, index: number): ClipPatch {
  const list = sortKeyframes(keyframesOf(clip, prop));
  return keyframesPatch(
    clip,
    prop,
    list.filter((_, i) => i !== index),
  );
}

export function updateKeyframe(
  clip: Clip,
  prop: KeyframeProp,
  index: number,
  change: Partial<Keyframe>,
): ClipPatch {
  const list = sortKeyframes(keyframesOf(clip, prop));
  if (!list[index]) return {};
  return keyframesPatch(
    clip,
    prop,
    list.map((k, i) => (i === index ? { ...k, ...change } : k)),
  );
}

/** Copied keyframes: times relative to the first copied keyframe. */
export interface KeyframeClipboard {
  props: Partial<Record<KeyframeProp, Keyframe[]>>;
}

/** Copy the keyframes of `props` (all when omitted). Undefined when there is nothing to copy. */
export function copyKeyframes(
  clip: Clip,
  props: readonly KeyframeProp[] = ["position", "scale", "opacity", "crop"],
): KeyframeClipboard | undefined {
  const all = props.flatMap((p) => keyframesOf(clip, p));
  if (all.length === 0) return undefined;
  const t0 = Math.min(...all.map((k) => k.t));
  const out: KeyframeClipboard = { props: {} };
  for (const p of props) {
    const list = keyframesOf(clip, p);
    if (list.length) out.props[p] = list.map((k) => ({ ...k, t: round(k.t - t0) }));
  }
  return out;
}

/** Paste at `t` (seconds from the clip start); replaces keyframes at the same times. */
export function pasteKeyframes(
  clip: Clip,
  board: KeyframeClipboard,
  t: number,
  allowed: readonly KeyframeProp[],
): ClipPatch {
  let current: Clip = clip;
  let patch: ClipPatch = {};
  const max = clipDuration(clip);
  for (const [p, list] of Object.entries(board.props) as [KeyframeProp, Keyframe[]][]) {
    if (!allowed.includes(p)) continue;
    const shifted = list
      .map((k) => ({ ...k, t: round(k.t + t) }))
      .filter((k) => k.t <= max + SAME_TIME);
    const kept = keyframesOf(current, p).filter(
      (k) => !shifted.some((s) => Math.abs(s.t - k.t) < SAME_TIME),
    );
    patch = { ...patch, ...keyframesPatch(current, p, [...kept, ...shifted]) };
    current = { ...current, ...patch } as Clip;
  }
  return patch;
}

/** Same value test used to avoid adding a duplicate keyframe. */
export function sameValue(a: KeyframeValue, b: KeyframeValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isCrop(v: KeyframeValue): v is CropBox {
  return typeof v === "object" && "w" in v;
}
