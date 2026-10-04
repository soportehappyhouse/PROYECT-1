import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExportPreset, MediaAsset, Project, VoiceEffect } from "@studio/shared";

const execFileAsync = promisify(execFile);

export interface ProgressOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

/**
 * FFmpeg/ffprobe orchestration contract used by job handlers.
 * Implementation rule: spawn the binary directly (no shell, no fluent-ffmpeg — archived) with
 * `-progress pipe:1 -nostats` and parse `out_time_us=` against the known duration for progress.
 */
export interface FfmpegService {
  version(): Promise<string | undefined>;
  probe(absPath: string): Promise<Partial<MediaAsset>>;
  makeProxy(input: string, output: string, opts?: ProgressOptions): Promise<void>;
  applyVoiceEffects(
    input: string,
    output: string,
    effects: VoiceEffect[],
    opts?: ProgressOptions,
  ): Promise<void>;
  exportProject(
    project: Project,
    preset: ExportPreset,
    output: string,
    opts?: ProgressOptions,
  ): Promise<void>;
}

const todo = (what: string) => () =>
  Promise.reject(new Error(`TODO(module-b): ffmpeg ${what} not implemented`));

export function createFfmpegService(ffmpegPath: string, _ffprobePath: string): FfmpegService {
  return {
    async version() {
      try {
        const { stdout } = await execFileAsync(ffmpegPath, ["-version"], { timeout: 5000 });
        return stdout.split("\n")[0]?.trim();
      } catch {
        return undefined;
      }
    },
    // TODO(module-b): ffprobe -v error -print_format json -show_format -show_streams
    probe: todo("probe"),
    // TODO(module-b): 540p/720p H.264 proxy + thumbnail + waveform PNG
    makeProxy: todo("makeProxy"),
    // TODO(module-b): map VoiceEffect[] to an -af filter chain (asetrate/atempo, afftfilt, aecho, highpass/lowpass...)
    applyVoiceEffects: todo("applyVoiceEffects"),
    // TODO(module-b): build filter_complex from tracks/clips (trim, setpts, concat, overlay, xfade, amix)
    exportProject: todo("exportProject"),
  };
}
