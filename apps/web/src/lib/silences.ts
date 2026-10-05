import type { Clip, SubtitleSegment } from "@studio/shared";
import { roundTime } from "./format";
import { createId } from "./ids";
import { clipEnd, sourceTimeAt } from "./timeline";

/**
 * Feedback 10 «Quitar silencios»: speech ranges from the Whisper word timestamps (timeline time).
 * Pauses longer than `minGapSec` between words become cuts; `padSec` keeps a breath at each side.
 */
export function speechRanges(
  segments: readonly SubtitleSegment[],
  from: number,
  to: number,
  minGapSec: number,
  padSec = 0.08,
): { start: number; end: number }[] {
  const spans = segments
    .flatMap((s): { start: number; end: number }[] => (s.words?.length ? s.words : [s]))
    .map((w) => ({ start: Math.max(from, w.start - padSec), end: Math.min(to, w.end + padSec) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const w of spans) {
    const last = out[out.length - 1];
    if (last && w.start - last.end <= minGapSec) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** Keep only `ranges` of the clip, packed from clip.start; `map` moves a timeline time. */
export function cutClip(
  clip: Clip,
  ranges: readonly { start: number; end: number }[],
): {
  pieces: Clip[];
  removed: number;
  map: (t: number) => number | undefined;
  /** Like `map`, but a time inside a removed pause snaps to the next (+1) / previous (-1) cut. */
  snap: (t: number, dir: 1 | -1) => number;
} {
  const pieces: Clip[] = [];
  const moves: { from: number; to: number; at: number }[] = [];
  let at = clip.start;
  for (const r of ranges) {
    const s = Math.max(r.start, clip.start);
    const e = Math.min(r.end, clipEnd(clip));
    if (e - s < 0.05) continue;
    pieces.push({
      ...clip,
      id: pieces.length ? createId("clp") : clip.id,
      start: roundTime(at),
      in: roundTime(sourceTimeAt(clip, s)),
      out: roundTime(sourceTimeAt(clip, e)),
      transitionIn: undefined,
      transitionOut: undefined,
    });
    moves.push({ from: s, to: e, at });
    at += e - s;
  }
  const removed = clipEnd(clip) - at;
  const map = (t: number) => {
    if (t >= clipEnd(clip)) return t - removed;
    if (t < clip.start) return t;
    const m = moves.find((x) => t >= x.from - 1e-3 && t <= x.to + 1e-3);
    return m ? m.at + Math.min(Math.max(t, m.from), m.to) - m.from : undefined;
  };
  const snap = (t: number, dir: 1 | -1) => {
    const direct = map(t);
    if (direct !== undefined) return direct;
    const next = moves.find((x) => x.from > t);
    const prev = [...moves].reverse().find((x) => x.to < t);
    if (dir > 0) return next ? next.at : prev ? prev.at + prev.to - prev.from : clip.start;
    return prev ? prev.at + prev.to - prev.from : next ? next.at : clip.start;
  };
  return { pieces, removed, map, snap };
}
