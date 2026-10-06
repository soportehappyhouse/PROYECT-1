import { nextTrackOrder } from "@studio/shared";
import type { Clip, CutRange, Project, SubtitleSegment, Track } from "@studio/shared";
import { HttpError } from "../lib/errors.js";

/**
 * Server-side timeline edits (Sprint 1, job `timeline.apply-cuts`). Pure functions over a Project:
 * the caller saves the result. Mirrors the dashboard's «Quitar silencios» (apps/web lib/silences.ts)
 * so both paths behave the same.
 */

const EPS = 1e-3;
/** Kept pieces shorter than this are dropped (their time is removed too). */
const MIN_PIECE_SEC = 0.04;

const round = (t: number) => Math.round(t * 1e6) / 1e6;
const clipDur = (c: Pick<Clip, "in" | "out" | "speed">) =>
  Math.max(0, (c.out - c.in) / (c.speed || 1));
const clipEnd = (c: Pick<Clip, "start" | "in" | "out" | "speed">) => c.start + clipDur(c);

export interface CutMapping {
  /** Timeline seconds removed. */
  removed: number;
  /** New time of a timeline time, undefined when it falls inside a removed range. */
  map(t: number): number | undefined;
  /** Like map, but a removed time snaps to the next (dir 1) / previous (dir -1) kept instant. */
  snap(t: number, dir: 1 | -1): number;
}

export interface ApplyCutsOutcome {
  project: Project;
  removedSec: number;
  pieceIds: string[];
}

/** Merge source-time cuts into sorted, disjoint timeline ranges inside the clip. */
export function cutsToTimeline(clip: Clip, cuts: readonly CutRange[]): CutRange[] {
  const speed = clip.speed || 1;
  const toTimeline = (src: number) => clip.start + (src - clip.in) / speed;
  const ranges = cuts
    .map((c) => ({
      start: toTimeline(Math.max(clip.in, Math.min(c.start, c.end))),
      end: toTimeline(Math.min(clip.out, Math.max(c.start, c.end))),
    }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);
  const out: CutRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Split `clip` keeping everything but the timeline `cuts`; pieces are packed from clip.start.
 * The first piece keeps the clip id (and transitionIn when it starts the clip), the last one keeps
 * transitionOut when it ends the clip.
 */
export function splitClip(
  clip: Clip,
  cuts: readonly CutRange[],
  newId: () => string,
): { pieces: Clip[]; mapping: CutMapping } {
  const start = clip.start;
  const end = clipEnd(clip);
  const speed = clip.speed || 1;
  const keep: CutRange[] = [];
  let cursor = start;
  for (const c of cuts) {
    if (c.start - cursor > EPS) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (end - cursor > EPS) keep.push({ start: cursor, end });
  const kept = keep.filter((k) => k.end - k.start >= MIN_PIECE_SEC);

  const moves: { from: number; to: number; at: number }[] = [];
  const pieces: Clip[] = [];
  let at = start;
  kept.forEach((k, i) => {
    const piece: Clip = {
      ...clip,
      id: i === 0 ? clip.id : newId(),
      start: round(at),
      in: round(clip.in + (k.start - start) * speed),
      out: round(clip.in + (k.end - start) * speed),
    };
    delete piece.transitionIn;
    delete piece.transitionOut;
    if (clip.transitionIn && Math.abs(k.start - start) <= EPS)
      piece.transitionIn = clip.transitionIn;
    if (clip.transitionOut && Math.abs(k.end - end) <= EPS)
      piece.transitionOut = clip.transitionOut;
    pieces.push(piece);
    moves.push({ from: k.start, to: k.end, at });
    at += k.end - k.start;
  });
  const removed = round(end - at);

  const map = (t: number): number | undefined => {
    if (t >= end - EPS) return round(t - removed);
    if (t <= start + EPS) return t;
    const m = moves.find((x) => t >= x.from - EPS && t <= x.to + EPS);
    return m ? round(m.at + Math.min(Math.max(t, m.from), m.to) - m.from) : undefined;
  };
  const snap = (t: number, dir: 1 | -1): number => {
    const direct = map(t);
    if (direct !== undefined) return direct;
    const next = moves.find((x) => x.from > t);
    const prev = [...moves].reverse().find((x) => x.to < t);
    const prevEnd = prev ? round(prev.at + prev.to - prev.from) : undefined;
    if (dir > 0) return next ? round(next.at) : (prevEnd ?? start);
    return prevEnd ?? (next ? round(next.at) : start);
  };
  return { pieces, mapping: { removed, map, snap } };
}

interface TranscriptLike {
  durationSec?: number;
  segments?: {
    start: number;
    end: number;
    text?: string;
    words?: { start: number; end: number }[];
  }[];
}

/**
 * An animated-captions clip shows words at fixed times: remap them through the cut (words inside a
 * removed range disappear), move/resize the clip and drop its render (it must be rendered again).
 * Returns undefined when nothing of it is left.
 */
function remapCaptionsClip(clip: Clip, m: CutMapping): Clip | undefined {
  const start = m.snap(clip.start, 1);
  const end = m.snap(clipEnd(clip), -1);
  if (end - start < 0.05) return undefined;
  const motion = clip.motion!;
  const transcript = motion.props.transcript as TranscriptLike | undefined;
  const rel = (abs: number | undefined) =>
    abs === undefined ? undefined : round(Math.max(0, abs - start));
  const segments = transcript?.segments
    ?.map((s) => {
      const a = m.snap(clip.start + s.start, 1);
      const b = m.snap(clip.start + s.end, -1);
      if (b - a < 0.05) return undefined;
      const words = s.words
        ?.map((w) => ({
          ...w,
          start: rel(m.map(clip.start + w.start)),
          end: rel(m.map(clip.start + w.end)),
        }))
        .filter(
          (w): w is typeof w & { start: number; end: number } =>
            w.start !== undefined && w.end !== undefined && w.end - w.start > 0.01,
        );
      return { ...s, start: rel(a)!, end: rel(b)!, ...(words && { words }) };
    })
    .filter((s) => s !== undefined);
  const dur = round(end - start);
  const next: Clip = {
    ...clip,
    start,
    out: round(clip.in + dur * (clip.speed || 1)),
    motion: {
      ...motion,
      durationSec: dur,
      props: {
        ...motion.props,
        ...(transcript && {
          transcript: { ...transcript, durationSec: dur, segments: segments ?? [] },
        }),
      },
    },
  };
  delete next.renderedAssetId;
  return next;
}

/**
 * Overlays linked to the cut clip (motion and text clips overlapping it) follow the edit: their
 * start snaps to the next kept instant; animated captions are re-timed word by word. Overlays after
 * the clip ripple left with it. Audio tracks and other video tracks are not touched.
 */
function moveOverlay(clip: Clip, m: CutMapping, span: CutRange): Clip | undefined {
  const end = clipEnd(clip);
  if (end <= span.start + EPS) return clip;
  if (clip.start >= span.end - EPS) return { ...clip, start: round(clip.start - m.removed) };
  if (clip.motion?.template === "animated-captions") return remapCaptionsClip(clip, m);
  return { ...clip, start: m.snap(clip.start, 1) };
}

function moveSubtitle(s: SubtitleSegment, m: CutMapping): SubtitleSegment | undefined {
  const a = m.snap(s.start, 1);
  const b = m.snap(s.end, -1);
  if (b - a < 0.05) return undefined;
  const words = s.words
    ?.map((w) => ({ ...w, start: m.map(w.start), end: m.map(w.end) }))
    .filter(
      (w): w is typeof w & { start: number; end: number } =>
        w.start !== undefined && w.end !== undefined && w.end - w.start > 0.01,
    );
  return { ...s, start: a, end: b, ...(words && { words }) };
}

/**
 * timeline.apply-cuts: split `clipId` removing `cuts` (SOURCE seconds of its asset, as returned by
 * analyze.silences), ripple the following clips of the same track, keep linked overlays and the
 * subtitles in sync. Throws HttpError 404/409/400 for a missing clip, a locked track or no-op cuts.
 */
export function applyCuts(
  project: Project,
  clipId: string,
  cuts: readonly CutRange[],
  newId: () => string,
): ApplyCutsOutcome {
  let track: Track | undefined;
  let clip: Clip | undefined;
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) {
      track = t;
      clip = c;
      break;
    }
  }
  if (!track || !clip) throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
  if (track.locked)
    throw new HttpError(409, "TRACK_LOCKED", `La pista «${track.name}» está bloqueada`);
  const ranges = cutsToTimeline(clip, cuts);
  if (ranges.length === 0) throw new HttpError(400, "NO_CUTS", "Ningún corte cae dentro del clip");
  const { pieces, mapping } = splitClip(clip, ranges, newId);
  if (mapping.removed < EPS) throw new HttpError(400, "NO_CUTS", "Los cortes no quitan nada");
  const span = { start: clip.start, end: clipEnd(clip) };
  const target = track;

  const tracks = project.tracks.map((t): Track => {
    if (t === target) {
      const others = t.clips
        .filter((c) => c.id !== clipId)
        .map((c) =>
          c.start >= span.end - EPS ? { ...c, start: round(c.start - mapping.removed) } : c,
        );
      return { ...t, clips: [...others, ...pieces].sort((a, b) => a.start - b.start) };
    }
    if (t.kind !== "motion" && t.kind !== "text") return t;
    return {
      ...t,
      clips: t.clips
        .map((c) => moveOverlay(c, mapping, span))
        .filter((c): c is Clip => c !== undefined),
    };
  });
  const subtitles = project.subtitles
    .map((s) => moveSubtitle(s, mapping))
    .filter((s): s is SubtitleSegment => s !== undefined);
  return {
    project: { ...project, tracks, subtitles },
    removedSec: mapping.removed,
    pieceIds: pieces.map((p) => p.id),
  };
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      if (track.locked)
        throw new HttpError(409, "TRACK_LOCKED", `La pista «${track.name}» está bloqueada`);
      return { track, clip };
    }
  }
  throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
}

/** dB -> Clip.volume (linear gain 0..4); -60 dB or less = muted (0). */
export function dbToVolume(db: number): number {
  if (db <= -60) return 0;
  return Math.min(4, Math.max(0, Math.round(10 ** (db / 20) * 1000) / 1000));
}

/**
 * Sprint 3 `set_volume`: the clip's gain relative to the original (0 dB = 1). Returns a new
 * project (the caller saves it). Throws HttpError 404/409 for a missing clip or a locked track.
 */
export function setClipVolume(
  project: Project,
  clipId: string,
  volumeDb: number,
): { project: Project; volume: number } {
  findClip(project, clipId);
  const volume = dbToVolume(volumeDb);
  const tracks = project.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, volume } : c)),
  }));
  return { project: { ...project, tracks }, volume };
}

/**
 * Sprint 3 `move_clip`: new timeline start for a clip (content, keyframes and in/out unchanged).
 * It stays on its track when that range is free there; otherwise it goes to the first unlocked
 * track of the same kind that is free (a new track when none is). Returns a new project.
 */
export function moveClip(
  project: Project,
  clipId: string,
  t: number,
  newId: () => string,
): { project: Project; trackId: string; start: number } {
  const { track, clip } = findClip(project, clipId);
  const start = round(Math.max(0, t));
  const end = start + clipDur(clip);
  const free = (x: Track) =>
    !x.locked &&
    !x.clips.some((c) => c.id !== clipId && c.start < end - EPS && clipEnd(c) > start + EPS);
  const tracks = project.tracks.map((x) => ({ ...x, clips: [...x.clips] }));
  let target = free(track) ? tracks[project.tracks.indexOf(track)]! : undefined;
  target ??= tracks.find((x) => x.kind === track.kind && free(x));
  if (!target) {
    const n = tracks.filter((x) => x.kind === track.kind).length + 1;
    const name = { video: "Video", audio: "Audio", text: "Texto", motion: "Motion" }[track.kind];
    // A new track goes on top of the z-order, never tied with `track`.
    const { order: _order, ...rest } = track;
    const order = nextTrackOrder(tracks);
    target = {
      ...rest,
      id: newId(),
      name: `${name} ${n}`,
      muted: false,
      hidden: false,
      clips: [],
      ...(order !== undefined && { order }),
    };
    tracks.push(target);
  }
  const source = tracks[project.tracks.indexOf(track)]!;
  source.clips = source.clips.filter((c) => c.id !== clipId);
  target.clips = [...target.clips, { ...clip, trackId: target.id, start }].sort(
    (a, b) => a.start - b.start,
  );
  return { project: { ...project, tracks }, trackId: target.id, start };
}
