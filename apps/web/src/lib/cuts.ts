import type { Clip } from "@studio/shared";
import type { SilenceCut } from "./ai-types";
import { roundTime } from "./format";
import { clipEnd } from "./timeline";

/** Shortest cut kept in the review list (anything shorter is noise). */
export const MIN_CUT_SEC = 0.05;

/** A proposed cut placed on the timeline (for the review list, the preview and the local apply). */
export interface TimelineCut {
  /** Position in the list returned by analyze.silences. */
  index: number;
  /** Timeline time. */
  start: number;
  end: number;
  duration: number;
  kind: SilenceCut["kind"];
  text?: string;
  /** The cut as the api returned it (sent back unchanged to timeline.apply-cuts). */
  source: SilenceCut;
}

/**
 * Map analyze.silences cuts (source time of the clip asset) onto the timeline, keeping only the
 * part inside the clip's trimmed range.
 */
export function cutsInClip(
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
  cuts: readonly SilenceCut[],
): TimelineCut[] {
  const speed = clip.speed || 1;
  const toTimeline = (t: number) => clip.start + (t - clip.in) / speed;
  const out: TimelineCut[] = [];
  cuts.forEach((c, index) => {
    const s = Math.max(c.start, clip.in);
    const e = Math.min(c.end, clip.out);
    if (e - s < MIN_CUT_SEC) return;
    const start = roundTime(toTimeline(s));
    const end = roundTime(toTimeline(e));
    out.push({
      index,
      start,
      end,
      duration: roundTime(end - start),
      kind: c.kind,
      ...(c.text ? { text: c.text } : {}),
      source: c,
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

export interface CutTotals {
  selected: number;
  total: number;
  silences: number;
  fillers: number;
  /** Seconds removed by the selected cuts (overlaps counted once). */
  removedSec: number;
}

/** Totals of the selected cuts. */
export function selectionTotals(
  cuts: readonly TimelineCut[],
  selected: ReadonlySet<number>,
): CutTotals {
  const chosen = cuts.filter((c) => selected.has(c.index));
  const merged = mergeRanges(chosen);
  return {
    selected: chosen.length,
    total: cuts.length,
    silences: chosen.filter((c) => c.kind === "silence").length,
    fillers: chosen.filter((c) => c.kind === "filler").length,
    removedSec: roundTime(merged.reduce((n, r) => n + (r.end - r.start), 0)),
  };
}

/** Select every cut of a kind on/off (the rest keep their state). */
export function setKindSelected(
  cuts: readonly TimelineCut[],
  selected: ReadonlySet<number>,
  kind: TimelineCut["kind"],
  on: boolean,
): Set<number> {
  const next = new Set(selected);
  for (const c of cuts) {
    if (c.kind !== kind) continue;
    if (on) next.add(c.index);
    else next.delete(c.index);
  }
  return next;
}

export function mergeRanges(
  ranges: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Ranges of the clip (timeline time) that stay after removing `cuts`. */
export function keepRanges(
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
  cuts: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const end = clipEnd(clip);
  const keep: { start: number; end: number }[] = [];
  let at = clip.start;
  for (const c of mergeRanges(cuts)) {
    const s = Math.max(clip.start, c.start);
    const e = Math.min(end, c.end);
    if (e <= s) continue;
    if (s - at >= MIN_CUT_SEC) keep.push({ start: roundTime(at), end: roundTime(s) });
    at = Math.max(at, e);
  }
  if (end - at >= MIN_CUT_SEC) keep.push({ start: roundTime(at), end: roundTime(end) });
  return keep;
}

/** Range played by «Escuchar»: the cut plus some context at each side. */
export function previewWindow(
  cut: Pick<TimelineCut, "start" | "end">,
  contextSec = 0.5,
): { start: number; end: number } {
  return { start: Math.max(0, cut.start - contextSec), end: cut.end + contextSec };
}
