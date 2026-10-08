import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  aiLabelText,
  effectiveBurnSubtitles,
  subtitlesToBurn,
  tracksInZOrder,
  type AspectFit,
  type Clip,
  type ExportPreset,
  type Project,
  type VideoEncoderId,
} from "@studio/shared";
import { presetEncoding, segmentSafetyArgs } from "./encoders.js";
import {
  clipDuration,
  effectiveAspectFit,
  reframeApplies,
  sliceClipsToWindow,
  type TimelineAsset,
} from "./timeline.js";

/**
 * Segment cache render (Sprint 1, "render por bloques"): the export is split into windows at clip
 * boundaries (max SEGMENT_MAX_SEC), each window's video is rendered once to
 * storage/cache/segments/<sha1>.mp4 and reused while its inputs do not change; the windows are
 * joined with the concat demuxer (-c copy) and the audio mix, rendered once, is muxed on top.
 *
 * Fallback rule (single pass instead): GIF / alpha / non H.264-H.265 presets, and timelines where a
 * cut point cannot avoid a transition window — fades need the whole fade plus the same clip length
 * on their side ((start, start+2d) / (end-2d, end)), and an xfade between adjacent clips A|B needs
 * (B.start-2d, B.start+2d) inside one window. The planner moves a forced cut left out of those
 * windows; when that leaves a window shorter than SEGMENT_MIN_SEC it falls back.
 */

/** Bump when the compiler output changes for the same inputs (invalidates every cached block). */
export const COMPILER_VERSION = "2026.10-s1";
export const SEGMENT_MAX_SEC = 10;
export const SEGMENT_MIN_SEC = 0.5;

const EPS = 1e-3;

export interface SegmentWindow {
  /** Absolute timeline seconds. */
  start: number;
  end: number;
  /** Exact number of frames of this window. */
  frames: number;
}

/** Why a preset cannot use the segment cache (Spanish), or undefined. */
export function segmentPresetBlocker(preset: ExportPreset): string | undefined {
  if (preset.container === "gif" || preset.videoCodec === "gif")
    return "GIF se renderiza de una vez";
  if (preset.alpha) return "las exportaciones con transparencia se renderizan de una vez";
  if (preset.videoCodec !== "h264" && preset.videoCodec !== "h265")
    return `el códec ${preset.videoCodec} se renderiza de una vez`;
  if (preset.container !== "mp4" && preset.container !== "mov")
    return `el contenedor ${preset.container} se renderiza de una vez`;
  if (preset.audioCodec === "pcm" && preset.container === "mp4")
    return "audio PCM en MP4 se renderiza de una vez";
  return undefined;
}

const visibleVisual = (project: Pick<Project, "tracks">) =>
  project.tracks.filter((t) => (t.kind === "video" || t.kind === "motion") && !t.hidden);

/** Open intervals (absolute seconds) where a segment cut would change a fade or an xfade. */
export function transitionWindows(
  project: Pick<Project, "tracks">,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const track of visibleVisual(project)) {
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    const endOf = (c: Clip) => c.start + clipDuration(c);
    for (const c of clips) {
      if (clipDuration(c) <= EPS) continue;
      const prev = clips.find((p) => p !== c && Math.abs(endOf(p) - c.start) <= EPS);
      const next = clips.find((n) => n !== c && Math.abs(n.start - endOf(c)) <= EPS);
      const tin = Math.max(c.transitionIn?.durationSec ?? 0, prev?.transitionOut?.durationSec ?? 0);
      if (tin > 0 && prev) out.push({ start: c.start - 2 * tin, end: c.start + 2 * tin });
      else if (c.transitionIn)
        out.push({ start: c.start, end: c.start + 2 * c.transitionIn.durationSec });
      if (c.transitionOut && !next)
        out.push({ start: endOf(c) - 2 * c.transitionOut.durationSec, end: endOf(c) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Plan the windows of [start, end) on the output frame grid (start + k/fps): greedy, each window
 * ends at the last safe clip/text boundary within SEGMENT_MAX_SEC, else at a forced safe cut.
 */
export function planSegments(
  project: Pick<Project, "tracks">,
  o: { fps: number; start: number; end: number; maxSec?: number; minSec?: number },
): { segments: SegmentWindow[] } | { fallback: string } {
  const { fps, start, end } = o;
  const maxF = Math.max(1, Math.floor((o.maxSec ?? SEGMENT_MAX_SEC) * fps + 1e-6));
  const minF = Math.max(1, Math.round((o.minSec ?? SEGMENT_MIN_SEC) * fps));
  /** Frames of the whole export (same count as the single pass: frames with pts < duration). */
  const totalF = Math.max(1, Math.ceil((end - start) * fps - 1e-6));
  const at = (k: number) => start + k / fps;
  const windows = transitionWindows(project);
  const unsafeAt = (k: number) => {
    const t = at(k);
    return windows.find((w) => t > w.start + EPS && t < w.end - EPS);
  };
  const bounds = new Set<number>();
  for (const t of project.tracks) {
    if (t.kind === "audio" || t.hidden) continue;
    for (const c of t.clips)
      for (const x of [c.start, c.start + clipDuration(c)]) {
        const k = Math.round((x - start) * fps);
        if (k > 0 && k < totalF) bounds.add(k);
      }
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const cuts = [0];
  let c = 0;
  while (totalF - c > maxF) {
    let pick = [...sorted]
      .reverse()
      .find((b) => b > c && b - c <= maxF && b - c >= minF && !unsafeAt(b));
    if (pick === undefined) {
      let k = c + maxF;
      for (let w = unsafeAt(k); w && k > c; w = unsafeAt(k))
        k = Math.floor((w.start - start) * fps + 1e-6);
      if (k - c < minF)
        return {
          fallback: "una transición no deja cortar el timeline en bloques de 10 s",
        };
      pick = k;
    }
    cuts.push(pick);
    c = pick;
  }
  cuts.push(totalF);
  const segments: SegmentWindow[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    segments.push({ start: at(a), end: i + 2 === cuts.length ? end : at(b), frames: b - a });
  }
  return { segments };
}

/** JSON with sorted keys and numbers rounded to µs (stable across runs and platforms). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as object)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(norm(value));
}

export interface SegmentHashInput {
  project: Project;
  preset: ExportPreset;
  encoder: VideoEncoderId;
  window: SegmentWindow;
  gopFrames: number;
  assets: ReadonlyMap<string, TimelineAsset>;
  /** Asset id -> file stamp (mtime ms + size). */
  stamps: ReadonlyMap<string, { mtimeMs: number; size: number }>;
  /** ASS dialogue events of the burned subtitles (absolute seconds, as the compiler writes them). */
  burnSubtitles?: boolean;
  fontFile?: string;
  ffmpegVersion?: string;
  /** Sprint 5: requested framing (hashed only when it differs from the legacy default). */
  aspectFit?: AspectFit;
}

/**
 * sha1 of everything that changes the pixels of a window: sliced visual clips (asset ids + file
 * mtime/size + trim + speed + opacity + crop + position/scale + transitions), text overlays and
 * burned subtitles relative to the window, caption style, AI label, canvas, preset video params,
 * encoder, ffmpeg version and COMPILER_VERSION. Sprint 2: keyframes (rebased to the window; the
 * caller resolves trackRef to keyframes first, so the track content is hashed through them), matte
 * (+ alpha / background asset stamps) and project.reframe with the window start when it applies.
 * Sprint 3b: tracks in z-order, blend mode and mask (+ mask asset stamp, fps).
 * Audio-only fields (volume, voice effects, muted,
 * audio tracks) are left out: audio is rendered separately.
 */
export function segmentHash(h: SegmentHashInput): string {
  const { project, window: win } = h;
  const rel = (t: number) => t - win.start;
  const used = new Set<string>();
  const fpsMatters = new Set<string>();
  // Sprint 3b: z-order (Track.order) decides the stacking, so the list is hashed in that order.
  const tracks = tracksInZOrder(project.tracks)
    .filter((t) => t.kind !== "audio" && !t.hidden)
    .map((t) => {
      if (t.kind === "text")
        return {
          kind: t.kind,
          clips: t.clips
            .filter((c) => c.text?.trim())
            .filter((c) => c.start + clipDuration(c) > win.start + EPS && c.start < win.end - EPS)
            .map((c) => ({
              start: rel(c.start),
              dur: clipDuration(c),
              text: c.text,
              style: c.textStyle,
              opacity: c.opacity,
              tin: c.transitionIn,
              tout: c.transitionOut,
              keyframes: c.keyframes,
            })),
        };
      return {
        kind: t.kind,
        clips: sliceClipsToWindow(t.clips, win).map((c) => {
          const id = t.kind === "motion" ? (c.renderedAssetId ?? c.assetId) : c.assetId;
          if (id) used.add(id);
          if (c.matte) {
            used.add(c.matte.assetId);
            const bg = c.matte.background;
            if (bg?.value && (bg.type === "image" || bg.type === "video")) used.add(bg.value);
          }
          if (c.maskRef?.type === "asset") {
            used.add(c.maskRef.assetId);
            // SAM mask folders are numbered with the mask (else source) frame rate.
            fpsMatters.add(c.maskRef.assetId);
            if (id) fpsMatters.add(id);
          }
          return {
            id,
            start: c.start,
            in: c.in,
            out: c.out,
            speed: c.speed,
            opacity: c.opacity,
            crop: c.crop,
            scale: c.scale,
            position: c.position,
            tin: c.transitionIn,
            tout: c.transitionOut,
            // Sprint 2 (rebased to the piece by sliceClipsToWindow; trackRef already resolved).
            keyframes: c.keyframes,
            trackRef: c.trackRef,
            matte: c.matte,
            motion: c.trackRef ? c.motion?.template : undefined,
            // Sprint 3b layers (absent = old hash unchanged).
            blend: c.blendMode && c.blendMode !== "normal" ? c.blendMode : undefined,
            mask: c.maskRef,
          };
        }),
      };
    });
  const burn = subtitlesToBurn(project, effectiveBurnSubtitles(project, h.burnSubtitles));
  const subs = burn
    .filter((s) => s.end > win.start + EPS && s.start < win.end - EPS)
    .map((s) => ({ start: rel(s.start), end: rel(s.end), text: s.text }));
  // Burned captions are sized from the first subtitle and placed in the video rect at their time:
  // keep the whole-timeline context that influences them.
  const first = burn[0];
  const assets = Object.fromEntries(
    [...used].sort().map((id) => {
      const a = h.assets.get(id);
      return [
        id,
        a && {
          kind: a.kind,
          alpha: a.hasAlpha,
          codec: a.videoCodec,
          w: a.width,
          h: a.height,
          fps: fpsMatters.has(id) ? a.fps : undefined,
          file: h.stamps.get(id),
        },
      ];
    }),
  );
  const p = h.preset;
  return createHash("sha1")
    .update(
      canonicalJson({
        v: COMPILER_VERSION,
        ffmpeg: h.ffmpegVersion,
        encoder: h.encoder,
        // Only set for NVENC/QSV blocks: libx264 hashes (and caches) stay as they were.
        blockFlags:
          segmentSafetyArgs(presetEncoding(h.preset, h.encoder).video).join(" ") || undefined,
        preset: {
          w: p.width,
          h: p.height,
          fps: p.fps,
          codec: p.videoCodec,
          crf: p.crf,
          kbps: p.videoBitrateKbps,
          container: p.container,
        },
        canvas: project.settings,
        frames: win.frames,
        dur: win.end - win.start,
        gop: h.gopFrames,
        tracks,
        subs,
        subsContext: subs.length
          ? { first: first && { s: first.start, e: first.end }, style: project.captionStyle }
          : undefined,
        // Reframe crop: absolute keyframes evaluated from the window start.
        reframe: reframeApplies(project, h.preset)
          ? { r: project.reframe, at: win.start }
          : undefined,
        // Sprint 5: a framing other than the legacy one (center, or blur despite reframe keyframes).
        fit: ((eff) => (eff !== effectiveAspectFit(project, p) ? eff : undefined))(
          effectiveAspectFit(project, p, h.aspectFit),
        ),
        label: aiLabelText(project.publish),
        labelStyle: aiLabelText(project.publish) ? project.captionStyle : undefined,
        font: h.fontFile,
        assets,
      }),
    )
    .digest("hex");
}

/** Spanish progress line: "3/12 bloques (2 en caché)". */
export function segmentProgressMessage(done: number, total: number, cached: number): string {
  return `${done}/${total} bloques (${cached} en caché)`;
}

/**
 * LRU trim of the segment cache: delete the least recently used blocks (mtime, refreshed on every
 * cache hit) until the folder fits in `maxBytes`. Partial files younger than an hour are kept (an
 * export may be writing them). Returns the number of files deleted.
 */
export async function pruneSegmentCache(dir: string, maxBytes: number): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: { file: string; size: number; mtimeMs: number; part: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith(".mp4")) continue;
    const file = path.join(dir, name);
    const st = await stat(file).catch(() => undefined);
    if (st?.isFile())
      files.push({ file, size: st.size, mtimeMs: st.mtimeMs, part: name.includes(".part") });
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  let deleted = 0;
  const now = Date.now();
  for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    if (f.part && now - f.mtimeMs < 3600_000) continue;
    await rm(f.file, { force: true });
    total -= f.size;
    deleted++;
  }
  return deleted;
}
