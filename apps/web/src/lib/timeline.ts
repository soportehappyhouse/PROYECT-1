import { nextTrackOrder } from "@studio/shared";
import type { Clip, MediaAsset, Project, Track, TrackKind } from "@studio/shared";
import { createId } from "./ids";
import { roundTime } from "./format";

/** Minimum clip length on the timeline (seconds). */
export const MIN_CLIP_DURATION = 0.05;
/** Default length of text / motion clips (seconds). */
export const DEFAULT_GENERATED_CLIP_DURATION = 5;

export const TRACK_KIND_LABELS: Record<TrackKind, string> = {
  video: "Video",
  audio: "Audio",
  text: "Texto",
  motion: "Motion",
};

/** Duration of a clip on the timeline: (out - in) / speed. */
export function clipDuration(clip: Pick<Clip, "in" | "out" | "speed">): number {
  return Math.max(0, (clip.out - clip.in) / (clip.speed || 1));
}

/**
 * Playhead one frame before/after `time`, snapped to the frame grid. The playhead is rounded to
 * ms, so adding 1/fps repeatedly drifted (30 × «Fotograma siguiente» = 0.99 s at 30 fps).
 */
export function stepFrame(time: number, fps: number, direction: 1 | -1): number {
  const f = fps > 0 ? fps : 30;
  return Math.max(0, (Math.round(time * f) + direction) / f);
}

export function clipEnd(clip: Pick<Clip, "start" | "in" | "out" | "speed">): number {
  return clip.start + clipDuration(clip);
}

/** Source time (inside the media file) shown at a given timeline time. */
export function sourceTimeAt(clip: Clip, timelineTime: number): number {
  return clip.in + (timelineTime - clip.start) * (clip.speed || 1);
}

export function projectDuration(project: Pick<Project, "tracks">): number {
  let end = 0;
  for (const track of project.tracks)
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

export function findClip(
  project: Pick<Project, "tracks">,
  clipId: string,
): { track: Track; clip: Clip; trackIndex: number; clipIndex: number } | undefined {
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
    const track = project.tracks[trackIndex]!;
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) return { track, clip: track.clips[clipIndex]!, trackIndex, clipIndex };
  }
  return undefined;
}

/** Topmost (first in track order) visible clip of the given kinds under `time`. */
export function clipAt(
  project: Pick<Project, "tracks">,
  time: number,
  kinds: readonly TrackKind[] = ["video"],
): { track: Track; clip: Clip } | undefined {
  for (const track of project.tracks) {
    if (!kinds.includes(track.kind) || track.hidden) continue;
    // Later clips win on overlap (they were placed on top).
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const clip = track.clips[i]!;
      if (time >= clip.start && time < clipEnd(clip)) return { track, clip };
    }
  }
  return undefined;
}

/** All clips of the given kinds under `time`. */
export function clipsAt(
  project: Pick<Project, "tracks">,
  time: number,
  kinds: readonly TrackKind[],
): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of project.tracks) {
    if (!kinds.includes(track.kind) || track.hidden) continue;
    for (const clip of track.clips)
      if (time >= clip.start && time < clipEnd(clip)) out.push({ track, clip });
  }
  return out;
}

/**
 * A rendered motion overlay (motion.render output: a video under renders/, usually with alpha).
 * Feedback 1/12: these go to Motion tracks and never need a proxy.
 */
export function isMotionRenderAsset(
  asset: Pick<MediaAsset, "kind" | "path"> & Partial<Pick<MediaAsset, "hasAlpha" | "name">>,
): boolean {
  return asset.kind === "video" && asset.path.startsWith("renders/");
}

/** Which track kind accepts a media kind. */
export function trackKindForAsset(
  asset: Pick<MediaAsset, "kind"> & Partial<Pick<MediaAsset, "path">>,
): TrackKind {
  if (asset.path && isMotionRenderAsset({ kind: asset.kind, path: asset.path })) return "motion";
  switch (asset.kind) {
    case "audio":
      return "audio";
    case "lottie":
      return "motion";
    case "subtitle":
      return "text";
    default:
      return "video";
  }
}

export function canPlaceOnTrack(trackKind: TrackKind, clipKind: TrackKind): boolean {
  return trackKind === clipKind;
}

/** New empty track meant to be appended to `existing` (on top of the z-order). */
export function createTrack(kind: TrackKind, existing: readonly Track[] = []): Track {
  const n = existing.filter((t) => t.kind === kind).length + 1;
  const order = nextTrackOrder(existing);
  return {
    id: createId("trk"),
    kind,
    name: `${TRACK_KIND_LABELS[kind]} ${n}`,
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
    ...(order !== undefined && { order }),
  };
}

function baseClip(trackId: string, start: number, out: number): Clip {
  return {
    id: createId("clp"),
    trackId,
    start: roundTime(Math.max(0, start)),
    in: 0,
    out: roundTime(out),
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
  };
}

export function createClipFromAsset(
  asset: Pick<MediaAsset, "id" | "kind" | "durationSec">,
  trackId: string,
  start: number,
): Clip {
  const duration =
    asset.durationSec && asset.durationSec > 0
      ? asset.durationSec
      : asset.kind === "image"
        ? DEFAULT_GENERATED_CLIP_DURATION
        : DEFAULT_GENERATED_CLIP_DURATION;
  return { ...baseClip(trackId, start, duration), assetId: asset.id };
}

export function createTextClip(trackId: string, start: number, text = "Texto"): Clip {
  return {
    ...baseClip(trackId, start, DEFAULT_GENERATED_CLIP_DURATION),
    text,
    textStyle: {
      fontFamily: "Inter",
      fontSize: 64,
      color: "#ffffff",
      position: "bottom",
    },
  };
}

/** Move a clip to a new start (and optionally another track of the same kind). */
export function moveClip(
  tracks: readonly Track[],
  clipId: string,
  newStart: number,
  newTrackId?: string,
): Track[] {
  const found = findClip({ tracks: tracks as Track[] }, clipId);
  if (!found) return tracks as Track[];
  const target = newTrackId ? tracks.find((t) => t.id === newTrackId) : found.track;
  const destination =
    target && canPlaceOnTrack(target.kind, found.track.kind) && !target.locked
      ? target
      : found.track;
  const moved: Clip = {
    ...found.clip,
    trackId: destination.id,
    start: roundTime(Math.max(0, newStart)),
  };
  return tracks.map((t) => {
    if (t.id === found.track.id && t.id === destination.id)
      return { ...t, clips: sortClips(t.clips.map((c) => (c.id === clipId ? moved : c))) };
    if (t.id === found.track.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
    if (t.id === destination.id) return { ...t, clips: sortClips([...t.clips, moved]) };
    return t;
  });
}

export function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * Trim the left edge so the clip starts at `newStart` (keeps its end fixed).
 * `in` moves accordingly and is clamped to [0, out - MIN].
 */
export function trimClipStart(clip: Clip, newStart: number): Clip {
  const speed = clip.speed || 1;
  const end = clipEnd(clip);
  const minStart = clip.start - clip.in / speed; // can't go before source 0
  const maxStart = end - MIN_CLIP_DURATION;
  const start = Math.min(maxStart, Math.max(minStart, Math.max(0, newStart)));
  const newIn = clip.in + (start - clip.start) * speed;
  return { ...clip, start: roundTime(start), in: roundTime(Math.max(0, newIn)) };
}

/**
 * Trim the right edge so the clip ends at `newEnd`.
 * `maxSourceDuration` (asset duration) caps `out`; generated clips (text/motion) have no cap.
 */
export function trimClipEnd(clip: Clip, newEnd: number, maxSourceDuration?: number): Clip {
  const speed = clip.speed || 1;
  const minEnd = clip.start + MIN_CLIP_DURATION;
  let out = clip.in + (Math.max(minEnd, newEnd) - clip.start) * speed;
  if (maxSourceDuration !== undefined && maxSourceDuration > 0)
    out = Math.min(out, maxSourceDuration);
  return { ...clip, out: roundTime(out) };
}

/** Split a clip at timeline time `at`. Returns undefined when `at` is not strictly inside. */
export function splitClip(clip: Clip, at: number): [Clip, Clip] | undefined {
  const end = clipEnd(clip);
  if (at <= clip.start + MIN_CLIP_DURATION / 2 || at >= end - MIN_CLIP_DURATION / 2)
    return undefined;
  const cut = roundTime(sourceTimeAt(clip, at));
  const { transitionIn, transitionOut, ...rest } = clip;
  const left: Clip = { ...rest, out: cut, ...(transitionIn ? { transitionIn } : {}) };
  const right: Clip = {
    ...rest,
    id: createId("clp"),
    start: roundTime(at),
    in: cut,
    ...(transitionOut ? { transitionOut } : {}),
  };
  return [left, right];
}

export function replaceClip(tracks: readonly Track[], clip: Clip): Track[] {
  return tracks.map((t) =>
    t.id === clip.trackId
      ? { ...t, clips: sortClips(t.clips.map((c) => (c.id === clip.id ? clip : c))) }
      : t,
  );
}

export function removeClip(tracks: readonly Track[], clipId: string): Track[] {
  return tracks.map((t) =>
    t.clips.some((c) => c.id === clipId)
      ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
      : t,
  );
}

export function insertClip(tracks: readonly Track[], clip: Clip): Track[] {
  return tracks.map((t) =>
    t.id === clip.trackId ? { ...t, clips: sortClips([...t.clips, clip]) } : t,
  );
}

/** Snap points: 0, playhead and every clip edge (except the clip being edited). */
export function snapPoints(
  tracks: readonly Track[],
  excludeClipId: string | undefined,
  playhead: number,
): number[] {
  const points = new Set<number>([0, playhead]);
  for (const t of tracks)
    for (const c of t.clips) {
      if (c.id === excludeClipId) continue;
      points.add(c.start);
      points.add(clipEnd(c));
    }
  return [...points];
}

/** Snap `time` to the nearest point within `threshold` seconds; returns the original otherwise. */
export function snapTime(time: number, points: readonly number[], threshold: number): number {
  let best = time;
  let bestDist = threshold;
  for (const p of points) {
    const d = Math.abs(p - time);
    if (d <= bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Snap a moving clip: tries to align its start or its end to a snap point and returns the
 * corrected start.
 */
export function snapClipStart(
  start: number,
  duration: number,
  points: readonly number[],
  threshold: number,
): number {
  const snappedStart = snapTime(start, points, threshold);
  const snappedEnd = snapTime(start + duration, points, threshold);
  const dStart = Math.abs(snappedStart - start);
  const dEnd = Math.abs(snappedEnd - (start + duration));
  if (snappedStart !== start && (snappedEnd === start + duration || dStart <= dEnd))
    return snappedStart;
  if (snappedEnd !== start + duration) return snappedEnd - duration;
  return start;
}

/** Find a free spot on a track at or after `from` for a clip of `duration` seconds. */
export function firstFreeStart(track: Track, from: number, duration: number): number {
  let start = from;
  for (const c of sortClips(track.clips)) {
    const end = clipEnd(c);
    if (start + duration <= c.start) break;
    if (start < end) start = end;
  }
  return roundTime(start);
}

/** Track kinds whose clips must not overlap (feedback 5); text clips may stack freely. */
export const NO_OVERLAP_KINDS: readonly TrackKind[] = ["video", "audio", "motion"];

/** Whether [start, start + duration) hits another clip of the track. */
export function overlapsOnTrack(
  track: Pick<Track, "clips">,
  start: number,
  duration: number,
  excludeClipId?: string,
): boolean {
  const end = start + duration;
  return track.clips.some(
    (c) => c.id !== excludeClipId && start < clipEnd(c) - 1e-3 && end > c.start + 1e-3,
  );
}

/**
 * Closest start to `desired` where a clip of `duration` fits on the track without overlapping
 * (snaps to the end of the previous clip or before the next one; after the last clip always fits).
 */
export function nearestFreeStart(
  track: Pick<Track, "clips">,
  desired: number,
  duration: number,
  excludeClipId?: string,
): number {
  const want = Math.max(0, desired);
  if (!overlapsOnTrack(track, want, duration, excludeClipId)) return want;
  const others = sortClips(track.clips.filter((c) => c.id !== excludeClipId));
  const candidates: number[] = [];
  let prevEnd = 0;
  for (const c of others) {
    // gap [prevEnd, c.start): try both edges
    if (c.start - prevEnd >= duration - 1e-3) {
      candidates.push(Math.min(Math.max(want, prevEnd), c.start - duration));
    }
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  candidates.push(Math.max(want, prevEnd));
  let best = candidates[0]!;
  for (const c of candidates) if (Math.abs(c - want) < Math.abs(best - want)) best = c;
  return roundTime(Math.max(0, best));
}

/** Limits for trimming a clip's edges so it never covers its neighbours. */
export function trimLimits(
  track: Pick<Track, "clips">,
  clip: Clip,
): { minStart: number; maxEnd: number } {
  let minStart = 0;
  let maxEnd = Infinity;
  for (const c of track.clips) {
    if (c.id === clip.id) continue;
    if (clipEnd(c) <= clip.start + 1e-3) minStart = Math.max(minStart, clipEnd(c));
    else if (c.start >= clipEnd(clip) - 1e-3) maxEnd = Math.min(maxEnd, c.start);
  }
  return { minStart, maxEnd };
}

// ---- Sprint 5 (M2): ripple, gaps, Q/W and rectangle selection ------------------------------------

/** A time range on the timeline [start, end). */
export interface TimeRange {
  start: number;
  end: number;
}

/** Union of ranges (sorted, overlapping/touching ones merged). */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end - r.start > 1e-6).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Time `t` once `removed` (merged) ranges are cut out: t − the removed portion before t. */
export function rippleTime(t: number, removed: readonly TimeRange[]): number {
  let shift = 0;
  for (const r of removed) {
    if (r.start >= t) break;
    shift += Math.min(r.end, t) - r.start;
  }
  return roundTime(Math.max(0, t - shift));
}

/** Shift every clip of a track left by the removed time before its start. */
function rippleTrackClips(clips: readonly Clip[], removed: readonly TimeRange[]): Clip[] {
  if (removed.length === 0) return [...clips];
  return sortClips(clips.map((c) => ({ ...c, start: rippleTime(c.start, removed) })));
}

/**
 * Shift+Supr: delete `ids` and close the hole they leave on *their* tracks (other tracks and
 * locked tracks stay put; clips of locked tracks are not deleted). Returns the new tracks and the
 * removed ranges per track.
 */
export function rippleDelete(
  tracks: readonly Track[],
  ids: readonly string[],
): { tracks: Track[]; removed: Record<string, TimeRange[]> } {
  const wanted = new Set(ids);
  const removed: Record<string, TimeRange[]> = {};
  const next = tracks.map((t) => {
    if (t.locked || !t.clips.some((c) => wanted.has(c.id))) return t;
    const gone = t.clips.filter((c) => wanted.has(c.id));
    const ranges = mergeRanges(gone.map((c) => ({ start: c.start, end: clipEnd(c) })));
    removed[t.id] = ranges;
    const kept = t.clips.filter((c) => !wanted.has(c.id));
    return { ...t, clips: rippleTrackClips(kept, ranges) };
  });
  return { tracks: next, removed };
}

/** Empty ranges of a track between 0 and its last clip (union of clips = occupied). */
export function trackGaps(track: Pick<Track, "clips">): TimeRange[] {
  const busy = mergeRanges(track.clips.map((c) => ({ start: c.start, end: clipEnd(c) })));
  const gaps: TimeRange[] = [];
  let at = 0;
  for (const b of busy) {
    if (b.start - at > 1e-3) gaps.push({ start: at, end: b.start });
    at = Math.max(at, b.end);
  }
  return gaps;
}

/** «Cerrar huecos de la pista»: pack the clips leftwards (overlaps between them are kept). */
export function closeGaps(track: Track): { track: Track; removed: TimeRange[] } {
  const removed = trackGaps(track);
  if (track.locked || removed.length === 0) return { track, removed: [] };
  return { track: { ...track, clips: rippleTrackClips(track.clips, removed) }, removed };
}

/**
 * Q / W: trim the start (Q) or the end (W) of a clip to the cursor and close the gap on its track
 * (ripple). Undefined when `t` is not strictly inside the clip or its track is locked.
 */
export function trimToCursor(
  tracks: readonly Track[],
  clipId: string,
  t: number,
  edge: "start" | "end",
): { tracks: Track[]; removed: TimeRange; trackId: string } | undefined {
  const found = findClip({ tracks: tracks as Track[] }, clipId);
  if (!found || found.track.locked) return undefined;
  const { clip, track } = found;
  const end = clipEnd(clip);
  if (t <= clip.start + MIN_CLIP_DURATION || t >= end - MIN_CLIP_DURATION) return undefined;
  const removed: TimeRange =
    edge === "start" ? { start: clip.start, end: roundTime(t) } : { start: roundTime(t), end };
  const trimmed = edge === "start" ? trimClipStart(clip, t) : trimClipEnd(clip, t);
  const others = track.clips.filter((c) => c.id !== clipId);
  const shifted = rippleTrackClips(others, [removed]);
  const self = edge === "start" ? { ...trimmed, start: clip.start } : trimmed;
  return {
    tracks: tracks.map((x) =>
      x.id === track.id ? { ...x, clips: sortClips([...shifted, self]) } : x,
    ),
    removed,
    trackId: track.id,
  };
}

/** Rectangle in timeline pixels: x from time 0, y from the top of the first row. */
export interface PxRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Clips touched by a selection rectangle. `rows` are the tracks in display order (each row
 * `trackHeight` px tall); clips of locked tracks are never selected.
 */
export function clipsInRect(
  rows: readonly Track[],
  rect: PxRect,
  zoom: number,
  trackHeight = 56,
): string[] {
  const left = Math.min(rect.left, rect.right);
  const right = Math.max(rect.left, rect.right);
  const top = Math.min(rect.top, rect.bottom);
  const bottom = Math.max(rect.top, rect.bottom);
  const out: string[] = [];
  rows.forEach((track, i) => {
    const y0 = i * trackHeight;
    const y1 = y0 + trackHeight;
    if (track.locked || bottom <= y0 || top >= y1) return;
    for (const c of track.clips) {
      const x0 = c.start * zoom;
      const x1 = clipEnd(c) * zoom;
      if (x1 > left && x0 < right) out.push(c.id);
    }
  });
  return out;
}

/** Clips between two clips of the same track (by start, inclusive), for Shift+click. */
export function clipRange(track: Pick<Track, "clips">, a: string, b: string): string[] {
  const sorted = sortClips(track.clips);
  const i = sorted.findIndex((c) => c.id === a);
  const j = sorted.findIndex((c) => c.id === b);
  if (i < 0 || j < 0) return [];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return sorted.slice(lo, hi + 1).map((c) => c.id);
}
