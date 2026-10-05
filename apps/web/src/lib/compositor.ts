import {
  effectiveBurnSubtitles,
  fitRect,
  reframeCropAt as sharedReframeCropAt,
  rendersOwnTrack,
  subtitlesToBurn,
  trackPointAt,
  trackToCanvas,
  videoRectAt,
  type CaptionStyle,
  type Clip,
  type MediaAsset,
  type Project,
  type Rect,
  type SubtitleSegment,
  type TextStyle,
  type Track,
} from "@studio/shared";
import { cropFraction, interpolate } from "./interpolate";
import { keyframesOf, staticCrop } from "./keyframes";
import { clipDuration, clipEnd, sourceTimeAt } from "./timeline";
import type {
  CropBox,
  Keyframe,
  MatteBackground,
  ReframeTarget,
  TrackFile,
  Vec2,
} from "./vision-types";

/**
 * Multilayer preview model (Sprint 2). Concepts ported from HeyGen HyperFrames (Apache-2.0,
 * `player/lib/layerOrdering.ts`, `core/src/runtime/clock.ts`): one element per visible clip,
 * z-order by track, every layer shown only inside its time window, seek by time. Code is ours.
 *
 * Order matches the export compiler: tracks in array order (index 0 at the bottom), clips of one
 * track stacked by start (later on top, like the export lanes), subtitles above everything.
 * Geometry uses the shared helpers (fitRect, interpolate, trackToCanvas) so preview = export.
 */

export type LayerKind = "video" | "image" | "motion" | "text" | "pending-motion";

/** A media element the layer needs (the media pool keeps one element per key). */
export interface LayerSource {
  key: string;
  assetId: string;
  element: "video" | "image";
  /** Seconds inside the media at the evaluated time. */
  time: number;
  /** Media seconds per timeline second. */
  rate: number;
  /** Plays the media audio (video track clip on an unmuted track, audio clip). */
  audible: boolean;
  volume: number;
  /** Loops (matte background videos). */
  loop?: boolean;
  /** Alpha WebM / motion render: never swap to the low-res proxy. */
  keepOriginal?: boolean;
}

export interface TextPayload {
  content: string;
  style: TextStyle;
  /** Center (canvas px) when animated/tracked; otherwise the export layout (textStyle.position). */
  center?: Vec2;
}

export interface Layer {
  key: string;
  clipId: string;
  trackId: string;
  trackIndex: number;
  /** Stacking order (higher = on top). */
  z: number;
  kind: LayerKind;
  /** Destination in canvas pixels. */
  rect: Rect;
  /** Source sub-rect as fractions 0..1 of the media. */
  crop?: CropBox;
  opacity: number;
  /** Main media (video/image/motion). */
  source?: LayerSource;
  matte?: { alpha: LayerSource; background?: MatteBackground; backgroundSource?: LayerSource };
  text?: TextPayload;
  /** The layer follows a track (trackRef). */
  tracked?: boolean;
}

export interface AudioSource extends LayerSource {
  clipId: string;
}

export interface Composition {
  layers: Layer[];
  /** Audio-only clips (audio tracks). Video clips play their own sound through `source`. */
  audio: AudioSource[];
  subtitle?: { segment: SubtitleSegment; rect: Rect };
}

export interface CompositorInput {
  project: Project;
  assets: Record<string, MediaAsset>;
  time: number;
  /** Loaded track files (trackRef); a missing one leaves the clip at its static position. */
  trackFile?: (assetId: string) => TrackFile | undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function mediaSize(a: MediaAsset | undefined) {
  return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
}

function isActive(c: Clip, t: number): boolean {
  return t >= c.start && t < clipEnd(c);
}

/** Fade/crossfade transitions as an opacity ramp (wipe/slide/zoom only fade in the preview). */
function transitionAlpha(c: Clip, t: number): number {
  const dur = clipDuration(c);
  let a = 1;
  if (c.transitionIn) {
    const d = Math.min(c.transitionIn.durationSec, dur / 2);
    if (d > 0) a = Math.min(a, (t - c.start) / d);
  }
  if (c.transitionOut) {
    const d = Math.min(c.transitionOut.durationSec, dur / 2);
    if (d > 0) a = Math.min(a, (clipEnd(c) - t) / d);
  }
  return clamp(a, 0, 1);
}

/** Opacity at `t`: keyframes replace Clip.opacity; transitions multiply. */
export function opacityAt(c: Clip, t: number): number {
  const kf = interpolate(keyframesOf(c, "opacity"), t - c.start) as number | undefined;
  return clamp((kf ?? c.opacity) * transitionAlpha(c, t), 0, 1);
}

/**
 * Crop (fractions of the source) at `t`. Like the export, crop keyframes keep the w/h of the first
 * keyframe and move x/y; without keyframes the static Clip.crop (pixels) is used.
 */
export function cropAt(c: Clip, a: MediaAsset | undefined, t: number): CropBox | undefined {
  const kfs = keyframesOf(c, "crop");
  if (kfs.length > 0) {
    const v = interpolate(kfs, t - c.start) as CropBox;
    const first = cropFraction([...kfs].sort((x, y) => x.t - y.t)[0]!.v as CropBox);
    const cur = cropFraction(v);
    return {
      x: clamp(cur.x, 0, 1 - first.w),
      y: clamp(cur.y, 0, 1 - first.h),
      w: first.w,
      h: first.h,
    };
  }
  return c.crop ? staticCrop(c, a) : undefined;
}

/** Rect of a video/image/motion clip at `t`: scale/crop keyframes; position keyframes = center. */
export function placedRect(
  c: Clip,
  a: MediaAsset | undefined,
  canvas: { width: number; height: number },
  t: number,
  center?: Vec2,
): Rect {
  const local = t - c.start;
  const scale = (interpolate(keyframesOf(c, "scale"), local) as number | undefined) ?? c.scale;
  const size = mediaSize(a);
  const crop = cropAt(c, a, t);
  const cropPx =
    crop && size
      ? { x: 0, y: 0, width: crop.w * size.width, height: crop.h * size.height }
      : undefined;
  const r = fitRect(canvas, size, {
    ...(scale !== undefined && { scale }),
    ...(c.position && { position: c.position }),
    ...(cropPx && { crop: cropPx }),
  });
  const p = center ?? (interpolate(keyframesOf(c, "position"), local) as Vec2 | undefined);
  if (!p) return r;
  return {
    ...r,
    x: p.x * canvas.width - r.width / 2,
    y: p.y * canvas.height - r.height / 2,
  };
}

/** Canvas-space tracks per follower (trackToCanvas walks every frame: memoized per project). */
const canvasTracks = new WeakMap<object, Map<string, TrackFile>>();

/** Center (canvas fractions) of a clip that follows a track, at timeline time `t`. */
export function trackedCenter(
  project: Project,
  assets: Record<string, MediaAsset>,
  clip: Clip,
  file: TrackFile,
  t: number,
): Vec2 | undefined {
  const ref = clip.trackRef;
  if (!ref) return undefined;
  let byClip = canvasTracks.get(project.tracks);
  if (!byClip) {
    byClip = new Map();
    canvasTracks.set(project.tracks, byClip);
  }
  const key = `${clip.id}:${ref.assetId}:${project.settings.width}x${project.settings.height}:${file.frames.length}`;
  let ct = byClip.get(key);
  if (!ct) {
    ct = trackToCanvas(project, clip, file, (id) => mediaSize(assets[id]));
    byClip.set(key, ct);
  }
  return trackPointAt(ct, t - clip.start, ref.anchor, ref.offset);
}

function source(
  key: string,
  asset: MediaAsset,
  time: number,
  rate: number,
  extra: Partial<LayerSource> = {},
): LayerSource {
  return {
    key,
    assetId: asset.id,
    element: asset.kind === "image" ? "image" : "video",
    time: Math.max(0, time),
    rate,
    audible: false,
    volume: 0,
    ...extra,
  };
}

const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: "Inter",
  fontSize: 64,
  color: "#ffffff",
  position: "bottom",
};

/** Build every layer visible at `input.time`, bottom first. Pure: the canvas only draws it. */
export function composeAt(input: CompositorInput): Composition {
  const { project, assets, time: t } = input;
  const canvas = { width: project.settings.width, height: project.settings.height };
  const layers: Layer[] = [];
  const audio: AudioSource[] = [];

  project.tracks.forEach((track: Track, trackIndex) => {
    if (track.kind === "audio") {
      if (track.muted) return;
      for (const c of track.clips) {
        const a = c.assetId ? assets[c.assetId] : undefined;
        if (!a || !isActive(c, t)) continue;
        audio.push({
          ...source(c.id, a, sourceTimeAt(c, t), c.speed || 1),
          clipId: c.id,
          audible: true,
          volume: clamp(c.volume * transitionAlpha(c, t), 0, 4),
        });
      }
      return;
    }
    if (track.hidden) return;
    const active = track.clips.filter((c) => isActive(c, t)).sort((x, y) => x.start - y.start);
    active.forEach((c, lane) => {
      const z = trackIndex * 1000 + lane;
      const opacity = opacityAt(c, t);
      const base = { key: c.id, clipId: c.id, trackId: track.id, trackIndex, z, opacity };
      const file =
        c.trackRef && !rendersOwnTrack(c) ? input.trackFile?.(c.trackRef.assetId) : undefined;
      const follow = file ? trackedCenter(project, assets, c, file, t) : undefined;

      if (track.kind === "text") {
        const style = c.textStyle ?? DEFAULT_TEXT_STYLE;
        const local = t - c.start;
        const kf = interpolate(keyframesOf(c, "position"), local) as Vec2 | undefined;
        const factor = interpolate(keyframesOf(c, "scale"), local) as number | undefined;
        const p = follow ?? kf;
        layers.push({
          ...base,
          kind: "text",
          rect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
          text: {
            content: c.text ?? "",
            style: factor !== undefined ? { ...style, fontSize: style.fontSize * factor } : style,
            ...(p && { center: { x: p.x * canvas.width, y: p.y * canvas.height } }),
          },
          ...(follow && { tracked: true }),
        });
        return;
      }

      const assetId = track.kind === "motion" ? (c.renderedAssetId ?? c.assetId) : c.assetId;
      const a = assetId ? assets[assetId] : undefined;
      if (!a) {
        if (track.kind === "motion")
          layers.push({
            ...base,
            kind: "pending-motion",
            rect: {
              x: canvas.width * 0.1,
              y: canvas.height * 0.1,
              width: canvas.width * 0.8,
              height: canvas.height * 0.12,
            },
            text: {
              content: `Motion «${c.motion?.template ?? "?"}» — pendiente de render`,
              style: { fontFamily: "Inter", fontSize: 36, color: "#ffffff", position: "top" },
            },
          });
        return;
      }
      const rect = placedRect(c, a, canvas, t, follow);
      const speed = c.speed || 1;
      const audible = track.kind === "video" && !track.muted && a.hasAudio !== false;
      const main = source(c.id, a, sourceTimeAt(c, t), speed, {
        audible,
        volume: audible ? clamp(c.volume * transitionAlpha(c, t), 0, 4) : 0,
        ...(track.kind === "motion" && { keepOriginal: true }),
      });
      const layer: Layer = {
        ...base,
        kind: a.kind === "image" ? "image" : track.kind === "motion" ? "motion" : "video",
        rect,
        source: main,
        ...(follow && { tracked: true }),
      };
      const crop = cropAt(c, a, t);
      if (crop) layer.crop = crop;
      const alphaAsset = c.matte ? assets[c.matte.assetId] : undefined;
      if (c.matte && alphaAsset) {
        const bg = c.matte.background;
        const bgAsset =
          (bg?.type === "image" || bg?.type === "video") && bg.value ? assets[bg.value] : undefined;
        layer.matte = {
          alpha: source(`${c.id}:alpha`, alphaAsset, sourceTimeAt(c, t), speed, {
            keepOriginal: true,
          }),
          ...(bg && { background: bg }),
          ...(bgAsset && {
            backgroundSource: source(
              `${c.id}:bg`,
              bgAsset,
              bgAsset.durationSec ? (t - c.start) % bgAsset.durationSec : t - c.start,
              1,
              { loop: true },
            ),
          }),
        };
      }
      layers.push(layer);
    });
  });

  layers.sort((x, y) => x.z - y.z);
  const burned = subtitlesToBurn(project, effectiveBurnSubtitles(project));
  const segment = burned.find((s) => t >= s.start && t < s.end);
  const sizeOf = (id: string) => mediaSize(assets[id]);
  return {
    layers,
    audio,
    ...(segment && { subtitle: { segment, rect: videoRectAt(project, sizeOf, t) } }),
  };
}

/** Every media source a composition needs (main, alpha, background, audio). */
export function compositionSources(comp: Composition): LayerSource[] {
  const out: LayerSource[] = [];
  for (const l of comp.layers) {
    if (l.source) out.push(l.source);
    if (l.matte) {
      out.push(l.matte.alpha);
      if (l.matte.backgroundSource) out.push(l.matte.backgroundSource);
    }
  }
  out.push(...comp.audio);
  return out;
}

/**
 * The «driver» of the master clock: the bottom-most real video (not an image) — its decoded
 * frames pace the preview through requestVideoFrameCallback. Audio-only projects use the first
 * audio clip.
 */
export function driverSource(comp: Composition): (LayerSource & { clipId: string }) | undefined {
  for (const l of comp.layers)
    if ((l.kind === "video" || l.kind === "motion") && l.source?.element === "video")
      return { ...l.source, clipId: l.clipId };
  const a = comp.audio[0];
  return a ? { ...a } : undefined;
}

/**
 * Reframe crop (fractions of the canvas) at `t` (absolute timeline seconds), from a draft or the
 * applied project.reframe: the shared `reframeCropAt` (same window as the export crop: target
 * aspect, as large as the canvas allows, center following the keyframes).
 */
export function reframeCropAt(
  project: Project,
  t: number,
  draft?: { target: ReframeTarget; keyframes: readonly Keyframe<CropBox>[] },
): CropBox | undefined {
  const r = draft ?? project.reframe;
  if (!r || r.keyframes.length === 0) return undefined;
  return sharedReframeCropAt(r, project.settings, t);
}

/** Canvas point (px) -> normalized source point of a layer (for SAM clicks / tracking boxes). */
export function canvasToSource(layer: Layer, p: Vec2): Vec2 | undefined {
  const { rect } = layer;
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const u = (p.x - rect.x) / rect.width;
  const v = (p.y - rect.y) / rect.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
  const crop = layer.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  return { x: crop.x + u * crop.w, y: crop.y + v * crop.h };
}

/** Normalized source box -> canvas rect (px) of a layer. */
export function sourceToCanvas(
  layer: Layer,
  box: { x: number; y: number; w: number; h: number },
): Rect {
  const crop = layer.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const { rect } = layer;
  return {
    x: rect.x + ((box.x - crop.x) / crop.w) * rect.width,
    y: rect.y + ((box.y - crop.y) / crop.h) * rect.height,
    width: (box.w / crop.w) * rect.width,
    height: (box.h / crop.h) * rect.height,
  };
}

/** Topmost video/image layer under a canvas point. */
export function layerAtPoint(comp: Composition, p: Vec2): Layer | undefined {
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const l = comp.layers[i]!;
    if (l.kind !== "video" && l.kind !== "image") continue;
    const r = l.rect;
    if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return l;
  }
  return undefined;
}

// --------------------------------------------------------------------------------------------
// Drawing (canvas 2D). Kept apart from composeAt so the model stays testable without a canvas.

export type SourceLookup = (key: string) => CanvasImageSource | undefined;

function drawable(el: CanvasImageSource | undefined): el is CanvasImageSource {
  if (!el) return false;
  if (typeof HTMLVideoElement !== "undefined" && el instanceof HTMLVideoElement)
    return el.readyState >= 2 && el.videoWidth > 0;
  if (typeof HTMLImageElement !== "undefined" && el instanceof HTMLImageElement)
    return el.complete && el.naturalWidth > 0;
  return true;
}

function sourceSize(el: CanvasImageSource): { w: number; h: number } {
  if (typeof HTMLVideoElement !== "undefined" && el instanceof HTMLVideoElement)
    return { w: el.videoWidth, h: el.videoHeight };
  if (typeof HTMLImageElement !== "undefined" && el instanceof HTMLImageElement)
    return { w: el.naturalWidth, h: el.naturalHeight };
  const any = el as { width?: number; height?: number };
  return { w: Number(any.width) || 1, h: Number(any.height) || 1 };
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  rect: Rect,
  crop: CropBox | undefined,
): void {
  const { w, h } = sourceSize(el);
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  ctx.drawImage(el, c.x * w, c.y * h, c.w * w, c.h * h, rect.x, rect.y, rect.width, rect.height);
}

/** Cover-fit an element into a rect (matte backgrounds). */
function drawCover(ctx: CanvasRenderingContext2D, el: CanvasImageSource, rect: Rect): void {
  const { w, h } = sourceSize(el);
  const k = Math.max(rect.width / w, rect.height / h);
  const sw = rect.width / k;
  const sh = rect.height / k;
  ctx.drawImage(el, (w - sw) / 2, (h - sh) / 2, sw, sh, rect.x, rect.y, rect.width, rect.height);
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Text with the export layout (centered, 8 % margin) or centered on `center` when animated. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  payload: TextPayload,
  canvas: { width: number; height: number },
  box?: Rect,
): void {
  const { style } = payload;
  const area = box ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const size = style.fontSize;
  ctx.font = `600 ${size}px ${JSON.stringify(style.fontFamily || "Inter")}, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lines = wrapLines(ctx, payload.content, area.width * 0.9);
  const lineH = size * 1.2;
  const blockH = lines.length * lineH;
  const margin = area.height * 0.08;
  const cx = payload.center?.x ?? area.x + area.width / 2;
  const top = payload.center
    ? payload.center.y - blockH / 2
    : style.position === "top"
      ? area.y + margin
      : style.position === "center"
        ? area.y + (area.height - blockH) / 2
        : area.y + area.height - blockH - margin;
  lines.forEach((line, i) => {
    const y = top + i * lineH;
    if (style.background) {
      const w = ctx.measureText(line).width + 24;
      ctx.fillStyle = style.background;
      ctx.fillRect(cx - w / 2, y - 6, w, lineH + 4);
    } else {
      ctx.shadowColor = "rgba(0,0,0,.8)";
      ctx.shadowBlur = size * 0.1;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, cx, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  sub: NonNullable<Composition["subtitle"]>,
  style: CaptionStyle | undefined,
  canvas: { width: number; height: number },
): void {
  const unit = Math.min(sub.rect.width, sub.rect.height) / 1080;
  const s = style;
  const text = s?.uppercase ? sub.segment.text.toLocaleUpperCase("es") : sub.segment.text;
  drawText(
    ctx,
    {
      content: text,
      style: {
        fontFamily: s?.fontFamily ?? "Inter",
        fontSize: (s?.fontSize ?? 56) * unit,
        color: s?.color ?? "#ffffff",
        ...(s?.background && { background: s.background }),
        position: s?.position ?? "bottom",
      },
    },
    canvas,
    sub.rect,
  );
}

/** Draw a composition (canvas units = project pixels; the caller sets the transform). */
export function drawComposition(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
  lookup: SourceLookup,
  canvas: { width: number; height: number },
  captionStyle?: CaptionStyle,
): void {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const l of comp.layers) {
    if (l.opacity <= 0) continue;
    ctx.globalAlpha = l.opacity;
    if (l.kind === "text" || l.kind === "pending-motion") {
      if (l.kind === "pending-motion") {
        ctx.fillStyle = "rgba(217,70,239,.25)";
        ctx.fillRect(l.rect.x, l.rect.y, l.rect.width, l.rect.height);
      }
      if (l.text) drawText(ctx, l.text, canvas, l.kind === "pending-motion" ? l.rect : undefined);
      continue;
    }
    if (l.matte) {
      const bg = l.matte.background;
      ctx.save();
      ctx.beginPath();
      ctx.rect(l.rect.x, l.rect.y, l.rect.width, l.rect.height);
      ctx.clip();
      if (bg?.type === "color") {
        ctx.fillStyle = typeof bg.value === "string" ? bg.value : "#00b140";
        ctx.fillRect(l.rect.x, l.rect.y, l.rect.width, l.rect.height);
      } else if (bg?.type === "blur") {
        const el = l.source ? lookup(l.source.key) : undefined;
        if (drawable(el)) {
          ctx.filter = `blur(${Number(bg.value) || 20}px)`;
          drawMedia(ctx, el, l.rect, l.crop);
          ctx.filter = "none";
        }
      } else if (l.matte.backgroundSource) {
        const el = lookup(l.matte.backgroundSource.key);
        if (drawable(el)) drawCover(ctx, el, l.rect);
      }
      ctx.restore();
      const alpha = lookup(l.matte.alpha.key);
      if (drawable(alpha)) drawMedia(ctx, alpha, l.rect, l.crop);
      continue;
    }
    const el = l.source ? lookup(l.source.key) : undefined;
    if (drawable(el)) drawMedia(ctx, el, l.rect, l.crop);
  }
  ctx.globalAlpha = 1;
  if (comp.subtitle) drawSubtitle(ctx, comp.subtitle, captionStyle, canvas);
  ctx.restore();
}
