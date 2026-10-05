import type { TrackProp } from "../schemas/common.js";

/**
 * Follower center at `t` seconds (composition fractions): the box is interpolated linearly
 * between frames (clamped at the ends), then the anchor (center / top-middle / bottom-middle)
 * plus `offset`. Same math as @studio/shared trackPointAt (export and preview).
 */
export function trackPoint(
  track: Pick<TrackProp, "frames">,
  t: number,
  anchor: "center" | "top" | "bottom" = "center",
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } | undefined {
  const fs = [...track.frames].sort((a, b) => a.t - b.t);
  if (fs.length === 0) return undefined;
  let a = fs[0]!;
  let b = a;
  if (t >= fs[fs.length - 1]!.t) a = b = fs[fs.length - 1]!;
  else if (t > a.t)
    for (let i = 1; i < fs.length; i++)
      if (fs[i]!.t > t) {
        a = fs[i - 1]!;
        b = fs[i]!;
        break;
      }
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const l = (p: number, q: number) => p + (q - p) * k;
  const x = l(a.x, b.x);
  const y = l(a.y, b.y);
  const w = l(a.w, b.w);
  const h = l(a.h, b.h);
  const ay = anchor === "top" ? y : anchor === "bottom" ? y + h : y + h / 2;
  return { x: x + w / 2 + offset.x, y: ay + offset.y };
}
