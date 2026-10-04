import { existsSync } from "node:fs";
import type { MotionOutputFormat, MotionSpec } from "@studio/shared";
import { z } from "zod";
import { FFMPEG_COLOR, filterExpr, filterPath, num } from "./escape.js";

const ffColor = (title: string) =>
  z
    .string()
    .regex(FFMPEG_COLOR, "Color FFmpeg inválido (nombre, #RRGGBB o 0xRRGGBB[@alfa])")
    .meta({ title });

export const FFMPEG_TITLE_POSITIONS = ["center", "top", "bottom"] as const;
export const OVERLAY_POSITIONS = [
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

/** Props of the `ffmpeg-title` template (drawtext title with fade + optional alpha overlay). */
export const ffmpegTitleSchema = z.object({
  text: z.string().min(1).max(200).meta({ title: "Título" }).default("Mi título"),
  subtitle: z.string().max(200).meta({ title: "Subtítulo" }).default(""),
  fontFile: z.string().meta({ title: "Archivo de fuente (.ttf), opcional" }).optional(),
  fontSize: z.number().int().min(8).max(400).meta({ title: "Tamaño del título" }).default(96),
  subtitleSize: z
    .number()
    .int()
    .min(8)
    .max(300)
    .meta({ title: "Tamaño del subtítulo" })
    .default(48),
  fontColor: ffColor("Color del texto").default("white"),
  borderColor: ffColor("Color del borde").default("black"),
  borderWidth: z.number().int().min(0).max(20).meta({ title: "Grosor del borde" }).default(3),
  background: z
    .union([z.literal("transparent"), ffColor("Fondo")])
    .meta({ title: "Fondo (color o transparent)" })
    .default("#111111"),
  position: z.enum(FFMPEG_TITLE_POSITIONS).meta({ title: "Posición" }).default("center"),
  fadeInSec: z.number().min(0).max(10).meta({ title: "Fundido de entrada (s)" }).default(0.5),
  fadeOutSec: z.number().min(0).max(10).meta({ title: "Fundido de salida (s)" }).default(0.5),
  risePx: z.number().min(0).max(500).meta({ title: "Desplazamiento de entrada (px)" }).default(40),
  overlayPosition: z
    .enum(OVERLAY_POSITIONS)
    .meta({ title: "Posición del overlay" })
    .default("center"),
  overlayStartSec: z.number().min(0).meta({ title: "Inicio del overlay (s)" }).default(0),
});
export type FfmpegTitleProps = z.infer<typeof ffmpegTitleSchema>;

/** Platform default bold font for drawtext (null = let fontconfig pick). */
export function defaultFontFile(platform: NodeJS.Platform = process.platform): string | null {
  const candidates =
    platform === "win32"
      ? ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf"]
      : platform === "darwin"
        ? ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"]
        : [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
          ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

export interface TitleCommandInput {
  spec: MotionSpec;
  props: FfmpegTitleProps;
  /** Absolute output file (or folder for png-sequence). */
  output: string;
  /** Absolute UTF-8 text files with the title / subtitle (avoids escaping user text). */
  titleFile: string;
  subtitleFile?: string;
  /** Resolved font file (props.fontFile ?? defaultFontFile()). */
  fontFile: string | null;
  /** Absolute background video/image (instead of a solid color). */
  backgroundMedia?: { path: string; kind: "video" | "image" };
  /** Absolute alpha overlay (WebM VP9 alpha / ProRes 4444), e.g. a Lottie rendered by Remotion. */
  overlay?: string;
}

/** Encoder args per output format (fuentes-motion.md §4 recipes). */
export function encoderArgs(format: MotionOutputFormat): string[] {
  switch (format) {
    case "mp4-h264":
      return [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
      ];
    case "webm-vp9-alpha":
      return [
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-b:v",
        "0",
        "-crf",
        "30",
        "-row-mt",
        "1",
      ];
    case "prores-4444":
      return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"];
    case "png-sequence":
      return ["-c:v", "png", "-pix_fmt", "rgba"];
  }
}

const AUDIO_CODEC: Record<MotionOutputFormat, string | null> = {
  "mp4-h264": "aac",
  "webm-vp9-alpha": "libopus",
  "prores-4444": "pcm_s16le",
  "png-sequence": null,
};

function overlayXY(pos: FfmpegTitleProps["overlayPosition"]): [string, string] {
  const m = "40";
  switch (pos) {
    case "center":
      return ["(W-w)/2", "(H-h)/2"];
    case "top-left":
      return [m, m];
    case "top-right":
      return [`W-w-${m}`, m];
    case "bottom-left":
      return [m, `H-h-${m}`];
    case "bottom-right":
      return [`W-w-${m}`, `H-h-${m}`];
  }
}

/** Alpha expression: fade in over `fi`, hold, fade out over the last `fo` seconds. */
export function fadeAlphaExpr(durationSec: number, fi: number, fo: number): string {
  const inPart = fi > 0 ? `t/${num(fi)}` : "1";
  const outPart = fo > 0 ? `(${num(durationSec)}-t)/${num(fo)}` : "1";
  return `max(0,min(1,min(${inPart},${outPart})))`;
}

/**
 * Build the ffmpeg argv (no shell) for the `ffmpeg-title` template:
 * base (color / transparent / media) -> [alpha overlay] -> drawtext title (+ subtitle) with
 * fade + rise -> encoder for spec.format.
 */
export function buildTitleArgs(input: TitleCommandInput): string[] {
  const { spec, props } = input;
  const { width: W, height: H, fps } = spec;
  const D = spec.durationSec;
  const args: string[] = [
    "-hide_banner",
    "-y",
    "-nostats",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
  ];
  const filters: string[] = [];

  // Input 0: base layer.
  if (input.backgroundMedia) {
    if (input.backgroundMedia.kind === "image") args.push("-loop", "1");
    args.push("-i", input.backgroundMedia.path);
    filters.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=rgba,trim=duration=${num(D)},setpts=PTS-STARTPTS[base]`,
    );
  } else {
    const c = props.background === "transparent" ? "black@0.0" : props.background;
    args.push("-f", "lavfi", "-i", `color=c=${c}:s=${W}x${H}:r=${fps}:d=${num(D)},format=rgba`);
    filters.push("[0:v]null[base]");
  }
  let last = "base";

  // Input 1: optional alpha overlay. libvpx decoder BEFORE -i keeps WebM alpha.
  if (input.overlay) {
    if (/\.webm$/i.test(input.overlay)) args.push("-c:v", "libvpx-vp9");
    args.push("-i", input.overlay);
    const [x, y] = overlayXY(props.overlayPosition);
    const s = num(props.overlayStartSec);
    filters.push(`[1:v]format=rgba,setpts=PTS-STARTPTS+${s}/TB[ov]`);
    filters.push(`[${last}][ov]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[withov]`);
    last = "withov";
  }

  // drawtext title (+ subtitle) with fade and rise.
  const hasSub = props.subtitle.trim() !== "" && input.subtitleFile !== undefined;
  const block = props.fontSize + (hasSub ? props.subtitleSize * 1.4 : 0);
  const y0 =
    props.position === "top"
      ? H * 0.1
      : props.position === "bottom"
        ? H * 0.9 - block
        : (H - block) / 2;
  const fi = Math.max(props.fadeInSec, 0);
  const alpha = filterExpr(fadeAlphaExpr(D, fi, props.fadeOutSec));
  const rise = (base: number) =>
    filterExpr(fi > 0 ? `${num(base)}+${num(props.risePx)}*(1-min(t/${num(fi)},1))` : num(base));
  const font = input.fontFile ? `fontfile=${filterPath(input.fontFile)}:` : "";
  const common = `${font}expansion=none:fontcolor=${props.fontColor}:borderw=${props.borderWidth}:bordercolor=${props.borderColor}:x=(w-text_w)/2:alpha=${alpha}`;
  filters.push(
    `[${last}]drawtext=textfile=${filterPath(input.titleFile)}:${common}:fontsize=${props.fontSize}:y=${rise(y0)}[title]`,
  );
  last = "title";
  if (hasSub && input.subtitleFile) {
    filters.push(
      `[${last}]drawtext=textfile=${filterPath(input.subtitleFile)}:${common}:fontsize=${props.subtitleSize}:y=${rise(y0 + props.fontSize * 1.3)}[sub]`,
    );
    last = "sub";
  }
  filters.push(`[${last}]null[vout]`);

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  const audioCodec = AUDIO_CODEC[spec.format];
  if (spec.includeAudio && input.backgroundMedia?.kind === "video" && audioCodec) {
    args.push("-map", "0:a?", "-c:a", audioCodec);
  }
  args.push("-r", String(fps), "-t", num(D), ...encoderArgs(spec.format));
  args.push(
    spec.format === "png-sequence"
      ? `${input.output.replace(/[\\/]+$/, "")}/frame-%05d.png`
      : input.output,
  );
  return args;
}
