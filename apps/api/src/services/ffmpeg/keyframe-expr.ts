import { linearizeKeyframes, type Keyframe, type KeyframeValue, type Vec2 } from "@studio/shared";
import { sec } from "./escape.js";

/**
 * Sprint 2: keyframes -> FFmpeg expressions. The curve is made piecewise linear with
 * `linearizeKeyframes` (linear segments as they are, eased segments pre-sampled at ≤ `rate`
 * keypoints per second, "hold" as a 1 µs step) and written as a balanced `if(lt(T,tk),A,B)` tree
 * (depth log2(n), cheap even per pixel in geq). Before the first / after the last keypoint the
 * value is constant, like `interpolate` in @studio/shared.
 */

/** Max keypoints per second used for eased segments (contract: ≤ 30). */
export const EXPR_RATE = 30;

const num = (v: number) => sec(v);

interface Pt {
  t: number;
  v: number;
}

/** Piecewise-linear expression of `points` (sorted by t) in the time variable `tv`. */
export function piecewiseExpr(points: readonly Pt[], tv: string): string {
  const pts = [...points]
    .map((p) => ({ t: Math.round(p.t * 1e6) / 1e6, v: p.v }))
    .sort((a, b) => a.t - b.t);
  // Equal times (after rounding): keep the later value.
  const uniq: Pt[] = [];
  for (const p of pts) {
    if (uniq.length && uniq[uniq.length - 1]!.t === p.t) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  if (uniq.length === 0) return "0";
  if (uniq.length === 1 || uniq.every((p) => Math.abs(p.v - uniq[0]!.v) < 1e-9))
    return num(uniq[0]!.v);
  const leaf = (i: number): string => {
    const a = uniq[i]!;
    const b = uniq[i + 1]!;
    const dt = b.t - a.t;
    if (Math.abs(b.v - a.v) < 1e-9) return num(a.v);
    if (dt <= 0) return num(b.v);
    const k = (b.v - a.v) / dt;
    return `(${num(a.v)}+${+k.toPrecision(10)}*(${tv}-${num(a.t)}))`;
  };
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return leaf(lo);
    const mid = (lo + hi) >> 1;
    return `if(lt(${tv},${num(uniq[mid + 1]!.t)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  const first = uniq[0]!;
  const last = uniq[uniq.length - 1]!;
  return `if(lt(${tv},${num(first.t)}),${num(first.v)},if(gte(${tv},${num(last.t)}),${num(last.v)},${tree(0, uniq.length - 2)}))`;
}

/** Expression of a numeric keyframe curve (mapped by `map`, e.g. to pixels). */
export function numberKeyframesExpr(
  keyframes: readonly Keyframe[],
  tv: string,
  map: (v: number) => number = (v) => v,
  rate = EXPR_RATE,
): string {
  const pts = linearizeKeyframes(keyframes as Keyframe<KeyframeValue>[], rate).flatMap((p) =>
    typeof p.v === "number" ? [{ t: p.t, v: map(p.v) }] : [],
  );
  return piecewiseExpr(pts, tv);
}

/** Expressions of one component of {x,y} / {x,y,w,h} keyframes. */
export function componentExpr(
  keyframes: readonly Keyframe[],
  pick: (v: Vec2 & { w?: number; h?: number }) => number,
  tv: string,
  map: (v: number) => number = (v) => v,
  rate = EXPR_RATE,
): string {
  const pts = linearizeKeyframes(keyframes as Keyframe<KeyframeValue>[], rate).flatMap((p) =>
    typeof p.v === "object" ? [{ t: p.t, v: map(pick(p.v)) }] : [],
  );
  return piecewiseExpr(pts, tv);
}

/** Max / min of a numeric keyframe curve (the linearized curve never leaves [min, max] of the keys). */
export function numberRange(keyframes: readonly Keyframe[]): { min: number; max: number } {
  const vs = keyframes.flatMap((k) => (typeof k.v === "number" ? [k.v] : []));
  return vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : { min: 1, max: 1 };
}

/** Keyframes shifted by `dt` seconds (window renders: clip-local time of a sliced piece). */
export function shiftKeyframes<K extends { t: number }>(keyframes: readonly K[], dt: number): K[] {
  return dt === 0 ? [...keyframes] : keyframes.map((k) => ({ ...k, t: k.t - dt }));
}
