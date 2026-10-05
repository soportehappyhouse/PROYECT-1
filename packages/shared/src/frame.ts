import type { SubtitleSegment } from "./subtitles.js";
import type { Clip, Project } from "./timeline.js";

/**
 * Frame geometry shared by the preview (web), the export compiler (api) and the motion renders:
 * where a clip lands inside the project canvas and which part of the canvas captions may use.
 */

export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned rectangle in canvas pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Margins in % of the canvas (same shape as the Remotion `safeArea` prop). */
export interface SafeAreaPercent {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Rect of a clip inside the canvas, mirroring the export filters: the media is fitted
 * (letterbox/pillarbox, `force_original_aspect_ratio=decrease`) into `scale` × canvas and the free
 * space is split by `position` (0 = left/top, 0.5 = centered, 1 = right/bottom).
 */
export function fitRect(
  canvas: Size,
  media: Size | undefined,
  placement: Pick<Clip, "scale" | "position" | "crop"> = {},
): Rect {
  const s = clamp(placement.scale ?? 1, 0.05, 1);
  const boxW = canvas.width * s;
  const boxH = canvas.height * s;
  const srcW = placement.crop?.width ?? media?.width;
  const srcH = placement.crop?.height ?? media?.height;
  let width = boxW;
  let height = boxH;
  if (srcW && srcH && srcW > 0 && srcH > 0) {
    const k = Math.min(boxW / srcW, boxH / srcH);
    width = srcW * k;
    height = srcH * k;
  }
  const px = clamp(placement.position?.x ?? 0.5, 0, 1);
  const py = clamp(placement.position?.y ?? 0.5, 0, 1);
  return {
    x: (canvas.width - width) * px,
    y: (canvas.height - height) * py,
    width,
    height,
  };
}

/** Clip end on the timeline. */
function clipEndOf(c: Pick<Clip, "start" | "in" | "out" | "speed">): number {
  return c.start + Math.max(0, (c.out - c.in) / (c.speed || 1));
}

/**
 * The video rect captions should fit at time `t` (or over the whole timeline when `t` is absent):
 * the bottom-most visible video clip with known media size. Falls back to the full canvas.
 */
export function videoRectAt(
  project: Pick<Project, "tracks" | "settings">,
  mediaSize: (assetId: string) => Size | undefined,
  t?: number,
): Rect {
  const canvas = { width: project.settings.width, height: project.settings.height };
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    const clip =
      t === undefined
        ? clips.find((c) => c.assetId && mediaSize(c.assetId))
        : clips.find(
            (c) => c.assetId && mediaSize(c.assetId) && t >= c.start && t < clipEndOf(c) + 1e-3,
          );
    if (clip?.assetId) return fitRect(canvas, mediaSize(clip.assetId), clip);
  }
  // Nothing under `t` (a gap): use the first video clip, else the whole canvas.
  if (t !== undefined) return videoRectAt(project, mediaSize);
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

/**
 * Safe area for captions inside `rect`: the rect's margins to the canvas plus an inner padding
 * (title-safe: `inner` % of the rect on each side, more at the bottom). Percent of the canvas.
 */
export function captionSafeArea(
  rect: Rect,
  canvas: Size,
  inner: SafeAreaPercent = { top: 6, bottom: 10, left: 6, right: 6 },
): SafeAreaPercent {
  const pctX = (px: number) => (px / canvas.width) * 100;
  const pctY = (px: number) => (px / canvas.height) * 100;
  const round = (v: number) => Math.round(clamp(v, 0, 45) * 100) / 100;
  return {
    left: round(pctX(rect.x + (rect.width * inner.left) / 100)),
    right: round(pctX(canvas.width - rect.x - rect.width + (rect.width * inner.right) / 100)),
    top: round(pctY(rect.y + (rect.height * inner.top) / 100)),
    bottom: round(pctY(canvas.height - rect.y - rect.height + (rect.height * inner.bottom) / 100)),
  };
}

/** True when `rect` is (almost) the whole canvas. */
export function isFullFrame(rect: Rect, canvas: Size): boolean {
  return (
    rect.x < 1 && rect.y < 1 && rect.width > canvas.width - 2 && rect.height > canvas.height - 2
  );
}

/** Time ranges covered by visible `animated-captions` motion clips. */
export function animatedCaptionRanges(
  project: Pick<Project, "tracks">,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const t of project.tracks) {
    if (t.kind !== "motion" || t.hidden) continue;
    for (const c of t.clips)
      if (c.motion?.template === "animated-captions")
        out.push({ start: c.start, end: clipEndOf(c) });
  }
  return out;
}

/**
 * Segments that are drawn as plain subtitles (burned on export, overlaid in the preview): none
 * when `burn` is off, and never the ones an animated-captions clip already shows (U8 / feedback 2:
 * otherwise they appear twice). Preview and export both use this.
 */
export function subtitlesToBurn(
  project: Pick<Project, "tracks" | "subtitles">,
  burn: boolean,
): SubtitleSegment[] {
  if (!burn) return [];
  const covered = animatedCaptionRanges(project);
  return project.subtitles.filter(
    (s) => !covered.some((r) => s.start < r.end - 1e-3 && s.end > r.start + 1e-3),
  );
}
