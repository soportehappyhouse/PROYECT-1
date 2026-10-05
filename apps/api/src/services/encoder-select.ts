import type { EncoderInfo, VideoEncoderId } from "@studio/shared";
import type { ApiConfig } from "../config.js";
import type { SettingsRepo } from "../repos/settings.js";
import type { FfmpegService } from "./ffmpeg.js";

const KEY = "encoders";

interface StoredEncoders extends EncoderInfo {
  /** Hardware encoders that failed at export time (skipped until re-detection). */
  disabled?: VideoEncoderId[];
}

/** Detect hardware encoders once per FFmpeg version and cache the result in `settings`. */
export async function getEncoderInfo(
  ffmpeg: FfmpegService,
  settings: SettingsRepo,
  force = false,
): Promise<StoredEncoders> {
  const version = await ffmpeg.version();
  const cached = settings.get<StoredEncoders>(KEY);
  if (!force && cached && cached.ffmpegVersion === version) return cached;
  const available = version ? await ffmpeg.detectEncoders(true) : (["libx264"] as VideoEncoderId[]);
  const info: StoredEncoders = {
    available,
    preferred: available[0] ?? "libx264",
    ...(version && { ffmpegVersion: version }),
    detectedAt: new Date().toISOString(),
    disabled: [],
  };
  settings.set(KEY, info);
  return info;
}

/** H.264 encoder to use for exports (respects HW_ENCODER=off and disabled encoders). */
export async function selectEncoder(
  config: Pick<ApiConfig, "hwEncoder">,
  ffmpeg: FfmpegService,
  settings: SettingsRepo,
): Promise<VideoEncoderId> {
  if (config.hwEncoder === "off") return "libx264";
  const info = await getEncoderInfo(ffmpeg, settings);
  return info.available.find((e) => !info.disabled?.includes(e)) ?? "libx264";
}

/** Remember that a hardware encoder failed so later exports skip it. */
export function disableEncoder(settings: SettingsRepo, encoder: VideoEncoderId): void {
  const info = settings.get<StoredEncoders>(KEY);
  if (!info || encoder === "libx264") return;
  const disabled = new Set(info.disabled ?? []);
  disabled.add(encoder);
  settings.set(KEY, { ...info, disabled: [...disabled] });
}
