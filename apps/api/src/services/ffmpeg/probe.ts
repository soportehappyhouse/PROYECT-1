import { execFile } from "node:child_process";
import type { MediaKind } from "@studio/shared";

/** Subset of `ffprobe -print_format json -show_format -show_streams` we rely on. */
export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
}

export interface ProbeInfo {
  kind: MediaKind;
  durationSec?: number;
  /** Display size (already swapped for 90/270° rotation). */
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  hasAlpha: boolean;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
  rotation?: number;
  formatName?: string;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "jpegls", "jpeg2000", "qoi"]);
const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|svg_pipe)(,|$)/;
const ALPHA_PIX = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16)/;

/** Parse "30000/1001" or "25" into a number; 0/0 -> undefined. */
export function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const value = d === undefined ? n : d === 0 ? NaN : n / d;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : undefined;
}

function positiveNumber(v: string | number | undefined): number | undefined {
  const n = typeof v === "number" ? v : v === undefined ? NaN : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Turn ffprobe JSON into the metadata stored on MediaAsset. Pure (unit-tested). */
export function parseProbe(data: FfprobeOutput): ProbeInfo {
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatName = data.format?.format_name;

  const durationSec =
    positiveNumber(data.format?.duration) ??
    positiveNumber(video?.duration) ??
    positiveNumber(audio?.duration);

  let rotation: number | undefined;
  const rotSide = video?.side_data_list?.find((d) => typeof d.rotation === "number");
  if (rotSide?.rotation !== undefined) rotation = rotSide.rotation;
  else if (video?.tags?.rotate) rotation = Number(video.tags.rotate);
  const quarterTurn = rotation !== undefined && Math.abs(rotation) % 180 === 90;

  const isImage =
    !!video &&
    !audio &&
    ((formatName !== undefined && IMAGE_FORMATS.test(formatName)) ||
      (IMAGE_CODECS.has(video.codec_name ?? "") && (video.nb_frames ?? "1") === "1"));

  let kind: MediaKind = "video";
  if (!video && audio) kind = "audio";
  else if (isImage) kind = "image";
  else if (!video && !audio)
    kind = formatName?.includes("srt") || formatName?.includes("ass") ? "subtitle" : "video";

  const pixFmt = video?.pix_fmt;
  const hasAlpha =
    (pixFmt !== undefined && ALPHA_PIX.test(pixFmt)) ||
    video?.tags?.alpha_mode === "1" ||
    video?.tags?.ALPHA_MODE === "1";

  const width = video?.width;
  const height = video?.height;
  const fps =
    kind === "video"
      ? (parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate))
      : undefined;

  return {
    kind,
    ...(durationSec !== undefined && kind !== "image" && { durationSec }),
    ...(width &&
      height && { width: quarterTurn ? height : width, height: quarterTurn ? width : height }),
    ...(fps !== undefined && { fps }),
    ...(audio?.sample_rate &&
      positiveNumber(audio.sample_rate) && { sampleRate: Number(audio.sample_rate) }),
    ...(audio?.channels && { channels: audio.channels }),
    hasVideo: !!video,
    hasAudio: !!audio,
    hasAlpha: !!hasAlpha,
    ...(video?.codec_name && { videoCodec: video.codec_name }),
    ...(audio?.codec_name && { audioCodec: audio.codec_name }),
    ...(pixFmt && { pixFmt }),
    ...(rotation !== undefined && { rotation }),
    ...(formatName && { formatName }),
  };
}

/** Run ffprobe and return the raw JSON. */
export function runFfprobe(
  bin: string,
  absPath: string,
  signal?: AbortSignal,
): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absPath],
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
        ...(signal && { signal }),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ffprobe falló: ${String(stderr).trim() || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as FfprobeOutput);
        } catch (e) {
          reject(new Error(`ffprobe devolvió JSON inválido: ${(e as Error).message}`));
        }
      },
    );
  });
}
