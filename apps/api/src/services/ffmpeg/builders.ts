import type { Transition, VideoEncoderId } from "@studio/shared";
import { atempoChain } from "./audio-fx.js";
import { escapeFilterPath, quoteFilterArg, sec } from "./escape.js";

/**
 * Typed FFmpeg command builders (fuentes-editor §4). Each returns the argv AFTER the global flags
 * added by runFfmpeg (-hide_banner -nostats -loglevel error -progress pipe:1 -y).
 */

const X264 = ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "192k"];

export interface Size {
  width: number;
  height: number;
}

/** Normalise any video stream to an exact canvas (letterbox), sar 1, fps and pix_fmt. */
export function fitFilter(
  size: Size,
  fps?: number,
  pixFmt = "yuv420p",
  padColor = "black",
): string {
  const { width: w, height: h } = size;
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`,
    "setsar=1",
    ...(fps ? [`fps=${fps}`] : []),
    `format=${pixFmt}`,
  ].join(",");
}

/** 4.1 Accurate trim (re-encode): -ss before -i + -t duration. */
export function trimArgs(o: {
  input: string;
  output: string;
  start: number;
  duration: number;
  video?: string[];
}): string[] {
  return [
    "-ss",
    sec(o.start),
    "-i",
    o.input,
    "-t",
    sec(o.duration),
    ...(o.video ?? ["-c:v", "libx264", "-crf", "18", "-preset", "medium"]),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    o.output,
  ];
}

export interface ConcatSegment {
  input: string;
  /** Source in/out (seconds). */
  start: number;
  end: number;
  hasAudio: boolean;
}

/** 4.2 Trim + concat filter in one graph (never the concat demuxer with inpoint/outpoint). */
export function concatFilter(segments: readonly ConcatSegment[], size: Size, fps: number): string {
  const parts: string[] = [];
  const pads: string[] = [];
  segments.forEach((s, i) => {
    const t = `${sec(s.start)}:${sec(s.end)}`;
    parts.push(`[${i}:v]trim=${t},setpts=PTS-STARTPTS,${fitFilter(size, fps)}[v${i}]`);
    parts.push(
      s.hasAudio
        ? `[${i}:a]atrim=${t},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${sec(s.end - s.start)}[a${i}]`,
    );
    pads.push(`[v${i}][a${i}]`);
  });
  parts.push(`${pads.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`);
  return parts.join(";");
}

export function concatArgs(o: {
  segments: readonly ConcatSegment[];
  size: Size;
  fps: number;
  output: string;
}): string[] {
  return [
    ...o.segments.flatMap((s) => ["-i", s.input]),
    "-filter_complex",
    concatFilter(o.segments, o.size, o.fps),
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...X264,
    ...AAC,
    "-movflags",
    "+faststart",
    o.output,
  ];
}

/** 4.3 Fit into a (vertical) canvas over a blurred, cropped copy of itself. */
export function blurredBackgroundFilter(
  size: Size,
  o: { inLabel?: string; outLabel?: string; sigma?: number; prefix?: string } = {},
): string {
  const { width: w, height: h } = size;
  const p = o.prefix ?? "";
  const inL = o.inLabel ?? "0:v";
  const outL = o.outLabel ?? "v";
  return (
    `[${inL}]split=2[${p}bg][${p}fg];` +
    `[${p}bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=${o.sigma ?? 30}[${p}bgb];` +
    `[${p}fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[${p}fgs];` +
    `[${p}bgb][${p}fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[${outL}]`
  );
}

export function verticalBlurArgs(o: { input: string; output: string; size?: Size }): string[] {
  return [
    "-i",
    o.input,
    "-filter_complex",
    blurredBackgroundFilter(o.size ?? { width: 1080, height: 1920 }),
    "-map",
    "[v]",
    "-map",
    "0:a?",
    ...X264,
    ...AAC,
    o.output,
  ];
}

/** 4.3 Center crop to 9:16 then scale. */
export function centerCropVerticalFilter(size: Size = { width: 1080, height: 1920 }): string {
  return `crop=ih*9/16:ih,scale=${size.width}:${size.height},setsar=1`;
}

/** 4.4 Speed: setpts=PTS/f + atempo chain (each atempo within [0.5, 2]). */
export function speedFilters(factor: number): { video: string; audio: string } {
  if (!(factor > 0)) throw new Error(`Invalid speed ${factor}`);
  return { video: `setpts=PTS/${+factor.toFixed(6)}`, audio: atempoChain(factor) };
}

export function speedArgs(o: {
  input: string;
  output: string;
  factor: number;
  hasAudio?: boolean;
}): string[] {
  const f = speedFilters(o.factor);
  const audio = o.hasAudio !== false;
  return [
    "-i",
    o.input,
    "-filter_complex",
    audio ? `[0:v]${f.video}[v];[0:a]${f.audio}[a]` : `[0:v]${f.video}[v]`,
    "-map",
    "[v]",
    ...(audio ? ["-map", "[a]"] : []),
    ...X264,
    ...(audio ? AAC : []),
    o.output,
  ];
}

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Overlay x/y expressions for a corner with a margin (4.6). */
export function cornerPosition(corner: Corner, margin = 24): { x: string; y: string } {
  return {
    x: corner.endsWith("left") ? String(margin) : `W-w-${margin}`,
    y: corner.startsWith("top") ? String(margin) : `H-h-${margin}`,
  };
}

/** `enable='between(t,a,b)'` (quoted: the expression contains commas). */
export function enableBetween(start: number, end: number): string {
  return `enable=${quoteFilterArg(`between(t,${sec(start)},${sec(end)})`)}`;
}

/** 4.5 Overlay an image (time window) or a video (starting at `start`, audio delayed). */
export function overlayFilter(o: {
  x: string;
  y: string;
  start: number;
  end?: number;
  isVideo: boolean;
  scaleWidth?: number;
  border?: { size: number; color: string };
}): string {
  const pre: string[] = [];
  if (o.scaleWidth) pre.push(`scale=${o.scaleWidth}:-2`);
  if (o.border)
    pre.push(
      `pad=iw+${o.border.size * 2}:ih+${o.border.size * 2}:${o.border.size}:${o.border.size}:color=${o.border.color}`,
    );
  if (o.isVideo) {
    pre.push(`setpts=PTS-STARTPTS+${sec(o.start)}/TB`);
    const enable = o.end !== undefined ? `:${enableBetween(o.start, o.end)}` : "";
    return `[1:v]${pre.join(",")}[ov];[0:v][ov]overlay=x=${o.x}:y=${o.y}:eof_action=pass${enable}[v]`;
  }
  const end = o.end ?? Number.MAX_SAFE_INTEGER;
  const src = pre.length ? `[1:v]${pre.join(",")}[ov];[0:v][ov]` : "[0:v][1:v]";
  return `${src}overlay=x=${o.x}:y=${o.y}:${enableBetween(o.start, end)}[v]`;
}

export function overlayArgs(o: {
  base: string;
  overlay: string;
  output: string;
  x: string;
  y: string;
  start: number;
  end?: number;
  isVideo: boolean;
  overlayHasAudio?: boolean;
  scaleWidth?: number;
  border?: { size: number; color: string };
}): string[] {
  const graph = overlayFilter(o);
  const mixAudio = o.isVideo && o.overlayHasAudio;
  const ms = Math.round(o.start * 1000);
  const audioGraph = mixAudio
    ? `;[1:a]adelay=${ms}|${ms}[oa];[0:a][oa]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
    : "";
  return [
    "-i",
    o.base,
    ...(o.isVideo ? [] : ["-loop", "1"]),
    "-i",
    o.overlay,
    "-filter_complex",
    graph + audioGraph,
    "-map",
    "[v]",
    ...(mixAudio ? ["-map", "[a]"] : ["-map", "0:a?"]),
    ...X264,
    ...(mixAudio ? AAC : ["-c:a", "copy"]),
    ...(o.isVideo ? [] : ["-shortest"]),
    o.output,
  ];
}

/** 4.6 Picture-in-picture: scaled overlay video in a corner, optional white frame. */
export function pipArgs(o: {
  base: string;
  overlay: string;
  output: string;
  corner?: Corner;
  width?: number;
  margin?: number;
  start?: number;
  border?: number;
  overlayHasAudio?: boolean;
}): string[] {
  const pos = cornerPosition(o.corner ?? "bottom-right", o.margin ?? 24);
  return overlayArgs({
    base: o.base,
    overlay: o.overlay,
    output: o.output,
    ...pos,
    start: o.start ?? 0,
    isVideo: true,
    scaleWidth: o.width ?? 320,
    ...(o.border && { border: { size: o.border, color: "white" } }),
    ...(o.overlayHasAudio !== undefined && { overlayHasAudio: o.overlayHasAudio }),
  });
}

/**
 * Picture-in-picture placement on the export timeline (Clip.scale / Clip.position): fit the clip
 * into `scale` × canvas, then pad it to the full transparent canvas with its free space split by
 * `position` (0 = left/top, 0.5 = centered, 1 = right/bottom). Keeps each segment canvas-sized so
 * concat/xfade/overlay=0:0 work unchanged.
 */
export function pipPlacementFilters(o: {
  canvas: Size;
  scale?: number;
  position?: { x: number; y: number };
}): string[] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const s = clamp(o.scale ?? 1, 0.05, 1);
  const w = Math.max(2, Math.round((o.canvas.width * s) / 2) * 2);
  const h = Math.max(2, Math.round((o.canvas.height * s) / 2) * 2);
  const px = +clamp(o.position?.x ?? 0.5, 0, 1).toFixed(4);
  const py = +clamp(o.position?.y ?? 0.5, 0, 1).toFixed(4);
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${o.canvas.width}:${o.canvas.height}:(ow-iw)*${px}:(oh-ih)*${py}:color=black@0`,
  ];
}

/** 4.7 Fade in/out for video and audio given the clip duration (st of fade-out = dur - d). */
export function fadeFilters(o: {
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  alpha?: boolean;
}): { video: string; audio: string } {
  const v: string[] = [];
  const a: string[] = [];
  const alpha = o.alpha ? ":alpha=1" : "";
  if (o.fadeIn && o.fadeIn > 0) {
    v.push(`fade=t=in:st=0:d=${sec(o.fadeIn)}${alpha}`);
    a.push(`afade=t=in:st=0:d=${sec(o.fadeIn)}`);
  }
  if (o.fadeOut && o.fadeOut > 0) {
    const st = Math.max(0, o.duration - o.fadeOut);
    v.push(`fade=t=out:st=${sec(st)}:d=${sec(o.fadeOut)}${alpha}`);
    a.push(`afade=t=out:st=${sec(st)}:d=${sec(o.fadeOut)}`);
  }
  return { video: v.join(",") || "null", audio: a.join(",") || "anull" };
}

/** Timeline transition type -> xfade transition name. */
export function xfadeTransitionName(type: Transition["type"]): string {
  switch (type) {
    case "fade":
      return "fadeblack";
    case "crossfade":
      return "fade";
    case "wipe":
      return "wipeleft";
    case "slide":
      return "slideleft";
    case "zoom":
      return "zoomin";
  }
}

/** offset_k = sum(durations up to k) - k * d  (k = 1..n-1). */
export function xfadeOffsets(durations: readonly number[], d: number): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (let k = 1; k < durations.length; k++) {
    acc += durations[k - 1]!;
    offsets.push(acc - k * d);
  }
  return offsets;
}

/** 4.8 xfade chain over N inputs (same size/fps/pix_fmt/timebase) + acrossfade for audio. */
export function xfadeFilter(o: {
  durations: readonly number[];
  transition: string;
  duration: number;
  size: Size;
  fps: number;
  withAudio: boolean;
}): string {
  const n = o.durations.length;
  if (n < 2) throw new Error("xfade needs at least two inputs");
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]${fitFilter(o.size, o.fps)},settb=AVTB[v${i}]`);
  const offsets = xfadeOffsets(o.durations, o.duration);
  let prev = "v0";
  for (let k = 1; k < n; k++) {
    const out = k === n - 1 ? "v" : `x${k}`;
    parts.push(
      `[${prev}][v${k}]xfade=transition=${o.transition}:duration=${sec(o.duration)}:offset=${sec(offsets[k - 1]!)}[${out}]`,
    );
    prev = out;
  }
  if (o.withAudio) {
    let aprev = "0:a";
    for (let k = 1; k < n; k++) {
      const out = k === n - 1 ? "a" : `ax${k}`;
      parts.push(`[${aprev}][${k}:a]acrossfade=d=${sec(o.duration)}[${out}]`);
      aprev = out;
    }
  }
  return parts.join(";");
}

export function xfadeArgs(o: {
  inputs: readonly string[];
  durations: readonly number[];
  transition?: string;
  duration?: number;
  size: Size;
  fps: number;
  withAudio?: boolean;
  output: string;
}): string[] {
  const withAudio = o.withAudio !== false;
  return [
    ...o.inputs.flatMap((i) => ["-i", i]),
    "-filter_complex",
    xfadeFilter({
      durations: o.durations,
      transition: o.transition ?? "fade",
      duration: o.duration ?? 1,
      size: o.size,
      fps: o.fps,
      withAudio,
    }),
    "-map",
    "[v]",
    ...(withAudio ? ["-map", "[a]"] : []),
    ...X264,
    ...(withAudio ? AAC : []),
    o.output,
  ];
}

export interface SubtitleStyle {
  fontName?: string;
  fontSize?: number;
  /** ASS colour &HAABBGGRR. */
  primaryColour?: string;
  outlineColour?: string;
  outline?: number;
  /** ASS numpad alignment (2 = bottom center). */
  alignment?: number;
  marginV?: number;
}

/** "#RRGGBB" -> ASS "&H00BBGGRR" (BGR order!). */
export function hexToAssColour(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return "&H00FFFFFF";
  const alpha = m[4] ? (255 - parseInt(m[4], 16)).toString(16).padStart(2, "0") : "00";
  return `&H${alpha}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

/** ASS v4+ numpad alignment (1-9) -> legacy SSA code used by libass internally / force_style. */
export function numpadToSsaAlignment(numpad: number): number {
  const n = Math.min(9, Math.max(1, Math.round(numpad)));
  const col = ((n - 1) % 3) + 1;
  return n <= 3 ? col : n <= 6 ? col + 8 : col + 4;
}

export function forceStyle(style: SubtitleStyle): string {
  const s: string[] = [];
  if (style.fontName) s.push(`FontName=${style.fontName}`);
  if (style.fontSize) s.push(`FontSize=${style.fontSize}`);
  s.push(`PrimaryColour=${style.primaryColour ?? "&H00FFFFFF"}`);
  s.push(`OutlineColour=${style.outlineColour ?? "&H00000000"}`);
  s.push("BorderStyle=1", `Outline=${style.outline ?? 2}`);
  // libass applies force_style values raw, and it stores alignment as legacy SSA codes (1-3 bottom,
  // 5-7 top, 9-11 middle): numpad 5 would land top-left. Convert numpad -> SSA.
  s.push(
    `Alignment=${numpadToSsaAlignment(style.alignment ?? 2)}`,
    `MarginV=${style.marginV ?? 40}`,
  );
  return s.join(",");
}

/**
 * 4.9 Burn SRT (subtitles=) or ASS (ass=) subtitles. `file` may be a simple name relative to the
 * ffmpeg cwd (recommended) or an absolute Windows/posix path (escaped with escapeFilterPath).
 */
export function burnSubtitlesFilter(o: {
  file: string;
  format?: "srt" | "ass";
  fontsDir?: string;
  style?: SubtitleStyle;
}): string {
  const format = o.format ?? (o.file.toLowerCase().endsWith(".ass") ? "ass" : "srt");
  const opts = [`${format === "ass" ? "ass" : "subtitles"}=${escapeFilterPath(o.file)}`];
  if (o.fontsDir) opts.push(`fontsdir=${escapeFilterPath(o.fontsDir)}`);
  if (format === "srt" && o.style) opts.push(`force_style=${quoteFilterArg(forceStyle(o.style))}`);
  return opts.join(":");
}

export function burnSubtitlesArgs(o: {
  input: string;
  output: string;
  file: string;
  fontsDir?: string;
  style?: SubtitleStyle;
}): string[] {
  return [
    "-i",
    o.input,
    "-vf",
    burnSubtitlesFilter(o),
    "-map",
    "0:v",
    "-map",
    "0:a?",
    ...X264,
    "-c:a",
    "copy",
    o.output,
  ];
}

export interface MixInput {
  input: string;
  /** Start on the output timeline (seconds). */
  delaySec?: number;
  volume?: number;
}

/** 4.10 amix + adelay (ms per channel) + volume; normalize=0 keeps levels. */
export function audioMixFilter(
  inputs: readonly MixInput[],
  duration: "first" | "longest" | "shortest" = "longest",
): string {
  const parts: string[] = [];
  const labels: string[] = [];
  inputs.forEach((m, i) => {
    const chain: string[] = [];
    if (m.delaySec && m.delaySec > 0) {
      const ms = Math.round(m.delaySec * 1000);
      chain.push(`adelay=${ms}|${ms}`);
    }
    chain.push(`volume=${+(m.volume ?? 1).toFixed(3)}`);
    parts.push(`[${i}:a]${chain.join(",")}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  parts.push(
    `${labels.join("")}amix=inputs=${inputs.length}:duration=${duration}:dropout_transition=0:normalize=0[a]`,
  );
  return parts.join(";");
}

export function audioMixArgs(o: {
  inputs: readonly MixInput[];
  output: string;
  duration?: "first" | "longest" | "shortest";
}): string[] {
  return [
    ...o.inputs.flatMap((m) => ["-i", m.input]),
    "-filter_complex",
    audioMixFilter(o.inputs, o.duration),
    "-map",
    "[a]",
    "-ar",
    "48000",
    o.output,
  ];
}

/* ---------- Media derivatives (fuentes-editor §3.4-3.5) ---------- */

/** One JPEG thumbnail at `atSec`, 320 px wide. */
export function thumbnailArgs(o: {
  input: string;
  output: string;
  atSec?: number;
  width?: number;
}): string[] {
  return [
    ...(o.atSec ? ["-ss", sec(o.atSec)] : []),
    "-i",
    o.input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${o.width ?? 320}:-2`,
    "-q:v",
    "3",
    o.output,
  ];
}

export interface SpritePlan {
  intervalSec: number;
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
}

/** Plan a sprite sheet with at most `maxTiles` tiles (1 per second for short clips). */
export function planSprite(
  durationSec: number,
  o: { maxTiles?: number; columns?: number; tileWidth?: number } = {},
): SpritePlan {
  const maxTiles = o.maxTiles ?? 100;
  const intervalSec = Math.max(1, Math.ceil(durationSec / maxTiles));
  const count = Math.max(1, Math.min(maxTiles, Math.floor(durationSec / intervalSec) || 1));
  const columns = Math.min(o.columns ?? 10, count);
  return {
    intervalSec,
    count,
    columns,
    rows: Math.ceil(count / columns),
    tileWidth: o.tileWidth ?? 160,
  };
}

export function spriteArgs(o: { input: string; output: string; plan: SpritePlan }): string[] {
  const p = o.plan;
  const fps = p.intervalSec === 1 ? "1" : `1/${p.intervalSec}`;
  return [
    "-i",
    o.input,
    "-vf",
    `fps=${fps},scale=${p.tileWidth}:-2,tile=${p.columns}x${p.rows}`,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    o.output,
  ];
}

/**
 * Video args of an editing proxy / intermediate for an H.264 encoder (Sprint 1: NVENC & co. with
 * libx264 fallback): fast, low quality, a keyframe every `gop` frames, no B-frames on hardware.
 */
export function proxyVideoArgs(encoder: VideoEncoderId = "libx264", gop = 15): string[] {
  const g = String(gop);
  switch (encoder) {
    case "h264_nvenc":
      return [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p2",
        "-rc",
        "vbr",
        "-cq",
        "30",
        "-b:v",
        "0",
        "-g",
        g,
        "-bf",
        "0",
        "-no-scenecut",
        "1",
      ];
    case "h264_qsv":
      return [
        "-c:v",
        "h264_qsv",
        "-preset",
        "veryfast",
        "-global_quality",
        "30",
        "-g",
        g,
        "-bf",
        "0",
      ];
    case "h264_amf":
      return [
        "-c:v",
        "h264_amf",
        "-quality",
        "speed",
        "-rc",
        "cqp",
        "-qp_i",
        "28",
        "-qp_p",
        "30",
        "-g",
        g,
        "-bf",
        "0",
      ];
    case "libx264":
      return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-g",
        g,
        "-keyint_min",
        g,
        "-sc_threshold",
        "0",
      ];
  }
}

/** Low-res editing proxy: 360p, keyframe every 15 frames for smooth scrubbing. */
export function proxyArgs(o: {
  input: string;
  output: string;
  height?: number;
  hasAudio?: boolean;
  /** H.264 encoder (hardware when available; libx264 default). */
  encoder?: VideoEncoderId;
}): string[] {
  return [
    "-i",
    o.input,
    "-map",
    "0:v:0",
    ...(o.hasAudio === false ? [] : ["-map", "0:a:0?"]),
    "-vf",
    `scale=-2:${o.height ?? 360}`,
    ...proxyVideoArgs(o.encoder),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    o.output,
  ];
}

/** Decode the first audio stream to mono s16le PCM on stdout (waveform peaks). */
export function pcmArgs(o: { input: string; sampleRate?: number }): string[] {
  return [
    "-i",
    o.input,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(o.sampleRate ?? 8000),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];
}

/** WAV extraction (e.g. 16 kHz mono for Whisper). */
export function extractAudioArgs(o: {
  input: string;
  output: string;
  sampleRate?: number;
  channels?: number;
}): string[] {
  return [
    "-i",
    o.input,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    String(o.channels ?? 1),
    "-ar",
    String(o.sampleRate ?? 16000),
    "-c:a",
    "pcm_s16le",
    o.output,
  ];
}

/** Render an image overlay window or drawtext; exported for timeline + tests. */
export { escapeFilterPath };
