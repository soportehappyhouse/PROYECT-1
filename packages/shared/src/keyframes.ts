import { z } from "zod";

/**
 * Sprint 2 keyframes (docs/trabajo/sprint2-contratos.md, "Modelo de datos"). `interpolate` is the
 * ONE function the export compiler (apps/api) and the web preview use, so both show the same
 * frame: keep it pure and deterministic.
 *
 * Semantics:
 *  - `t` is in seconds relative to the clip start (timeline seconds; `Project.reframe` uses absolute
 *    timeline seconds).
 *  - The ease of keyframe i shapes the segment i -> i+1 (outgoing ease, as in After Effects).
 *    "hold" keeps `v` until the next keyframe (step).
 *  - Before the first / after the last keyframe the value is constant (first / last `v`).
 *  - Values: number (scale, opacity), {x,y} (position: CENTER of the clip/text in canvas fractions
 *    0..1, (0.5,0.5) = centered), {x,y,w,h} (crop rect in fractions 0..1 of the source).
 */

export const EASINGS = ["linear", "easeIn", "easeOut", "easeInOut", "hold"] as const;
export const EasingSchema = z.enum(EASINGS);
export type Easing = z.infer<typeof EasingSchema>;

export const Vec2Schema = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2Schema>;

/** Crop rect, fractions 0..1 of the source (percent 0..100 is accepted: see normalizeCropRect). */
export const CropRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type CropRect = z.infer<typeof CropRectSchema>;

/** CropRect is listed first: a {x,y} schema would strip `w`/`h` from a crop value. */
export const KeyframeValueSchema = z.union([z.number(), CropRectSchema, Vec2Schema]);
export type KeyframeValue = number | Vec2 | CropRect;

export const KeyframeSchema = z.object({
  t: z.number(),
  v: KeyframeValueSchema,
  ease: EasingSchema.default("linear"),
});
export interface Keyframe<V extends KeyframeValue = KeyframeValue> {
  t: number;
  v: V;
  ease: Easing;
}
export type KeyframeInput = z.input<typeof KeyframeSchema>;

/** `Clip.keyframes`: when a property has keyframes they win over the fixed `position/scale/opacity`. */
export const ClipKeyframesSchema = z.object({
  /** Center of the clip/text, canvas fractions (see file comment). */
  position: z.array(KeyframeSchema).optional(),
  /** Video/image/motion: size relative to the fitted full frame (1 = full frame). Text: font size factor. */
  scale: z.array(KeyframeSchema).optional(),
  /** 0..1, multiplied by nothing else (replaces Clip.opacity). */
  opacity: z.array(KeyframeSchema).optional(),
  /** {x,y,w,h} fractions of the source; the export keeps w/h of the first keyframe and moves x/y. */
  crop: z.array(KeyframeSchema).optional(),
});
export type ClipKeyframes = z.infer<typeof ClipKeyframesSchema>;
export type KeyframeProperty = keyof ClipKeyframes;

/** Easing curve on p in [0,1]. "hold" is 0 until the next keyframe. */
export function ease(kind: Easing, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (kind) {
    case "linear":
      return x;
    case "easeIn":
      return x * x * x;
    case "easeOut":
      return 1 - (1 - x) ** 3;
    case "easeInOut":
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case "hold":
      return x >= 1 ? 1 : 0;
  }
}

const isNum = (v: KeyframeValue): v is number => typeof v === "number";
const isRect = (v: KeyframeValue): v is CropRect => typeof v === "object" && "w" in v && "h" in v;

/** a + (b - a) * k for numbers, {x,y} and {x,y,w,h}; mismatched shapes hold `a`. */
export function lerpValue<V extends KeyframeValue>(a: V, b: V, k: number): V {
  const l = (p: number, q: number) => p + (q - p) * k;
  if (isNum(a)) return (isNum(b) ? l(a, b) : a) as V;
  if (isNum(b)) return a;
  if (isRect(a))
    return (
      isRect(b) ? { x: l(a.x, b.x), y: l(a.y, b.y), w: l(a.w, b.w), h: l(a.h, b.h) } : a
    ) as V;
  return (isRect(b) ? a : { x: l(a.x, b.x), y: l(a.y, b.y) }) as V;
}

/** Keyframes sorted by time (stable for equal times: the later one in the array wins). */
export function sortKeyframes<K extends { t: number }>(keyframes: readonly K[]): K[] {
  return keyframes
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.t - b.k.t || a.i - b.i)
    .map((x) => x.k);
}

/**
 * Value at time `t` (seconds, same base as the keyframes). Undefined when there are no keyframes.
 * Shared by the export compiler and the web preview (parity tests in packages/shared/test).
 */
export function interpolate<V extends KeyframeValue>(
  keyframes: readonly Keyframe<V>[] | undefined,
  t: number,
): V | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  const ks = sortKeyframes(keyframes);
  const first = ks[0]!;
  if (t <= first.t) return first.v;
  const last = ks[ks.length - 1]!;
  if (t >= last.t) return last.v;
  // Last keyframe with k.t <= t (binary search).
  let lo = 0;
  let hi = ks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ks[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = ks[lo]!;
  const b = ks[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  return lerpValue(a.v, b.v, ease(a.ease ?? "linear", (t - a.t) / span));
}

/**
 * Crop rect in fractions 0..1. Values written in percent (0..100, "% del fuente") are divided by
 * 100: a rect with any coordinate above 1.5 cannot be a fraction.
 */
export function normalizeCropRect(r: CropRect): CropRect {
  const pct = Math.max(r.x, r.y, r.w, r.h) > 1.5;
  const k = pct ? 0.01 : 1;
  // Only the size is clamped: x/y may leave the frame (the export clamps the crop window).
  const size = (v: number) => Math.min(1, Math.max(1e-4, v * k));
  return { x: r.x * k, y: r.y * k, w: size(r.w), h: size(r.h) };
}

/** True when the clip has keyframes for `prop` (non-empty). */
export function hasKeyframes(
  kf: ClipKeyframes | undefined,
  prop: KeyframeProperty,
): kf is ClipKeyframes {
  return (kf?.[prop]?.length ?? 0) > 0;
}

/**
 * Remove consecutive duplicates (same time, or same value as both neighbours on a linear run).
 * Keeps the first and last keyframe.
 */
export function dedupeKeyframes<V extends KeyframeValue>(
  keyframes: readonly Keyframe<V>[],
  eps = 1e-6,
): Keyframe<V>[] {
  const ks = sortKeyframes(keyframes);
  const byTime: Keyframe<V>[] = [];
  for (const k of ks) {
    const prev = byTime[byTime.length - 1];
    if (prev && Math.abs(prev.t - k.t) <= eps) byTime[byTime.length - 1] = k;
    else byTime.push(k);
  }
  const same = (a: V, b: V) => valueDistance(a, b) <= eps;
  return byTime.filter(
    (k, i, arr) =>
      i === 0 ||
      i === arr.length - 1 ||
      !(same(arr[i - 1]!.v, k.v) && same(k.v, arr[i + 1]!.v) && arr[i - 1]!.ease !== "hold"),
  );
}

/** Euclidean distance between two values of the same shape (Infinity when shapes differ). */
export function valueDistance(a: KeyframeValue, b: KeyframeValue): number {
  if (isNum(a) || isNum(b)) return isNum(a) && isNum(b) ? Math.abs(a - b) : Infinity;
  if (isRect(a) || isRect(b))
    return isRect(a) && isRect(b)
      ? Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h)
      : Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Ramer–Douglas–Peucker on a keyframe curve with the synchronized distance (the deviation from
 * the straight interpolation AT THE SAME TIME, not the perpendicular one): the result is linear
 * keyframes whose interpolation stays within `epsilon` of every input keyframe.
 */
export function simplifyKeyframes<V extends KeyframeValue>(
  keyframes: readonly Keyframe<V>[],
  epsilon: number,
): Keyframe<V>[] {
  const ks = dedupeKeyframes(keyframes);
  if (ks.length <= 2) return ks.map((k) => ({ ...k, ease: "linear" as const }));
  const keep = new Array<boolean>(ks.length).fill(false);
  keep[0] = keep[ks.length - 1] = true;
  const stack: [number, number][] = [[0, ks.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ka = ks[a]!;
    const kb = ks[b]!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const k = ks[i]!;
      const span = kb.t - ka.t;
      const expected = lerpValue(ka.v, kb.v, span > 0 ? (k.t - ka.t) / span : 0);
      const d = valueDistance(k.v, expected);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > epsilon) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return ks.filter((_, i) => keep[i]).map((k) => ({ ...k, ease: "linear" as const }));
}

/**
 * Simplify until there are at most `perSecond` keyframes per second of span (plus the two ends):
 * RDP with a growing epsilon (starting at `epsilon`, ×1.5 per round).
 */
export function simplifyKeyframesToRate<V extends KeyframeValue>(
  keyframes: readonly Keyframe<V>[],
  perSecond: number,
  epsilon = 0.001,
): Keyframe<V>[] {
  const ks = sortKeyframes(keyframes);
  if (ks.length <= 2) return simplifyKeyframes(ks, epsilon);
  const span = ks[ks.length - 1]!.t - ks[0]!.t;
  const max = Math.max(2, Math.floor(span * perSecond) + 1);
  let eps = epsilon;
  let out = simplifyKeyframes(ks, eps);
  for (let i = 0; out.length > max && i < 60; i++) {
    eps *= 1.5;
    out = simplifyKeyframes(ks, eps);
  }
  return out;
}

/**
 * Linear keypoints equivalent to the eased curve: linear segments are kept as they are, eased ones
 * are sampled every 1/`rate` s, "hold" segments become a step (two keypoints 1 µs apart). Used by
 * the export to turn keyframes into piecewise-linear FFmpeg expressions.
 */
export function linearizeKeyframes<V extends KeyframeValue>(
  keyframes: readonly Keyframe<V>[],
  rate = 30,
): { t: number; v: V }[] {
  const ks = sortKeyframes(keyframes);
  const out: { t: number; v: V }[] = [];
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i]!;
    out.push({ t: a.t, v: a.v });
    const b = ks[i + 1];
    if (!b || b.t <= a.t) continue;
    if (a.ease === "hold") {
      out.push({ t: Math.max(a.t, b.t - 1e-6), v: a.v });
    } else if (a.ease !== "linear") {
      const n = Math.max(1, Math.ceil((b.t - a.t) * rate));
      for (let j = 1; j < n; j++) {
        const t = a.t + ((b.t - a.t) * j) / n;
        out.push({ t, v: lerpValue(a.v, b.v, ease(a.ease, j / n)) });
      }
    }
  }
  return out;
}

/**
 * Parity fixture: interpolate([{t:0,v:0,ease},{t:2,v:100}], t) must give `expected` exactly, in
 * the export (api) and in the preview (web). Tests on both sides iterate over it.
 */
export const KEYFRAME_PARITY_CASES: readonly { ease: Easing; t: number; expected: number }[] = [
  { ease: "linear", t: 0.5, expected: 25 },
  { ease: "linear", t: 1.5, expected: 75 },
  { ease: "easeIn", t: 0.5, expected: 1.5625 },
  { ease: "easeIn", t: 1.5, expected: 42.1875 },
  { ease: "easeOut", t: 0.5, expected: 57.8125 },
  { ease: "easeOut", t: 1.5, expected: 98.4375 },
  { ease: "easeInOut", t: 0.5, expected: 6.25 },
  { ease: "easeInOut", t: 1.5, expected: 93.75 },
  { ease: "hold", t: 0.5, expected: 0 },
  { ease: "hold", t: 1.9, expected: 0 },
  { ease: "linear", t: -1, expected: 0 },
  { ease: "easeIn", t: 2, expected: 100 },
  { ease: "hold", t: 3, expected: 100 },
];
