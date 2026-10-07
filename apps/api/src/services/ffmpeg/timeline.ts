import path from "node:path";
import {
  aiLabelText,
  blendModeToFfmpeg,
  effectiveBurnSubtitles,
  fitRect,
  hasKeyframes,
  maskShapeRect,
  normalizeCropRect,
  reframeWindow,
  rendersOwnTrack,
  resolveTrackRefs,
  subtitlesToBurn,
  tracksInZOrder,
  videoRectAt,
  type Clip,
  type ClipMaskShape,
  type CropRect,
  type Keyframe,
  type Rect,
  type TrackFile,
  type ExportPreset,
  type MediaKind,
  type Project,
  type TextStyle,
  type Track,
  type VideoEncoderId,
} from "@studio/shared";
import { buildAss } from "./ass.js";
import { atempoChain, buildAudioFxGraph } from "./audio-fx.js";
import {
  blurredBackgroundFilter,
  enableBetween,
  pipPlacementFilters,
  xfadeTransitionName,
} from "./builders.js";
import { escapeFilterPath, escapeOptionValue, quoteFilterArg, sec } from "./escape.js";
import { presetEncoding, segmentSafetyArgs } from "./encoders.js";
import {
  componentExpr,
  numberKeyframesExpr,
  numberRange,
  shiftKeyframes,
} from "./keyframe-expr.js";

/** Resolved media for the compiler (absolute paths; metadata from ffprobe). */
export interface TimelineAsset {
  id: string;
  absPath: string;
  kind: MediaKind;
  hasVideo: boolean;
  hasAudio: boolean;
  hasAlpha?: boolean;
  videoCodec?: string;
  durationSec?: number;
  /** Display size (fits captions to the video rect). */
  width?: number;
  height?: number;
  /** Frame rate (Sprint 3b: frame numbering of SAM mask folders). */
  fps?: number;
}

export interface CompileExportOptions {
  project: Project;
  preset: ExportPreset;
  assets: ReadonlyMap<string, TimelineAsset>;
  /** Output path (absolute, or relative to the job cwd). */
  output: string;
  range?: { start: number; end: number };
  /** H.264 encoder (hardware or libx264). */
  encoder?: VideoEncoderId;
  /** Absolute font file for drawtext; default: fontconfig family from TextStyle.fontFamily. */
  fontFile?: string;
  rubberband?: boolean;
  /** FFmpeg >= 7 uses `-/filter_complex <file>`; 6.x uses `-filter_complex_script <file>`. */
  ffmpegMajor?: number;
  /** Burn project.subtitles; default effectiveBurnSubtitles(project) (off with animated captions). */
  burnSubtitles?: boolean;
  /**
   * Segment render (segment cache): only the video of the timeline window [start, end) is
   * rendered, as a stream starting at 0 with a keyframe on its first frame (`-force_key_frames 0`,
   * `-g` = gopFrames). Visual clips are sliced to the window (sliceClipsToWindow); text overlays,
   * burned subtitles and the AI label keep their absolute times (setpts shifted around them), so
   * every frame equals the single-pass frame. `timelineEnd` = end of the full export (text clamp).
   */
  window?: { start: number; end: number; timelineEnd: number; gopFrames: number; frames: number };
  /** Render only the audio mix ([aout]) of the whole timeline (segment render: muxed later). */
  audioOnly?: boolean;
  /**
   * Sprint 2: track files (asset id -> TrackFile) of the clips' `trackRef`; each trackRef is
   * resolved to position keyframes before compiling (resolveTrackRefs). Absent = already resolved.
   */
  tracks?: ReadonlyMap<string, TrackFile>;
  /**
   * Sprint 4: `-metadata comment=` of the full (single pass) export, from aiContentComment()
   * (decision 9). Ignored for segment windows and audio-only renders (added at the final mux).
   */
  metadataComment?: string;
}

/** `-metadata comment=<text>` (one argv element: spawn without a shell, no quoting needed). */
export function metadataArgs(comment: string | undefined): string[] {
  const text = comment?.replace(/[\r\n]+/g, " ").trim();
  return text ? ["-metadata", `comment=${text}`] : [];
}

export interface CompiledExport {
  /** argv after the global flags (run with cwd = job dir: graph/text/subtitle files are relative). */
  args: string[];
  graph: string;
  /** Files to write into the job dir before running (graph.txt, text-N.txt, subs.ass). */
  files: { name: string; content: string }[];
  durationSec: number;
  warnings: string[];
}

const EPS = 1e-3;

/** Duration of a clip on the timeline. */
export function clipDuration(c: Pick<Clip, "in" | "out" | "speed">): number {
  return Math.max(0, (c.out - c.in) / (c.speed || 1));
}

/** Timeline end over visible tracks (and subtitles). */
export function timelineDuration(project: Project): number {
  let end = 0;
  for (const t of project.tracks) {
    if (t.hidden && t.kind !== "audio") continue;
    for (const c of t.clips) end = Math.max(end, c.start + clipDuration(c));
  }
  for (const s of project.subtitles) end = Math.max(end, s.end);
  return end;
}

/**
 * Clips the export would otherwise drop silently (B3/B4): motion clips without a render and clips
 * whose media was deleted. Only exported tracks and clips overlapping `range` count. Spanish lines.
 */
export function findExportBlockers(
  project: Pick<Project, "tracks">,
  hasAsset: (id: string) => boolean,
  range?: { start: number; end: number },
): string[] {
  const out: string[] = [];
  const at = (t: number) => `${t.toFixed(1).replace(".", ",")} s`;
  for (const track of project.tracks) {
    if (track.kind === "audio" ? track.muted : track.hidden) continue;
    for (const c of track.clips) {
      const end = c.start + clipDuration(c);
      if (range && (end <= range.start + EPS || c.start >= range.end - EPS)) continue;
      const where = `«${track.name}» en ${at(c.start)}`;
      if (track.kind === "motion") {
        const id = c.renderedAssetId ?? c.assetId;
        if (id && hasAsset(id)) continue;
        if (c.motion) out.push(`Motion «${c.motion.template}» sin renderizar (${where})`);
        else if (id) out.push(`El render ${id} ya no existe (${where})`);
      } else if (c.assetId && !hasAsset(c.assetId)) {
        out.push(`El medio ${c.assetId} fue borrado (${where})`);
      }
    }
  }
  return out;
}

/** Spanish error for findExportBlockers (empty list -> undefined). */
export function exportBlockersMessage(problems: string[]): string | undefined {
  if (problems.length === 0) return undefined;
  const n = problems.length;
  return (
    `No se puede exportar: ${n} clip${n === 1 ? "" : "s"} con problemas. ` +
    `Renderiza los motion pendientes o quita los clips huérfanos: ${problems.join("; ")}`
  );
}

/** "#rrggbb" / "#rrggbbaa" / named colour -> ffmpeg colour syntax. */
export function ffmpegColor(input: string | undefined, fallback = "white"): string {
  if (!input) return fallback;
  const v = input.trim();
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) {
    const a = m[2] ? `@${+(parseInt(m[2], 16) / 255).toFixed(3)}` : "";
    return `0x${m[1]!.toUpperCase()}${a}`;
  }
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const [r, g, b] = v.slice(1);
    return `0x${r}${r}${g}${g}${b}${b}`.toUpperCase().replace("0X", "0x");
  }
  return /^[a-z]+$/i.test(v) ? v.toLowerCase() : fallback;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

class GraphBuilder {
  readonly inputs: string[][] = [];
  readonly parts: string[] = [];
  readonly files: { name: string; content: string }[] = [];
  readonly warnings: string[] = [];
  #n = 0;

  input(args: string[]): number {
    this.inputs.push(args);
    return this.inputs.length - 1;
  }
  label(prefix: string): string {
    return `${prefix}${this.#n++}`;
  }
  add(part: string): void {
    this.parts.push(part);
  }
}

interface Seg {
  label: string;
  dur: number;
}

/** A floating clip stream (Sprint 2) and its overlay x/y expressions. */
interface FloatSeg {
  label: string;
  x: string;
  y: string;
}

/**
 * Compile a Project into one FFmpeg filter_complex invocation:
 *  - canvas = project.settings (w×h), fps = preset.fps; black (or transparent) base of length T;
 *  - tracks are layered in z-order (tracksInZOrder: Track.order, else array index; bottom first);
 *    video/motion tracks become one stream per lane (clips in sequence, transparent gaps, xfade
 *    for adjacent transitions, alpha fades otherwise) overlaid on the composite; text tracks are
 *    drawtext; audio of video+audio tracks is trimmed/sped/effected/delayed and amix-ed;
 *  - Sprint 3b layers: a clip mask (Clip.maskRef) multiplies the clip alpha (shape generated once
 *    with geq + gblur and looped, or the asset mask through the clip's own crop/placement chain);
 *    a clip with Clip.blendMode ≠ normal is composited on its own: its full-canvas stream and the
 *    composite go to planar RGB (gbrap), `blend=all_mode=<mode>` (composite first, so «overlay»
 *    depends on the backdrop like the canvas preview) and the result is laid over the composite
 *    with the clip alpha (alphamerge + overlay) — opacity, fades, masks and keyframes included;
 *  - project.subtitles are burned (SRT), then range trim, reframe to preset size (blurred
 *    background when the aspect ratio differs) and preset encoding (GIF via palettegen).
 */
export function compileExport(o: CompileExportOptions): CompiledExport {
  const { preset } = o;
  const g = new GraphBuilder();
  const project = o.tracks ? resolveExportProject(o.project, o.assets, o.tracks) : o.project;
  for (const t of project.tracks)
    for (const c of t.clips)
      if (c.trackRef && !rendersOwnTrack(c) && t.kind !== "audio")
        g.warnings.push(
          `Seguimiento ${c.trackRef.assetId} no disponible: el clip ${c.id} queda fijo`,
        );
  const win = o.window;
  const audioOnly = !win && o.audioOnly === true;
  /** Video graph parts are skipped in audioOnly mode (no decoding of unused video). */
  const vadd = (part: string) => {
    if (!audioOnly) g.add(part);
  };
  const W = even(project.settings.width);
  const H = even(project.settings.height);
  const FPS = preset.fps;
  const enc = presetEncoding(preset, o.encoder ?? "libx264");
  const alpha = enc.alpha;
  /** GIF has no audio: no audio chains may be left unconnected in the graph. */
  const gif = enc.extension === "gif";
  const total = timelineDuration(project);
  const rs = win ? 0 : Math.max(0, o.range?.start ?? 0);
  const re = win ? win.end - win.start : Math.min(o.range?.end ?? total, total);
  if (!(re - rs > EPS))
    throw new Error("El proyecto no tiene contenido para exportar en ese rango");
  const T = re;
  const frame = 1 / FPS;
  /** Absolute timeline time of local t = 0 (window renders) and the clamp for text overlays. */
  const offset = win?.start ?? 0;
  const textEnd = win ? win.timelineEnd : T;
  /** Wrap filters that use absolute timeline time (drawtext t, ASS events) in a window render. */
  const absTime = (filters: string) =>
    offset > EPS ? `setpts=PTS+${sec(offset)}/TB,${filters},setpts=PTS-${sec(offset)}/TB` : filters;

  let cur = g.label("base");
  vadd(
    `color=c=${alpha ? "black@0" : "black"}:s=${W}x${H}:r=${FPS}:d=${sec(T)},format=${alpha ? "yuva420p" : "yuv420p"}[${cur}]`,
  );
  const audioLabels: string[] = [];

  const asset = (id: string | undefined): TimelineAsset | undefined =>
    id ? o.assets.get(id) : undefined;

  const addAudio = (
    inputIdx: number,
    clip: Clip,
    startOnTimeline: number,
    dur: number,
    skipSrc: number,
    fadeIn: number,
    fadeOut: number,
  ) => {
    if (gif || win || clip.volume <= 0 || dur <= EPS) return;
    const pre = g.label("ap");
    const post = g.label("aq");
    const out = g.label("a");
    const chain = [`atrim=start=${sec(skipSrc)}`, "asetpts=PTS-STARTPTS"];
    if (Math.abs(clip.speed - 1) > EPS) chain.push(atempoChain(clip.speed));
    if (Math.abs(clip.volume - 1) > EPS) chain.push(`volume=${+clip.volume.toFixed(3)}`);
    g.add(`[${inputIdx}:a]${chain.join(",")}[${pre}]`);
    const fx = buildAudioFxGraph(clip.voiceEffects, pre, post, {
      prefix: `${post}x`,
      mode: "timeline",
      ...(o.rubberband !== undefined && { rubberband: o.rubberband }),
    });
    g.warnings.push(...fx.warnings);
    g.add(fx.graph);
    // Bounded pad (whole_dur), never a bare `apad`: see the final mix below.
    const tail = [`apad=whole_dur=${sec(dur)}`, `atrim=duration=${sec(dur)}`];
    if (fadeIn > 0) tail.push(`afade=t=in:st=0:d=${sec(fadeIn)}`);
    if (fadeOut > 0)
      tail.push(`afade=t=out:st=${sec(Math.max(0, dur - fadeOut))}:d=${sec(fadeOut)}`);
    tail.push("aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
    const ms = Math.round(startOnTimeline * 1000);
    if (ms > 0) tail.push(`adelay=${ms}|${ms}`);
    g.add(`[${post}]${tail.join(",")}[${out}]`);
    audioLabels.push(out);
  };

  /** Playable clips of a visual track (unrendered motion / missing media are skipped with a warning). */
  const playableClips = (track: Track): Clip[] =>
    track.clips
      .filter((c) => {
        const a = asset(track.kind === "motion" ? (c.renderedAssetId ?? c.assetId) : c.assetId);
        if (!a) {
          if (track.kind === "motion" && c.motion)
            g.warnings.push(`Motion "${c.motion.template}" sin renderizar: se omite`);
          else if (c.assetId) g.warnings.push(`Asset ${c.assetId} no encontrado: se omite`);
          return false;
        }
        return a.hasVideo || a.kind === "image";
      })
      .sort((a, b) => a.start - b.start);

  /**
   * Feedback 1: clips that overlap on one track (two caption renders at the same start, title cards
   * dropped on top of them) used to be trimmed or dropped ("solapado: se omite", only in the job
   * log). They are split into lanes instead (greedy interval partitioning: a clip joins the first
   * lane that is free at its start) and every lane is overlaid, later lanes on top.
   */
  const lanesOf = (clips: readonly Clip[]): Clip[][] => {
    const lanes: { end: number; clips: Clip[] }[] = [];
    for (const c of clips) {
      const end = c.start + clipDuration(c);
      const lane = lanes.find((l) => l.end <= c.start + EPS);
      if (lane) {
        lane.clips.push(c);
        lane.end = end;
      } else lanes.push({ end, clips: [c] });
    }
    return lanes.map((l) => l.clips);
  };

  const wantsAudio = (track: Track, a: TimelineAsset) =>
    track.kind === "video" && !track.muted && a.hasAudio && a.kind !== "image";

  /** Input of a clip's media (image loop or -ss/-t video). */
  const mediaInput = (a: TimelineAsset, srcStart: number, segDur: number, speed: number) => {
    if (a.kind === "image")
      return g.input([
        "-loop",
        "1",
        "-framerate",
        String(FPS),
        "-t",
        sec(segDur + frame),
        "-i",
        a.absPath,
      ]);
    const vp9Alpha = a.videoCodec === "vp9" && (a.hasAlpha ?? true) && /\.webm$/i.test(a.absPath);
    return g.input([
      "-ss",
      sec(srcStart),
      "-t",
      sec(segDur * speed + 0.5),
      ...(vp9Alpha ? ["-c:v", "libvpx-vp9"] : []),
      "-i",
      a.absPath,
    ]);
  };

  /**
   * Video source of a clip: its media, or (Sprint 2 `clip.matte`) the alpha video of the cut-out
   * over its background (colour / image / video / blurred original) at the source size, so the
   * placement, crop and keyframes that follow apply to the composite like to the original.
   */
  const sourceInput = (
    track: Track,
    clip: Clip,
    a: TimelineAsset,
    srcStart: number,
    segDur: number,
    speed: number,
  ): { video: string; audioIdx?: number } => {
    const m = clip.matte ? asset(clip.matte.assetId) : undefined;
    if (clip.matte && !m)
      g.warnings.push(`Recorte ${clip.matte.assetId} no encontrado: se usa el clip original`);
    if (!m || !clip.matte) {
      const idx = mediaInput(a, srcStart, segDur, speed);
      return { video: `${idx}:v`, ...(wantsAudio(track, a) && { audioIdx: idx }) };
    }
    const AW = even(m.width ?? a.width ?? W);
    const AH = even(m.height ?? a.height ?? H);
    // Split matte (RVM `alpha_codec: "split"`): one .mkv, colour in v:0 + alpha as full-range
    // luma in v:1 (NVENC H.264), merged back losslessly. Otherwise a VP9 yuva420p WebM.
    const split = /\.mkv$/i.test(m.absPath);
    const alphaIdx = mediaInput(split ? m : { ...m, hasAlpha: true }, srcStart, segDur, speed);
    let alphaSrc = `${alphaIdx}:v`;
    if (split) {
      const [sa, sm] = [g.label("sa"), g.label("sm")];
      vadd(`[${alphaIdx}:v:1]extractplanes=y[${sa}]`);
      vadd(`[${alphaIdx}:v:0][${sa}]alphamerge[${sm}]`);
      alphaSrc = sm;
    }
    const al = g.label("al");
    vadd(`[${alphaSrc}]scale=${AW}:${AH},setsar=1,fps=${FPS},format=yuva420p[${al}]`);
    const bgSpec = clip.matte.background;
    const bgDur = sec(segDur * speed + 1);
    const cover = `scale=${AW}:${AH}:force_original_aspect_ratio=increase,crop=${AW}:${AH},setsar=1,fps=${FPS},format=yuva420p`;
    let bg: string | undefined;
    let audioIdx: number | undefined;
    if (bgSpec?.type === "color") {
      bg = g.label("bg");
      vadd(
        `color=c=${ffmpegColor(bgSpec.value, "black")}:s=${AW}x${AH}:r=${FPS}:d=${bgDur},format=yuva420p[${bg}]`,
      );
    } else if (bgSpec?.type === "image" || bgSpec?.type === "video") {
      const b = asset(bgSpec.value);
      if (!b) g.warnings.push(`Fondo ${bgSpec.value ?? "?"} no encontrado: fondo transparente`);
      else {
        const idx =
          b.kind === "image"
            ? g.input(["-loop", "1", "-framerate", String(FPS), "-t", bgDur, "-i", b.absPath])
            : g.input(["-stream_loop", "-1", "-t", bgDur, "-i", b.absPath]);
        bg = g.label("bg");
        vadd(`[${idx}:v]${cover}[${bg}]`);
      }
    } else if (bgSpec?.type === "blur") {
      const idx = mediaInput(a, srcStart, segDur, speed);
      if (wantsAudio(track, a)) audioIdx = idx;
      const sigma = Math.min(200, Math.max(1, Number(bgSpec.value) || 25));
      bg = g.label("bg");
      vadd(
        `[${idx}:v]scale=${AW}:${AH},setsar=1,fps=${FPS},gblur=sigma=${sigma},format=yuva420p[${bg}]`,
      );
    }
    if (audioIdx === undefined && wantsAudio(track, a))
      audioIdx = mediaInput(a, srcStart, segDur, speed);
    const tail = audioIdx !== undefined ? { audioIdx } : {};
    if (!bg) return { video: al, ...tail };
    const mt = g.label("mt");
    vadd(`[${bg}][${al}]overlay=0:0:shortest=1:format=auto,format=yuva420p[${mt}]`);
    return { video: mt, ...tail };
  };

  /**
   * Start of a clip chain: crop (fixed, or Sprint 2 crop keyframes: size of the first keyframe,
   * x/y moving), timestamps from 0 and speed. `lead` = segment-local minus clip-local time.
   */
  const headChain = (clip: Clip, speed: number, lead: number, pixFmt = "yuva420p"): string[] => {
    const chain: string[] = [];
    // Crop keyframes in fractions of the source (percent accepted, like the preview).
    const cropKf = hasKeyframes(clip.keyframes, "crop")
      ? clip.keyframes.crop!.map((k) =>
          typeof k.v === "object" && "w" in k.v ? { ...k, v: normalizeCropRect(k.v) } : k,
        )
      : undefined;
    if (!cropKf && clip.crop) {
      const c = clip.crop;
      chain.push(
        `crop=${Math.round(c.width)}:${Math.round(c.height)}:${Math.round(c.x)}:${Math.round(c.y)}`,
      );
    }
    chain.push("setpts=PTS-STARTPTS");
    if (Math.abs(speed - 1) > EPS) chain.push(`setpts=PTS/${+speed.toFixed(6)}`);
    if (cropKf) {
      const first = cropKf.find((k) => typeof k.v === "object" && "w" in k.v)?.v as
        CropRect | undefined;
      if (first) {
        const tv = lead > 0 ? `(t-${sec(lead)})` : "t";
        const x = componentExpr(cropKf, (v) => v.x, tv);
        const y = componentExpr(cropKf, (v) => v.y, tv);
        chain.push(
          `crop=w=${quoteFilterArg(`iw*${sec(first.w)}`)}:h=${quoteFilterArg(`ih*${sec(first.h)}`)}:x=${quoteFilterArg(`iw*(${x})`)}:y=${quoteFilterArg(`ih*(${y})`)}`,
        );
      }
    }
    chain.push(`format=${pixFmt}`);
    return chain;
  };

  /**
   * Sprint 3b: the clip frame on its canvas-sized stream (canvas px), as fitRect places it:
   * `placement` (scale/position) and the static crop or the size of the first crop keyframe.
   */
  const clipFrameRect = (
    clip: Clip,
    a: TimelineAsset,
    placement: Pick<Clip, "scale" | "position">,
  ): Rect => {
    const media = a.width && a.height ? { width: a.width, height: a.height } : undefined;
    let crop = clip.crop;
    const first = hasKeyframes(clip.keyframes, "crop")
      ? clip.keyframes.crop!.find((k) => typeof k.v === "object" && "w" in k.v)
      : undefined;
    if (first && media) {
      const r = normalizeCropRect(first.v as CropRect);
      crop = { x: 0, y: 0, width: r.w * media.width, height: r.h * media.height };
    }
    return fitRect({ width: W, height: H }, media, { ...placement, ...(crop && { crop }) });
  };

  /** Shape mask (gray W×H, 255 = keep): one frame drawn with geq (+ gblur, negate), looped. */
  const shapeMaskStream = (m: ClipMaskShape, rect: Rect, featherScale: number, dur: number) => {
    const r = maskShapeRect(rect, m);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const rx = Math.max(0.5, r.width / 2);
    const ry = Math.max(0.5, r.height / 2);
    const inside =
      m.shape === "ellipse"
        ? `lte(pow((X+0.5-${sec(cx)})/${sec(rx)},2)+pow((Y+0.5-${sec(cy)})/${sec(ry)},2),1)`
        : `between(X+0.5,${sec(r.x)},${sec(r.x + r.width)})*between(Y+0.5,${sec(r.y)},${sec(r.y + r.height)})`;
    const sigma = ((m.feather ?? 0) * featherScale) / 2;
    const chain = [
      `color=c=black:s=${W}x${H}:r=${FPS}:d=1`,
      "trim=end_frame=1",
      "format=gray",
      `geq=lum=${quoteFilterArg(`255*${inside}`)}`,
      ...(sigma >= 0.3 ? [`gblur=sigma=${sec(Math.min(sigma, 200))}:steps=3`] : []),
      ...(m.invert ? ["negate"] : []),
      "loop=loop=-1:size=1",
      `trim=duration=${sec(dur + frame)}`,
      `setpts=N/(${FPS}*TB)`,
    ];
    const label = g.label("mk");
    vadd(`${chain.join(",")}[${label}]`);
    return label;
  };

  /**
   * Asset mask (gray, 255 = keep) aligned to the clip: SAM mask folder (%05d.png per source frame,
   * numbered from the clip source start), one PNG / image (luma, alpha when it has one) or a video
   * (luma, or its alpha: «máscara alfa» WebM), scaled to the clip source size and sent through the
   * same crop / speed / placement filters as the clip.
   */
  const assetMaskStream = (
    clip: Clip,
    ma: TimelineAsset,
    src: TimelineAsset,
    o: { srcStart: number; segDur: number; speed: number; lead: number; placement: string[] },
  ): string => {
    let idx: number;
    const useAlpha = ma.kind !== "mask" && ma.hasAlpha === true;
    if (ma.kind === "mask" && !/\.png$/i.test(ma.absPath)) {
      const fps = ma.fps ?? src.fps ?? FPS;
      idx = g.input([
        "-framerate",
        String(+fps.toFixed(6)),
        "-start_number",
        String(Math.max(0, Math.round(o.srcStart * fps))),
        "-i",
        path.posix.join(ma.absPath.replace(/\\/g, "/"), "%05d.png"),
      ]);
    } else if (ma.kind === "mask" || ma.kind === "image") {
      idx = g.input([
        "-loop",
        "1",
        "-framerate",
        String(FPS),
        "-t",
        sec(o.segDur + frame),
        "-i",
        ma.absPath,
      ]);
    } else
      idx = mediaInput(
        { ...ma, ...(useAlpha && { hasAlpha: true }) },
        o.srcStart,
        o.segDur,
        o.speed,
      );
    const sw = src.width;
    const sh = src.height;
    const chain = [
      useAlpha ? "format=yuva420p,alphaextract" : "format=gray",
      ...(sw && sh ? [`scale=${even(sw)}:${even(sh)}`] : []),
      ...headChain(clip, o.speed, o.lead, "gray"),
      ...o.placement,
      "setsar=1",
      `fps=${FPS}`,
      "format=gray",
    ];
    const label = g.label("mk");
    vadd(`[${idx}:v]${chain.join(",")}[${label}]`);
    return label;
  };

  /**
   * Sprint 3b: multiply the alpha of a canvas-sized clip stream by its mask; returns the label of
   * the masked stream (`input` unchanged without a usable mask). `rect` = clip frame on the
   * stream, `featherScale` = clip scale (feather is given at 100 %).
   */
  const applyMask = (
    clip: Clip,
    a: TimelineAsset,
    input: string,
    o: {
      rect: Rect;
      featherScale: number;
      srcStart: number;
      segDur: number;
      speed: number;
      lead: number;
      placement: string[];
    },
  ): string => {
    const m = clip.maskRef;
    if (!m || audioOnly) return input;
    let mask: string;
    if (m.type === "shape") mask = shapeMaskStream(m, o.rect, o.featherScale, o.segDur);
    else {
      const ma = asset(m.assetId);
      if (!ma) {
        g.warnings.push(`Máscara ${m.assetId} no encontrada: el clip ${clip.id} queda sin máscara`);
        return input;
      }
      // Matte clips are composited at the alpha video size: align the mask to that.
      const mt = clip.matte ? asset(clip.matte.assetId) : undefined;
      const size = mt?.width && mt.height ? mt : a;
      mask = assetMaskStream(clip, ma, { ...a, width: size.width, height: size.height }, o);
    }
    const [c1, c2, ca, mm, out] = ["mc", "mc", "ma", "mm", "mo"].map((p) => g.label(p));
    vadd(`[${input}]split[${c1}][${c2}]`);
    vadd(`[${c2}]alphaextract[${ca}]`);
    vadd(`[${ca}][${mask}]blend=all_mode=multiply[${mm}]`);
    vadd(`[${c1}][${mm}]alphamerge[${out}]`);
    return out!;
  };

  /** Fixed opacity (colorchannelmixer) or Sprint 2 opacity keyframes (geq on the alpha plane). */
  const opacityFilters = (clip: Clip, lead: number): string[] => {
    if (hasKeyframes(clip.keyframes, "opacity")) {
      const tv = lead > 0 ? `(T-${sec(lead)})` : "T";
      const e = numberKeyframesExpr(clip.keyframes.opacity!, tv);
      return [
        `geq=lum=${quoteFilterArg("lum(X,Y)")}:cb=${quoteFilterArg("cb(X,Y)")}:cr=${quoteFilterArg("cr(X,Y)")}:a=${quoteFilterArg(`alpha(X,Y)*clip(${e},0,1)`)}`,
      ];
    }
    return clip.opacity < 1 ? [`colorchannelmixer=aa=${+clip.opacity.toFixed(3)}`] : [];
  };

  /**
   * Sprint 2: a clip with position/scale keyframes is overlaid on its own: fitted to the canvas,
   * scaled per frame (scale eval=frame) inside a fixed box (pad eval=frame), opacity/fades in
   * clip-local time, delayed to its start and placed with overlay x/y expressions (its center).
   * Transitions become alpha fades (no xfade with neighbours).
   */
  const floatingClip = (track: Track, clip: Clip): FloatSeg | undefined => {
    const a = asset(
      track.kind === "motion" ? (clip.renderedAssetId ?? clip.assetId) : clip.assetId,
    )!;
    const speed = clip.speed || 1;
    const start = clip.start;
    if (start >= T - EPS) return undefined;
    const dur = Math.min(clipDuration(clip), T - start);
    if (dur <= EPS) return undefined;
    const fadeIn = clip.transitionIn ? Math.min(clip.transitionIn.durationSec, dur / 2) : 0;
    const fadeOut = clip.transitionOut ? Math.min(clip.transitionOut.durationSec, dur / 2) : 0;
    const src = sourceInput(track, clip, a, clip.in, dur, speed);
    const chain = headChain(clip, speed, 0);
    const fitPad = [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    ];
    chain.push(...fitPad, "setsar=1", `fps=${FPS}`);
    let srcLabel = src.video;
    if (clip.maskRef && !audioOnly) {
      // Masked at scale 100 % (centered fit): the per-frame scale / position move the mask too.
      const pre = g.label("pm");
      vadd(`[${src.video}]${chain.join(",")}[${pre}]`);
      srcLabel = applyMask(clip, a, pre, {
        rect: clipFrameRect(clip, a, {}),
        featherScale: 1,
        srcStart: clip.in,
        segDur: dur,
        speed,
        lead: 0,
        placement: fitPad,
      });
      chain.length = 0;
    }
    if (a.kind !== "image") chain.push(`tpad=stop_mode=clone:stop_duration=${sec(dur)}`);
    chain.push(`trim=duration=${sec(dur)}`, "setpts=PTS-STARTPTS");
    // Box = canvas × max scale; the fitted media stays centered in it.
    const scaleKf = hasKeyframes(clip.keyframes, "scale") ? clip.keyframes.scale! : undefined;
    const s0 = clip.scale ?? 1;
    let BW = W;
    let BH = H;
    if (scaleKf) {
      const smax = Math.max(0.01, numberRange(scaleKf).max);
      BW = even(Math.ceil(W * smax));
      BH = even(Math.ceil(H * smax));
      const S = `max(0.001,${numberKeyframesExpr(scaleKf, "t")})`;
      chain.push(
        `scale=w=${quoteFilterArg(`max(2,2*trunc(${W}*${S}/2))`)}:h=${quoteFilterArg(`max(2,2*trunc(${H}*${S}/2))`)}:eval=frame`,
        `pad=w=${BW}:h=${BH}:x=(ow-iw)/2:y=(oh-ih)/2:eval=frame:color=black@0`,
      );
    } else if (Math.abs(s0 - 1) > EPS) {
      BW = even(W * s0);
      BH = even(H * s0);
      chain.push(`scale=${BW}:${BH}`);
    }
    chain.push(...opacityFilters(clip, 0));
    if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${sec(fadeIn)}:alpha=1`);
    if (fadeOut > 0) chain.push(`fade=t=out:st=${sec(dur - fadeOut)}:d=${sec(fadeOut)}:alpha=1`);
    chain.push("settb=AVTB", `setpts=PTS+${sec(start)}/TB`);
    const fl = g.label("fl");
    vadd(`[${srcLabel}]${chain.join(",")}[${fl}]`);
    if (src.audioIdx !== undefined) addAudio(src.audioIdx, clip, start, dur, 0, fadeIn, fadeOut);

    // Center of the clip in canvas fractions -> top-left of the box.
    const posKf = hasKeyframes(clip.keyframes, "position") ? clip.keyframes.position! : undefined;
    const tv = `(t-${sec(start)})`;
    let x: string;
    let y: string;
    if (posKf) {
      x = componentExpr(
        posKf,
        (v) => v.x,
        tv,
        (v) => v * W - BW / 2,
      );
      y = componentExpr(
        posKf,
        (v) => v.y,
        tv,
        (v) => v * H - BH / 2,
      );
    } else {
      const media = a.width && a.height ? { width: a.width, height: a.height } : undefined;
      const r = fitRect({ width: W, height: H }, media, {
        scale: Math.min(1, s0),
        ...(clip.position && { position: clip.position }),
      });
      const fitted = fitRect({ width: W, height: H }, media, { scale: Math.min(1, s0) });
      x = sec(r.x - fitted.x + (W - BW) / 2);
      y = sec(r.y - fitted.y + (H - BH) / 2);
    }
    return { label: fl, x, y };
  };

  const visualTrack = (track: Track, clips: readonly Clip[]): Seg | undefined => {
    if (clips.length === 0) return undefined;

    const segs: Seg[] = [];
    let acc: Seg | undefined;
    const flush = () => {
      if (segs.length === 0) return;
      const list = acc ? [acc, ...segs] : segs;
      if (list.length === 1) acc = list[0]!;
      else {
        const label = g.label("cat");
        vadd(
          `${list.map((s) => `[${s.label}]`).join("")}concat=n=${list.length}:v=1:a=0[${label}]`,
        );
        acc = { label, dur: list.reduce((n, s) => n + s.dur, 0) };
      }
      segs.length = 0;
    };

    let cursor = 0;
    let prev: { clip: Clip; dur: number } | undefined;
    clips.forEach((clip, i) => {
      const a = asset(
        track.kind === "motion" ? (clip.renderedAssetId ?? clip.assetId) : clip.assetId,
      )!;
      const speed = clip.speed || 1;
      let start = clip.start;
      let inSrc = clip.in;
      let dur = clipDuration(clip);
      if (start < cursor - EPS) {
        const skip = cursor - start;
        if (skip >= dur - EPS) {
          g.warnings.push(`Clip ${clip.id} solapado: se omite`);
          return;
        }
        inSrc += skip * speed;
        dur -= skip;
        start = cursor;
      }
      if (start >= T - EPS) return;
      dur = Math.min(dur, T - start);
      const gap = start - cursor;
      const adjacent = prev !== undefined && gap <= EPS;
      const tr = clip.transitionIn ?? (adjacent ? prev?.clip.transitionOut : undefined);
      let xfade = 0;
      let fadeIn = 0;
      if (tr && adjacent && prev) {
        let d = Math.min(tr.durationSec, dur / 2, prev.dur / 2);
        if (a.kind !== "image") d = Math.min(d, inSrc / speed);
        if (d >= frame) xfade = d;
        else fadeIn = Math.min(tr.durationSec, dur / 2);
      } else if (tr) fadeIn = Math.min(tr.durationSec, dur / 2);
      const next = clips[i + 1];
      const nextAdjacent = next !== undefined && Math.abs(next.start - (start + dur)) <= EPS;
      const fadeOut =
        clip.transitionOut && !nextAdjacent ? Math.min(clip.transitionOut.durationSec, dur / 2) : 0;

      if (gap > EPS) {
        const gl = g.label("gap");
        vadd(
          `color=c=black@0:s=${W}x${H}:r=${FPS}:d=${sec(gap)},format=yuva420p,settb=AVTB[${gl}]`,
        );
        segs.push({ label: gl, dur: gap });
      }

      const segDur = dur + xfade;
      const srcStart = Math.max(0, inSrc - xfade * speed);
      const src = sourceInput(track, clip, a, srcStart, segDur, speed);
      // Segment-local time = clip-local time + xfade (the segment starts xfade earlier).
      const chain = headChain(clip, speed, xfade);
      const placement =
        clip.scale !== undefined || clip.position
          ? pipPlacementFilters({
              canvas: { width: W, height: H },
              ...(clip.scale !== undefined && { scale: clip.scale }),
              ...(clip.position && { position: clip.position }),
            })
          : [
              `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
              `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
            ];
      chain.push(...placement, "setsar=1", `fps=${FPS}`);
      let srcLabel = src.video;
      if (clip.maskRef && !audioOnly) {
        const pre = g.label("pm");
        vadd(`[${src.video}]${chain.join(",")}[${pre}]`);
        srcLabel = applyMask(clip, a, pre, {
          rect: clipFrameRect(clip, a, {
            ...(clip.scale !== undefined && { scale: clip.scale }),
            ...(clip.position && { position: clip.position }),
          }),
          featherScale: Math.min(1, Math.max(0.05, clip.scale ?? 1)),
          srcStart,
          segDur,
          speed,
          lead: xfade,
          placement,
        });
        chain.length = 0;
      }
      chain.push(...opacityFilters(clip, xfade));
      if (a.kind !== "image") chain.push(`tpad=stop_mode=clone:stop_duration=${sec(segDur)}`);
      chain.push(`trim=duration=${sec(segDur)}`, "setpts=PTS-STARTPTS");
      if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${sec(fadeIn)}:alpha=1`);
      if (fadeOut > 0)
        chain.push(`fade=t=out:st=${sec(segDur - fadeOut)}:d=${sec(fadeOut)}:alpha=1`);
      chain.push("settb=AVTB");
      const sl = g.label("seg");
      vadd(`[${srcLabel}]${chain.join(",")}[${sl}]`);

      if (xfade > 0 && tr) {
        flush();
        const base = acc!;
        const xl = g.label("xf");
        vadd(
          `[${base.label}][${sl}]xfade=transition=${xfadeTransitionName(tr.type)}:duration=${sec(xfade)}:offset=${sec(base.dur - xfade)}[${xl}]`,
        );
        acc = { label: xl, dur: base.dur + segDur - xfade };
      } else segs.push({ label: sl, dur: segDur });

      if (src.audioIdx !== undefined)
        addAudio(src.audioIdx, clip, start, dur, xfade * speed, fadeIn, fadeOut);
      cursor = start + dur;
      prev = { clip, dur };
    });
    flush();
    return acc;
  };

  const drawTexts = (track: Track): string[] => {
    const filters: string[] = [];
    for (const clip of track.clips) {
      const text = clip.text?.trim();
      if (!text) continue;
      const start = clip.start;
      const end = Math.min(textEnd, start + clipDuration(clip));
      if (end - start <= EPS) continue;
      if (win && (end <= win.start + EPS || start >= win.end - EPS)) continue;
      const style: Partial<TextStyle> = clip.textStyle ?? {};
      const file = `text-${g.files.length}.txt`;
      g.files.push({ name: file, content: clip.text ?? "" });
      const size = Math.round(style.fontSize ?? 64);
      const margin = "h*0.08";
      const y =
        style.position === "top"
          ? margin
          : style.position === "center"
            ? "(h-text_h)/2"
            : `h-text_h-${margin}`;
      const font = o.fontFile
        ? `fontfile=${escapeFilterPath(o.fontFile)}`
        : `font=${quoteFilterArg(escapeOptionValue(style.fontFamily ?? "Inter"))}`;
      // Sprint 2 keyframes: drawtext evaluates x/y/fontsize/alpha per frame (t = timeline time).
      const kf = clip.keyframes;
      const tv = `(t-${sec(start)})`;
      const pos = hasKeyframes(kf, "position") ? kf.position! : undefined;
      const xExpr = pos
        ? quoteFilterArg(
            `${componentExpr(
              pos,
              (v) => v.x,
              tv,
              (v) => v * W,
            )}-text_w/2`,
          )
        : "(w-text_w)/2";
      const yExpr = pos
        ? quoteFilterArg(
            `${componentExpr(
              pos,
              (v) => v.y,
              tv,
              (v) => v * H,
            )}-text_h/2`,
          )
        : y;
      const fontSize = hasKeyframes(kf, "scale")
        ? quoteFilterArg(`max(1,${size}*(${numberKeyframesExpr(kf.scale!, tv)}))`)
        : String(size);
      const parts = [
        `drawtext=${font}`,
        `textfile=${file}`,
        "expansion=none",
        `fontsize=${fontSize}`,
        `fontcolor=${ffmpegColor(style.color)}`,
        ...(style.background
          ? ["box=1", `boxcolor=${ffmpegColor(style.background, "black@0.5")}`, "boxborderw=12"]
          : []),
        `x=${xExpr}`,
        `y=${yExpr}`,
        enableBetween(start, end),
      ];
      const fi = clip.transitionIn ? Math.min(clip.transitionIn.durationSec, (end - start) / 2) : 0;
      const fo = clip.transitionOut
        ? Math.min(clip.transitionOut.durationSec, (end - start) / 2)
        : 0;
      const opKf = hasKeyframes(kf, "opacity") ? kf.opacity! : undefined;
      const op = opKf
        ? `clip(${numberKeyframesExpr(opKf, tv)},0,1)`
        : String(+clip.opacity.toFixed(3));
      if (fi > 0 || fo > 0 || opKf || clip.opacity < 1) {
        const inExpr = fi > 0 ? `if(lt(t,${sec(start + fi)}),(t-${sec(start)})/${sec(fi)},1)` : "1";
        const outExpr = fo > 0 ? `if(gt(t,${sec(end - fo)}),(${sec(end)}-t)/${sec(fo)},1)` : "1";
        parts.push(`alpha=${quoteFilterArg(`${op}*min(${inExpr},${outExpr})`)}`);
      }
      filters.push(parts.join(":"));
    }
    return filters;
  };

  /**
   * Sprint 3b: composite a clip stream (canvas-sized from t = 0, or a floating box placed at
   * x/y) over `cur` with an FFmpeg blend mode, in planar RGB: blend(composite, layer) where the
   * layer is opaque, the composite elsewhere, weighted by the layer alpha (opacity/fades/mask).
   */
  const blendOnto = (top: string, mode: string, xy?: { x: string; y: string }) => {
    const [tc, full, b1, b2, t1, t2, ta, bg, bl, bla, next] = [
      "tc",
      "bt",
      "bb",
      "bb",
      "bt",
      "bt",
      "ba",
      "bg",
      "bl",
      "bm",
      "c",
    ].map((p) => g.label(p));
    const at = xy ? `x=${quoteFilterArg(xy.x)}:y=${quoteFilterArg(xy.y)}` : "0:0";
    vadd(`color=c=black@0:s=${W}x${H}:r=${FPS}:d=${sec(T)},format=yuva420p[${tc}]`);
    vadd(`[${tc}][${top}]overlay=${at}:eof_action=pass:format=auto,format=gbrap[${full}]`);
    if (mode === "addition") {
      // «Sumar» = canvas "lighter": composite + alpha × layer (premultiplied), clamped; the
      // alpha plane keeps the larger alpha (transparent exports).
      const [tp, bgA] = [g.label("bp"), g.label("bg")];
      vadd(`[${full}]premultiply=inplace=1[${tp}]`);
      vadd(`[${cur}]format=gbrap[${bgA}]`);
      vadd(
        `[${bgA}][${tp}]blend=c0_mode=addition:c1_mode=addition:c2_mode=addition:c3_mode=lighten,format=${alpha ? "yuva420p" : "yuv420p"}[${next}]`,
      );
      cur = next!;
      return;
    }
    vadd(`[${cur}]split[${b1}][${b2}]`);
    vadd(`[${full}]split[${t1}][${t2}]`);
    vadd(`[${t2}]alphaextract[${ta}]`);
    vadd(`[${b1}]format=gbrap[${bg}]`);
    vadd(`[${bg}][${t1}]blend=all_mode=${mode}[${bl}]`);
    vadd(`[${bl}][${ta}]alphamerge[${bla}]`);
    vadd(
      `[${b2}][${bla}]overlay=0:0:format=auto,format=${alpha ? "yuva420p" : "yuv420p"}[${next}]`,
    );
    cur = next!;
  };
  const blendOf = (c: Clip) => blendModeToFfmpeg(c.blendMode);

  for (const track of tracksInZOrder(project.tracks)) {
    if (track.kind === "audio") {
      if (track.muted || gif) continue;
      for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
        const a = asset(clip.assetId);
        if (!a || !a.hasAudio) {
          if (clip.assetId && !a) g.warnings.push(`Asset ${clip.assetId} no encontrado: se omite`);
          continue;
        }
        if (clip.start >= T - EPS) continue;
        const dur = Math.min(clipDuration(clip), T - clip.start);
        const fi = clip.transitionIn ? Math.min(clip.transitionIn.durationSec, dur / 2) : 0;
        const fo = clip.transitionOut ? Math.min(clip.transitionOut.durationSec, dur / 2) : 0;
        const idx = g.input([
          "-ss",
          sec(clip.in),
          "-t",
          sec(dur * (clip.speed || 1) + 0.5),
          "-i",
          a.absPath,
        ]);
        addAudio(idx, clip, clip.start, dur, 0, fi, fo);
      }
      continue;
    }
    if (track.hidden || (audioOnly && track.kind !== "video")) continue;
    if (track.kind === "text") {
      const filters = drawTexts(track);
      if (filters.length) {
        const next = g.label("c");
        g.add(`[${cur}]${absTime(filters.join(","))}[${next}]`);
        cur = next;
      }
      continue;
    }
    const playable = playableClips(
      win ? { ...track, clips: sliceClipsToWindow(track.clips, win) } : track,
    );
    const lanes = lanesOf(playable.filter((c) => !isFloatingClip(c) && !blendOf(c)));
    if (lanes.length > 1)
      g.warnings.push(
        `Clips solapados en «${track.name}»: se apilan en ${lanes.length} capas (el último encima)`,
      );
    for (const lane of lanes) {
      const stream = visualTrack(track, lane);
      if (!stream) continue;
      const next = g.label("c");
      vadd(`[${cur}][${stream.label}]overlay=0:0:eof_action=pass[${next}]`);
      cur = next;
    }
    // Blended clips: one stream each (no xfade with neighbours: their transitions become fades).
    for (const clip of playable.filter((c) => !isFloatingClip(c) && blendOf(c))) {
      const stream = visualTrack(track, [clip]);
      if (stream) blendOnto(stream.label, blendOf(clip)!);
    }
    for (const clip of playable.filter(isFloatingClip)) {
      const fl = floatingClip(track, clip);
      if (!fl) continue;
      const mode = blendOf(clip);
      if (mode) {
        blendOnto(fl.label, mode, fl);
        continue;
      }
      const next = g.label("c");
      vadd(
        `[${cur}][${fl.label}]overlay=x=${quoteFilterArg(fl.x)}:y=${quoteFilterArg(fl.y)}:eof_action=pass[${next}]`,
      );
      cur = next;
    }
  }

  const burn = subtitlesToBurn(project, effectiveBurnSubtitles(project, o.burnSubtitles));
  if (burn.length && !audioOnly) {
    const upper = project.captionStyle?.uppercase;
    const subs = upper ? burn.map((x) => ({ ...x, text: x.text.toLocaleUpperCase("es") })) : burn;
    // Fit the captions to the video rect (feedback 4), with real ASS alignment (feedback 3).
    const size = (id: string) => {
      const a = o.assets.get(id);
      return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
    };
    const proj = { ...project, settings: { ...project.settings, width: W, height: H } };
    g.files.push({
      name: "subs.ass",
      content: buildAss(subs, {
        canvas: { width: W, height: H },
        ...(project.captionStyle && { style: project.captionStyle }),
        rectAt: (t) => videoRectAt(proj, size, t),
      }),
    });
    const next = g.label("c");
    g.add(`[${cur}]${absTime("subtitles=subs.ass")}[${next}]`);
    cur = next;
  }

  // "Revisión para redes": small AI label bottom-left for the whole video (font/size from the
  // caption style), drawn on the project canvas like the captions.
  const label = aiLabelText(project.publish);
  if (label && !audioOnly) {
    g.files.push({ name: "ailabel.txt", content: label });
    g.add(`[${cur}]${aiLabelFilter(project, W, H, o.fontFile)}[${(cur = g.label("c"))}]`);
  }

  // Range trim + reframe to the preset size + output format.
  const PW = even(preset.width);
  const PH = even(preset.height);
  const post: string[] = [];
  if (rs > EPS) post.push(`trim=start=${sec(rs)}:end=${sec(re)}`, "setpts=PTS-STARTPTS");
  if (audioOnly) {
    // no video output
  } else if (gif) {
    const pre = post.length ? `[${cur}]${post.join(",")},` : `[${cur}]`;
    g.add(
      `${pre}fps=${FPS},scale=${PW}:-1:flags=lanczos,split[gs0][gs1];[gs0]palettegen=stats_mode=diff[gp];[gs1][gp]paletteuse=dither=bayer:bayer_scale=5[vout]`,
    );
  } else {
    const sameAspect = Math.abs(W / H - PW / PH) < 0.01;
    if (post.length) {
      const next = g.label("c");
      g.add(`[${cur}]${post.join(",")}[${next}]`);
      cur = next;
    }
    if (!sameAspect && reframeApplies(project, preset)) {
      // Sprint 2 reframe: crop of the target aspect whose center follows project.reframe
      // (absolute timeline seconds: local t + window / range start), fitted to the preset.
      const rf = project.reframe!;
      const win = reframeWindow({ width: W, height: H }, rf.target);
      const cw = win.w < 1 ? even(W * win.w) : W;
      const ch = win.h < 1 ? even(H * win.h) : H;
      const off = offset + rs;
      const tv = off > EPS ? `(t+${sec(off)})` : "t";
      const rects = rf.keyframes.map((k) =>
        typeof k.v === "object" && "w" in k.v ? { ...k, v: normalizeCropRect(k.v) } : k,
      ) as Keyframe<CropRect>[];
      const cx = componentExpr(
        rects,
        (v) => v.x + (v.w ?? 0) / 2,
        tv,
        (v) => v * W - cw / 2,
      );
      const cy = componentExpr(
        rects,
        (v) => v.y + (v.h ?? 0) / 2,
        tv,
        (v) => v * H - ch / 2,
      );
      const fit =
        Math.abs(cw / ch - PW / PH) < 0.01
          ? `scale=${PW}:${PH}`
          : `scale=${PW}:${PH}:force_original_aspect_ratio=decrease,pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2:color=black`;
      g.add(
        `[${cur}]crop=w=${cw}:h=${ch}:x=${quoteFilterArg(`clip(${cx},0,${W - cw})`)}:y=${quoteFilterArg(`clip(${cy},0,${H - ch})`)},${fit},setsar=1,format=${enc.pixFmt}[vout]`,
      );
    } else if (sameAspect || alpha) {
      const fit =
        W === PW && H === PH
          ? "null"
          : `scale=${PW}:${PH}:force_original_aspect_ratio=decrease,pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2:color=${alpha ? "black@0" : "black"}`;
      g.add(`[${cur}]${fit},setsar=1,format=${enc.pixFmt}[vout]`);
    } else {
      const next = g.label("rf");
      g.add(
        blurredBackgroundFilter(
          { width: PW, height: PH },
          { inLabel: cur, outLabel: next, prefix: "rf" },
        ),
      );
      g.add(`[${next}]format=${enc.pixFmt}[vout]`);
    }
  }

  const outDur = re - rs;
  if (!gif && !win) {
    if (audioLabels.length) {
      const ins = audioLabels.map((l) => `[${l}]`).join("");
      const trim = rs > EPS ? `atrim=start=${sec(rs)}:end=${sec(re)}` : `atrim=end=${sec(re)}`;
      // The mix is padded with silence up to the timeline end with a bounded
      // `apad=whole_dur`, not an endless `apad` cut by atrim/-t. When every audio input has
      // ended (music and voice end at 3 s of a 5.5 s timeline) the graph has to generate the
      // rest by itself; with an endless apad FFmpeg 9 sometimes stalls there forever (the
      // audio-only pass of the block render hung at out_time 3.008 on windows-latest; reproduced
      // on Linux with 9.0.2 in ~15 % of runs, 0 % with whole_dur).
      g.add(
        `${ins}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${sec(re)},${trim},asetpts=PTS-STARTPTS[aout]`,
      );
    } else {
      g.add(`anullsrc=r=48000:cl=stereo,atrim=duration=${sec(outDur)}[aout]`);
    }
  }

  const graph = g.parts.join(";\n");
  g.files.unshift({ name: "graph.txt", content: graph });
  const scriptFlag = (o.ffmpegMajor ?? 6) >= 7 ? "-/filter_complex" : "-filter_complex_script";
  const outputArgs = audioOnly
    ? ["-map", "[aout]", "-vn", ...enc.audio]
    : win
      ? [
          "-map",
          "[vout]",
          ...enc.video,
          ...segmentSafetyArgs(enc.video),
          "-g",
          String(win.gopFrames),
          "-force_key_frames",
          "0",
          "-frames:v",
          String(win.frames),
          "-an",
        ]
      : [
          "-map",
          "[vout]",
          ...(gif ? [] : ["-map", "[aout]"]),
          ...enc.video,
          ...enc.audio,
          ...(gif ? [] : metadataArgs(o.metadataComment)),
          ...enc.container,
        ];
  const args = [
    ...g.inputs.flat(),
    scriptFlag,
    "graph.txt",
    ...outputArgs,
    "-t",
    sec(outDur),
    o.output,
  ];
  return { args, graph, files: g.files, durationSec: outDur, warnings: g.warnings };
}

/** Media display size from the resolved assets (track geometry). */
export function assetSizeOf(
  assets: ReadonlyMap<string, TimelineAsset>,
): (id: string) => { width: number; height: number } | undefined {
  return (id) => {
    const a = assets.get(id);
    return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
  };
}

/**
 * Sprint 2: project as compiled — every `trackRef` (except motion templates that render the track
 * themselves) replaced by position keyframes (≤ 30 per second). The segment hash uses the same.
 */
export function resolveExportProject(
  project: Project,
  assets: ReadonlyMap<string, TimelineAsset>,
  tracks: ReadonlyMap<string, TrackFile>,
): Project {
  return resolveTrackRefs(project, tracks, assetSizeOf(assets), 30);
}

/**
 * True when `project.reframe` replaces the blurred background: keyframes present, preset aspect
 * different from the canvas, not GIF and not an alpha export.
 */
export function reframeApplies(
  project: Pick<Project, "reframe" | "settings">,
  preset: Pick<ExportPreset, "width" | "height" | "alpha" | "container" | "videoCodec">,
): boolean {
  if (!project.reframe?.keyframes.length) return false;
  if (preset.alpha || preset.container === "gif" || preset.videoCodec === "gif") return false;
  const W = even(project.settings.width);
  const H = even(project.settings.height);
  return Math.abs(W / H - even(preset.width) / even(preset.height)) >= 0.01;
}

/** True when a visual clip moves or zooms (overlaid on its own with x/y expressions). */
export function isFloatingClip(c: Pick<Clip, "keyframes">): boolean {
  return hasKeyframes(c.keyframes, "position") || hasKeyframes(c.keyframes, "scale");
}

/**
 * Visual clips of the timeline window [start, end) in window-local time: clips are cut at the
 * window edges (in/out moved, start rebased to 0) and lose the transition of a side that was cut.
 * The segment planner never cuts inside a transition window, so fades/xfades stay identical.
 */
export function sliceClipsToWindow(
  clips: readonly Clip[],
  win: { start: number; end: number },
): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const end = c.start + clipDuration(c);
    if (end <= win.start + EPS || c.start >= win.end - EPS) continue;
    const speed = c.speed || 1;
    const ns = Math.max(c.start, win.start);
    const ne = Math.min(end, win.end);
    const piece: Clip = {
      ...c,
      start: ns - win.start,
      in: c.in + (ns - c.start) * speed,
      out: c.in + (ne - c.start) * speed,
    };
    if (ns > c.start + EPS) delete piece.transitionIn;
    if (ne < end - EPS) delete piece.transitionOut;
    // Keyframes are clip-relative: rebase them to the piece (expressions stay exact per block).
    if (c.keyframes && ns > c.start)
      piece.keyframes = Object.fromEntries(
        Object.entries(c.keyframes).map(([k, v]) => [k, v && shiftKeyframes(v, ns - c.start)]),
      );
    out.push(piece);
  }
  return out;
}

/** drawtext of the AI label (textfile ailabel.txt in the job dir), bottom-left. */
export function aiLabelFilter(
  project: Pick<Project, "captionStyle">,
  W: number,
  H: number,
  fontFile?: string,
): string {
  const st = project.captionStyle;
  const unit = Math.min(W, H) / 1080;
  const size = Math.max(12, Math.round((st?.fontSize ?? 60) * 0.42 * unit));
  const margin = Math.max(8, Math.round(24 * unit));
  const font = fontFile
    ? `fontfile=${escapeFilterPath(fontFile)}`
    : `font=${quoteFilterArg(escapeOptionValue(st?.fontFamily || "Inter"))}`;
  return [
    `drawtext=${font}`,
    "textfile=ailabel.txt",
    "expansion=none",
    `fontsize=${size}`,
    "fontcolor=white@0.9",
    "box=1",
    "boxcolor=black@0.45",
    `boxborderw=${Math.max(4, Math.round(size * 0.3))}`,
    `x=${margin}`,
    `y=h-text_h-${margin}`,
  ].join(":");
}
