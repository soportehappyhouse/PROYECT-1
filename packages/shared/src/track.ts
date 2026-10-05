import { fitRect, type Size } from "./frame.js";
import { simplifyKeyframesToRate, sortKeyframes, type Keyframe, type Vec2 } from "./keyframes.js";
import type { Clip, Project } from "./timeline.js";
import {
  TRACK_AWARE_TEMPLATES,
  type TrackAnchor,
  type TrackFile,
  type TrackFrame,
} from "./vision.js";

/**
 * Track geometry shared by the export compiler, the motion renders and the web preview:
 * a TrackFile (source fractions, source seconds) is mapped onto the canvas through the video
 * clips that show the tracked asset, then the follower's center = anchor point + offset.
 */

const clipEnd = (c: Pick<Clip, "start" | "in" | "out" | "speed">) =>
  c.start + Math.max(0, (c.out - c.in) / (c.speed || 1));

/** Box at `t` (same time base as the frames): linear between frames, clamped at the ends. */
export function trackBoxAt(frames: readonly TrackFrame[], t: number): TrackFrame | undefined {
  if (frames.length === 0) return undefined;
  const fs = sortKeyframes(frames);
  if (t <= fs[0]!.t) return fs[0];
  const last = fs[fs.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = fs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fs[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = fs[lo]!;
  const b = fs[hi]!;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  const l = (p: number, q: number) => p + (q - p) * k;
  return {
    t,
    x: l(a.x, b.x),
    y: l(a.y, b.y),
    w: l(a.w, b.w),
    h: l(a.h, b.h),
    conf: l(a.conf, b.conf),
  };
}

/** Anchor point of a box: center, top-middle or bottom-middle. */
export function anchorPoint(
  box: Pick<TrackFrame, "x" | "y" | "w" | "h">,
  anchor: TrackAnchor,
): Vec2 {
  const x = box.x + box.w / 2;
  const y = anchor === "top" ? box.y : anchor === "bottom" ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}

/** Follower center at `t` on a canvas-space track (output of trackToCanvas). */
export function trackPointAt(
  canvasTrack: Pick<TrackFile, "frames">,
  t: number,
  anchor: TrackAnchor = "center",
  offset: Vec2 = { x: 0, y: 0 },
): Vec2 | undefined {
  const box = trackBoxAt(canvasTrack.frames, t);
  if (!box) return undefined;
  const p = anchorPoint(box, anchor);
  return { x: p.x + offset.x, y: p.y + offset.y };
}

/**
 * Map a TrackFile onto the canvas for `follower`: frame times become seconds relative to the
 * follower's start and boxes become canvas fractions. Every visible video clip showing
 * `track.source.assetId` contributes the frames inside its [in, out] (split clips keep working);
 * without such a clip the source is assumed to fill the canvas with source time = timeline time.
 */
export function trackToCanvas(
  project: Pick<Project, "tracks" | "settings">,
  follower: Pick<Clip, "start" | "in" | "out" | "speed">,
  track: TrackFile,
  mediaSize: (assetId: string) => Size | undefined,
): TrackFile {
  const canvas = { width: project.settings.width, height: project.settings.height };
  const sourceId = track.source.assetId;
  const media = mediaSize(sourceId);
  const dur = clipEnd(follower) - follower.start;
  const margin = 1 / Math.max(1, track.fps);
  const vclips = project.tracks
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c) => c.assetId === sourceId);
  const frames: TrackFrame[] = [];
  const mapBox = (f: TrackFrame, c: Pick<Clip, "scale" | "position" | "crop"> | undefined) => {
    const rect = fitRect(canvas, media, c ?? {});
    let { x, y, w, h } = f;
    const crop = c?.crop;
    if (crop && media?.width && media.height) {
      x = (x * media.width - crop.x) / crop.width;
      y = (y * media.height - crop.y) / crop.height;
      w = (w * media.width) / crop.width;
      h = (h * media.height) / crop.height;
    }
    return {
      x: (rect.x + x * rect.width) / canvas.width,
      y: (rect.y + y * rect.height) / canvas.height,
      w: (w * rect.width) / canvas.width,
      h: (h * rect.height) / canvas.height,
    };
  };
  const push = (f: TrackFrame, timeline: number, c?: Clip) => {
    const t = timeline - follower.start;
    if (t < -margin - 1e-9 || t > dur + margin + 1e-9) return;
    frames.push({ ...f, ...mapBox(f, c), t });
  };
  if (vclips.length === 0) {
    for (const f of track.frames) push(f, f.t);
  } else {
    for (const c of vclips) {
      const speed = c.speed || 1;
      for (const f of track.frames)
        if (f.t >= c.in - margin - 1e-9 && f.t <= c.out + margin + 1e-9)
          push(f, c.start + (f.t - c.in) / speed, c);
    }
  }
  return { ...track, frames: sortKeyframes(frames) };
}

/**
 * Position keyframes (clip-relative seconds, canvas fractions of the CENTER) that make
 * `follower` follow its trackRef: samples at the track frames clamped to [0, duration], linear,
 * simplified to at most `perSecond` keyframes per second (RDP, synchronized distance).
 */
export function trackRefKeyframes(
  project: Pick<Project, "tracks" | "settings">,
  follower: Pick<Clip, "start" | "in" | "out" | "speed" | "trackRef">,
  track: TrackFile,
  mediaSize: (assetId: string) => Size | undefined,
  perSecond = 30,
  epsilon = 0.0005,
): Keyframe<Vec2>[] {
  const ref = follower.trackRef;
  if (!ref) return [];
  const canvasTrack = trackToCanvas(project, follower, track, mediaSize);
  if (canvasTrack.frames.length === 0) return [];
  const dur = clipEnd(follower) - follower.start;
  const at = (t: number): Keyframe<Vec2> => ({
    t,
    v: trackPointAt(canvasTrack, t, ref.anchor, ref.offset)!,
    ease: "linear",
  });
  const inner = canvasTrack.frames
    .filter((f) => f.t > 1e-6 && f.t < dur - 1e-6)
    .map((f) => at(f.t));
  const all = [at(0), ...inner, ...(dur > 1e-6 ? [at(dur)] : [])];
  return simplifyKeyframesToRate(all, perSecond, epsilon);
}

/** True when a motion clip renders its own track position (the api passes `props.track`). */
export function rendersOwnTrack(clip: Pick<Clip, "motion" | "trackRef">): boolean {
  const tpl = clip.motion?.template;
  return !!clip.trackRef && !!tpl && (TRACK_AWARE_TEMPLATES as readonly string[]).includes(tpl);
}

/**
 * Project copy where every `trackRef` (except motion templates that render the track themselves)
 * is replaced by `keyframes.position` (≤ `perSecond` keyframes per second). Clips whose track is
 * missing keep their trackRef (callers warn and ignore it).
 */
export function resolveTrackRefs<P extends Pick<Project, "tracks" | "settings">>(
  project: P,
  tracks: ReadonlyMap<string, TrackFile>,
  mediaSize: (assetId: string) => Size | undefined,
  perSecond = 30,
): P {
  return {
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!c.trackRef || rendersOwnTrack(c)) return c;
        const tf = tracks.get(c.trackRef.assetId);
        if (!tf) return c;
        const position = trackRefKeyframes(project, c, tf, mediaSize, perSecond);
        if (position.length === 0) return c;
        const { trackRef: _drop, ...rest } = c;
        return { ...rest, keyframes: { ...c.keyframes, position } };
      }),
    })),
  };
}
