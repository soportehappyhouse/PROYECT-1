import type { Clip, MediaAsset, Project } from "@studio/shared";
import type { SceneRange } from "./ai-types";
import { roundTime } from "./format";
import { clipEnd, MIN_CLIP_DURATION, splitClip } from "./timeline";

/** Scene list of an asset: the web cache first, then `asset.scenes` saved by the api. */
export type ScenesLookup = (assetId: string) => readonly SceneRange[] | undefined;

/** analyze.scenes stores the list in the asset (field not yet in the shared schema). */
export function assetScenes(asset: MediaAsset | undefined): SceneRange[] | undefined {
  const scenes = (asset as (MediaAsset & { scenes?: unknown }) | undefined)?.scenes;
  return Array.isArray(scenes) ? (scenes as SceneRange[]) : undefined;
}

export interface SceneMarker {
  /** Timeline time. */
  time: number;
  clipId: string;
  score?: number;
}

/**
 * Scene cuts of one clip in timeline time: every scene start (source time) strictly inside the
 * clip's trimmed range, mapped through its position and speed.
 */
export function clipSceneTimes(
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
  scenes: readonly SceneRange[],
): number[] {
  const speed = clip.speed || 1;
  const out = new Set<number>();
  for (const s of scenes) {
    if (s.start <= clip.in + MIN_CLIP_DURATION || s.start >= clip.out - MIN_CLIP_DURATION) continue;
    out.add(roundTime(clip.start + (s.start - clip.in) / speed));
  }
  return [...out].sort((a, b) => a - b);
}

/** Every scene marker of the project (video clips whose asset has scenes). */
export function sceneMarkers(
  project: Pick<Project, "tracks">,
  lookup: ScenesLookup,
): SceneMarker[] {
  const markers: SceneMarker[] = [];
  for (const t of project.tracks) {
    if (t.kind !== "video" || t.hidden) continue;
    for (const c of t.clips) {
      const scenes = c.assetId ? lookup(c.assetId) : undefined;
      if (!scenes?.length) continue;
      for (const time of clipSceneTimes(c, scenes)) markers.push({ time, clipId: c.id });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** Split a clip at several timeline times (left to right). Returns the pieces in order. */
export function splitClipAtTimes(clip: Clip, times: readonly number[]): Clip[] {
  const pieces: Clip[] = [];
  let rest = clip;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t <= rest.start || t >= clipEnd(rest)) continue;
    const parts = splitClip(rest, t);
    if (!parts) continue;
    pieces.push(parts[0]);
    rest = parts[1];
  }
  pieces.push(rest);
  return pieces;
}
