import { spawn } from "node:child_process";
import type { ExportPresetExt, VideoEncoderId } from "@studio/shared";

/** Hardware H.264 encoders probed in preference order (fuentes-editor §4.12). */
export const HW_ENCODERS: readonly VideoEncoderId[] = ["h264_nvenc", "h264_qsv", "h264_amf"];

/** stderr patterns meaning "hardware encoder unusable": retry once with libx264. */
export const HW_FAILURE_PATTERN = /Cannot load|MFX|No device|OpenEncodeSession|AMF|nvenc|qsv/i;

/** Args of the real-encode smoke test for one encoder (exit code 0 = usable). */
export function encoderProbeArgs(encoder: VideoEncoderId): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=256x256:d=0.2",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ];
}

function exitCode(bin: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    try {
      const child = spawn(bin, args, { stdio: "ignore", windowsHide: true });
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        done(-1);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(t);
        done(-1);
      });
      child.on("close", (code) => {
        clearTimeout(t);
        done(code ?? -1);
      });
    } catch {
      done(-1);
    }
  });
}

/** Probe nvenc/qsv/amf with a tiny real encode; libx264 is always appended as fallback. */
export async function detectHardwareEncoders(
  bin: string,
  timeoutMs = 15_000,
): Promise<VideoEncoderId[]> {
  const available: VideoEncoderId[] = [];
  for (const enc of HW_ENCODERS) {
    if ((await exitCode(bin, encoderProbeArgs(enc), timeoutMs)) === 0) available.push(enc);
  }
  available.push("libx264");
  return available;
}

/** H.264 encoder args for a quality level (CRF-like, 0..51). */
export function h264EncoderArgs(
  encoder: VideoEncoderId,
  opts: { crf?: number; bitrateKbps?: number; preset?: "veryfast" | "medium" | "slow" } = {},
): string[] {
  const q = opts.crf ?? 20;
  const rate = opts.bitrateKbps;
  switch (encoder) {
    case "h264_nvenc":
      return rate
        ? [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-b:v",
            `${rate}k`,
            "-maxrate",
            `${rate}k`,
            "-bufsize",
            `${rate * 2}k`,
          ]
        : [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            String(q + 1),
            "-b:v",
            "0",
            "-spatial-aq",
            "1",
          ];
    case "h264_qsv":
      return rate
        ? ["-c:v", "h264_qsv", "-b:v", `${rate}k`, "-maxrate", `${rate}k`, "-preset", "slow"]
        : [
            "-c:v",
            "h264_qsv",
            "-global_quality",
            String(q + 1),
            "-preset",
            "slow",
            "-look_ahead",
            "1",
          ];
    case "h264_amf":
      return rate
        ? [
            "-c:v",
            "h264_amf",
            "-quality",
            "quality",
            "-rc",
            "vbr_peak",
            "-b:v",
            `${rate}k`,
            "-maxrate",
            `${rate}k`,
          ]
        : [
            "-c:v",
            "h264_amf",
            "-quality",
            "quality",
            "-rc",
            "cqp",
            "-qp_i",
            String(q + 1),
            "-qp_p",
            String(q + 3),
            "-qp_b",
            String(q + 5),
          ];
    case "libx264":
      return rate
        ? [
            "-c:v",
            "libx264",
            "-preset",
            opts.preset ?? "medium",
            "-b:v",
            `${rate}k`,
            "-maxrate",
            `${rate}k`,
            "-bufsize",
            `${rate * 2}k`,
            "-profile:v",
            "high",
          ]
        : [
            "-c:v",
            "libx264",
            "-preset",
            opts.preset ?? "medium",
            "-crf",
            String(q),
            "-profile:v",
            "high",
          ];
  }
}

export interface OutputEncoding {
  /** Video codec + rate control + pix_fmt. Empty for GIF (palette handled in the graph). */
  video: string[];
  /** Audio codec args, or ["-an"]. */
  audio: string[];
  /** Container flags (e.g. -movflags +faststart, -loop 0). */
  container: string[];
  /** File extension without dot. */
  extension: string;
  /** Final pix_fmt applied in the graph (yuv420p / yuva420p / ...). */
  pixFmt?: string;
  /** Whether the output keeps an alpha channel. */
  alpha: boolean;
}

/** Map an ExportPreset(Ext) to encoder/container args (fuentes-editor §4.11). */
export function presetEncoding(
  preset: ExportPresetExt,
  h264: VideoEncoderId = "libx264",
): OutputEncoding {
  const gif = preset.container === "gif" || preset.videoCodec === "gif";
  if (gif)
    return { video: [], audio: ["-an"], container: ["-loop", "0"], extension: "gif", alpha: false };

  const container = preset.container;
  const alpha = preset.alpha && (preset.videoCodec === "vp9" || preset.videoCodec === "prores");
  const crf = preset.crf;
  const rate = preset.videoBitrateKbps;
  let video: string[];
  let pixFmt: string;
  switch (preset.videoCodec) {
    case "h264":
      pixFmt = "yuv420p";
      video = [
        ...h264EncoderArgs(h264, {
          ...(crf !== undefined && { crf }),
          ...(rate && { bitrateKbps: rate }),
        }),
        "-pix_fmt",
        pixFmt,
      ];
      break;
    case "h265":
      pixFmt = "yuv420p";
      video = rate
        ? [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-b:v",
            `${rate}k`,
            "-tag:v",
            "hvc1",
            "-pix_fmt",
            pixFmt,
          ]
        : [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-crf",
            String(crf ?? 23),
            "-tag:v",
            "hvc1",
            "-pix_fmt",
            pixFmt,
          ];
      break;
    case "vp9":
      pixFmt = alpha ? "yuva420p" : "yuv420p";
      video = [
        "-c:v",
        "libvpx-vp9",
        ...(rate ? ["-b:v", `${rate}k`] : ["-b:v", "0", "-crf", String(crf ?? 30)]),
        "-row-mt",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        ...(alpha ? ["-auto-alt-ref", "0"] : []),
        "-pix_fmt",
        pixFmt,
      ];
      break;
    case "prores":
      pixFmt = alpha ? "yuva444p10le" : "yuv422p10le";
      video = [
        "-c:v",
        "prores_ks",
        "-profile:v",
        alpha ? "4" : "3",
        "-vendor",
        "apl0",
        "-pix_fmt",
        pixFmt,
      ];
      break;
    default:
      throw new Error(`Unsupported video codec ${preset.videoCodec}`);
  }

  const abr = `${preset.audioBitrateKbps}k`;
  let audio: string[];
  const codec = container === "webm" && preset.audioCodec !== "opus" ? "opus" : preset.audioCodec;
  if (codec === "opus") audio = ["-c:a", "libopus", "-b:a", abr, "-ar", "48000"];
  else if (codec === "pcm") audio = ["-c:a", "pcm_s16le", "-ar", "48000"];
  else audio = ["-c:a", "aac", "-b:a", abr, "-ar", "48000"];

  return {
    video,
    audio,
    container: container === "mp4" || container === "mov" ? ["-movflags", "+faststart"] : [],
    extension: container,
    pixFmt,
    alpha,
  };
}
