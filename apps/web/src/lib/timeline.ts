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

/** Which track kind accepts a media kind. */
export function trackKindForAsset(asset: Pick<MediaAsset, "kind">): TrackKind {
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

export function createTrack(kind: TrackKind, existing: readonly Track[] = []): Track {
  const n = existing.filter((t) => t.kind === kind).length + 1;
  return {
    id: createId("trk"),
    kind,
    name: `${TRACK_KIND_LABELS[kind]} ${n}`,
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
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
