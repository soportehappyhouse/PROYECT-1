import type {
  Clip,
  ExportPreset,
  MediaKind,
  Project,
  TextStyle,
  Track,
  VideoEncoderId,
} from "@studio/shared";
import { atempoChain, buildAudioFxGraph } from "./audio-fx.js";
import {
  blurredBackgroundFilter,
  enableBetween,
  forceStyle,
  hexToAssColour,
  pipPlacementFilters,
  xfadeTransitionName,
  type SubtitleStyle,
} from "./builders.js";
import { escapeFilterPath, escapeOptionValue, quoteFilterArg, sec } from "./escape.js";
import { presetEncoding } from "./encoders.js";
import { toSrt } from "./srt.js";

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
}

export interface CompiledExport {
  /** argv after the global flags (run with cwd = job dir: graph/text/subtitle files are relative). */
  args: string[];
  graph: string;
  /** Files to write into the job dir before running (graph.txt, text-N.txt, subs.srt). */
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

/**
 * project.captionStyle -> libass force_style. SRT renders at PlayResY 288, so sizes given in 1080p
 * pixels are scaled by 288/1080. Without a style: Inter 18, bottom.
 */
export function captionForceStyle(project: Pick<Project, "captionStyle">): SubtitleStyle {
  const c = project.captionStyle;
  if (!c) return { fontName: "Inter", fontSize: 18, marginV: 30 };
  const hex = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : undefined;
  return {
    fontName: c.fontFamily,
    fontSize: Math.max(8, Math.round((c.fontSize * 288) / 1080)),
    ...(hex && { primaryColour: hexToAssColour(hex) }),
    alignment: c.position === "top" ? 8 : c.position === "center" ? 5 : 2,
    marginV: 30,
  };
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

/**
 * Compile a Project into one FFmpeg filter_complex invocation:
 *  - canvas = project.settings (w×h), fps = preset.fps; black (or transparent) base of length T;
 *  - tracks are layered in array order (tracks[0] at the bottom); video/motion tracks become one
 *    stream each (clips in sequence, transparent gaps, xfade for adjacent transitions, alpha fades
 *    otherwise) overlaid on the composite; text tracks are drawtext; audio of video+audio tracks is
 *    trimmed/sped/effected/delayed and amix-ed;
 *  - project.subtitles are burned (SRT), then range trim, reframe to preset size (blurred
 *    background when the aspect ratio differs) and preset encoding (GIF via palettegen).
 */
export function compileExport(o: CompileExportOptions): CompiledExport {
  const { project, preset } = o;
  const g = new GraphBuilder();
  const W = even(project.settings.width);
  const H = even(project.settings.height);
  const FPS = preset.fps;
  const enc = presetEncoding(preset, o.encoder ?? "libx264");
  const alpha = enc.alpha;
  /** GIF has no audio: no audio chains may be left unconnected in the graph. */
  const gif = enc.extension === "gif";
  const total = timelineDuration(project);
  const rs = Math.max(0, o.range?.start ?? 0);
  const re = Math.min(o.range?.end ?? total, total);
  if (!(re - rs > EPS))
    throw new Error("El proyecto no tiene contenido para exportar en ese rango");
  const T = re;
  const frame = 1 / FPS;

  let cur = g.label("base");
  g.add(
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
    if (gif || clip.volume <= 0 || dur <= EPS) return;
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
    const tail = ["apad", `atrim=duration=${sec(dur)}`];
    if (fadeIn > 0) tail.push(`afade=t=in:st=0:d=${sec(fadeIn)}`);
    if (fadeOut > 0)
      tail.push(`afade=t=out:st=${sec(Math.max(0, dur - fadeOut))}:d=${sec(fadeOut)}`);
    tail.push("aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
    const ms = Math.round(startOnTimeline * 1000);
    if (ms > 0) tail.push(`adelay=${ms}|${ms}`);
    g.add(`[${post}]${tail.join(",")}[${out}]`);
    audioLabels.push(out);
  };

  const visualTrack = (track: Track): Seg | undefined => {
    const clips = track.clips
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
    if (clips.length === 0) return undefined;

    const segs: Seg[] = [];
    let acc: Seg | undefined;
    const flush = () => {
      if (segs.length === 0) return;
      const list = acc ? [acc, ...segs] : segs;
      if (list.length === 1) acc = list[0]!;
      else {
        const label = g.label("cat");
        g.add(
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
        g.add(
          `color=c=black@0:s=${W}x${H}:r=${FPS}:d=${sec(gap)},format=yuva420p,settb=AVTB[${gl}]`,
        );
        segs.push({ label: gl, dur: gap });
      }

      const segDur = dur + xfade;
      const srcStart = Math.max(0, inSrc - xfade * speed);
      let idx: number;
      if (a.kind === "image") {
        idx = g.input([
          "-loop",
          "1",
          "-framerate",
          String(FPS),
          "-t",
          sec(segDur + frame),
          "-i",
          a.absPath,
        ]);
      } else {
        const vp9Alpha =
          a.videoCodec === "vp9" && (a.hasAlpha ?? true) && /\.webm$/i.test(a.absPath);
        idx = g.input([
          "-ss",
          sec(srcStart),
          "-t",
          sec(segDur * speed + 0.5),
          ...(vp9Alpha ? ["-c:v", "libvpx-vp9"] : []),
          "-i",
          a.absPath,
        ]);
      }
      const chain: string[] = [];
      if (clip.crop) {
        const c = clip.crop;
        chain.push(
          `crop=${Math.round(c.width)}:${Math.round(c.height)}:${Math.round(c.x)}:${Math.round(c.y)}`,
        );
      }
      chain.push("setpts=PTS-STARTPTS");
      if (Math.abs(speed - 1) > EPS) chain.push(`setpts=PTS/${+speed.toFixed(6)}`);
      chain.push("format=yuva420p");
      if (clip.scale !== undefined || clip.position)
        chain.push(
          ...pipPlacementFilters({
            canvas: { width: W, height: H },
            ...(clip.scale !== undefined && { scale: clip.scale }),
            ...(clip.position && { position: clip.position }),
          }),
        );
      else
        chain.push(
          `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        );
      chain.push("setsar=1", `fps=${FPS}`);
      if (clip.opacity < 1) chain.push(`colorchannelmixer=aa=${+clip.opacity.toFixed(3)}`);
      if (a.kind !== "image") chain.push(`tpad=stop_mode=clone:stop_duration=${sec(segDur)}`);
      chain.push(`trim=duration=${sec(segDur)}`, "setpts=PTS-STARTPTS");
      if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${sec(fadeIn)}:alpha=1`);
      if (fadeOut > 0)
        chain.push(`fade=t=out:st=${sec(segDur - fadeOut)}:d=${sec(fadeOut)}:alpha=1`);
      chain.push("settb=AVTB");
      const sl = g.label("seg");
      g.add(`[${idx}:v]${chain.join(",")}[${sl}]`);

      if (xfade > 0 && tr) {
        flush();
        const base = acc!;
        const xl = g.label("xf");
        g.add(
          `[${base.label}][${sl}]xfade=transition=${xfadeTransitionName(tr.type)}:duration=${sec(xfade)}:offset=${sec(base.dur - xfade)}[${xl}]`,
        );
        acc = { label: xl, dur: base.dur + segDur - xfade };
      } else segs.push({ label: sl, dur: segDur });

      if (track.kind === "video" && !track.muted && a.hasAudio && a.kind !== "image") {
        addAudio(idx, clip, start, dur, xfade * speed, fadeIn, fadeOut);
      }
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
      const end = Math.min(T, start + clipDuration(clip));
      if (end - start <= EPS) continue;
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
      const parts = [
        `drawtext=${font}`,
        `textfile=${file}`,
        "expansion=none",
        `fontsize=${size}`,
        `fontcolor=${ffmpegColor(style.color)}`,
        ...(style.background
          ? ["box=1", `boxcolor=${ffmpegColor(style.background, "black@0.5")}`, "boxborderw=12"]
          : []),
        "x=(w-text_w)/2",
        `y=${y}`,
        enableBetween(start, end),
      ];
      const fi = clip.transitionIn ? Math.min(clip.transitionIn.durationSec, (end - start) / 2) : 0;
      const fo = clip.transitionOut
        ? Math.min(clip.transitionOut.durationSec, (end - start) / 2)
        : 0;
      const op = +clip.opacity.toFixed(3);
      if (fi > 0 || fo > 0 || op < 1) {
        const inExpr = fi > 0 ? `if(lt(t,${sec(start + fi)}),(t-${sec(start)})/${sec(fi)},1)` : "1";
        const outExpr = fo > 0 ? `if(gt(t,${sec(end - fo)}),(${sec(end)}-t)/${sec(fo)},1)` : "1";
        parts.push(`alpha=${quoteFilterArg(`${op}*min(${inExpr},${outExpr})`)}`);
      }
      filters.push(parts.join(":"));
    }
    return filters;
  };

  for (const track of project.tracks) {
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
    if (track.hidden) continue;
    if (track.kind === "text") {
      const filters = drawTexts(track);
      if (filters.length) {
        const next = g.label("c");
        g.add(`[${cur}]${filters.join(",")}[${next}]`);
        cur = next;
      }
      continue;
    }
    const stream = visualTrack(track);
    if (stream) {
      const next = g.label("c");
      g.add(`[${cur}][${stream.label}]overlay=0:0:eof_action=pass[${next}]`);
      cur = next;
    }
  }

  if (project.subtitles.length) {
    const upper = project.captionStyle?.uppercase;
    const subs = upper
      ? project.subtitles.map((x) => ({ ...x, text: x.text.toLocaleUpperCase("es") }))
      : project.subtitles;
    g.files.push({ name: "subs.srt", content: toSrt(subs) });
    const next = g.label("c");
    const style = forceStyle(captionForceStyle(project));
    g.add(`[${cur}]subtitles=subs.srt:force_style=${quoteFilterArg(style)}[${next}]`);
    cur = next;
  }

  // Range trim + reframe to the preset size + output format.
  const PW = even(preset.width);
  const PH = even(preset.height);
  const post: string[] = [];
  if (rs > EPS) post.push(`trim=start=${sec(rs)}:end=${sec(re)}`, "setpts=PTS-STARTPTS");
  if (gif) {
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
    if (sameAspect || alpha) {
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
  if (!gif) {
    if (audioLabels.length) {
      const ins = audioLabels.map((l) => `[${l}]`).join("");
      const trim = rs > EPS ? `atrim=start=${sec(rs)}:end=${sec(re)}` : `atrim=end=${sec(re)}`;
      g.add(
        `${ins}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad,${trim},asetpts=PTS-STARTPTS[aout]`,
      );
    } else {
      g.add(`anullsrc=r=48000:cl=stereo,atrim=duration=${sec(outDur)}[aout]`);
    }
  }

  const graph = g.parts.join(";\n");
  g.files.unshift({ name: "graph.txt", content: graph });
  const scriptFlag = (o.ffmpegMajor ?? 6) >= 7 ? "-/filter_complex" : "-filter_complex_script";
  const args = [
    ...g.inputs.flat(),
    scriptFlag,
    "graph.txt",
    "-map",
    "[vout]",
    ...(gif ? [] : ["-map", "[aout]"]),
    ...enc.video,
    ...enc.audio,
    ...enc.container,
    "-t",
    sec(outDur),
    o.output,
  ];
  return { args, graph, files: g.files, durationSec: outDur, warnings: g.warnings };
}
