import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AudioEffect,
  ExportPresetExt,
  Project,
  SpriteSheet,
  VideoEncoderId,
  WaveformPeaks,
} from "@studio/shared";
import {
  buildAudioFxGraph,
  duckingFragment,
  loudnormFilter,
  parseLoudnormJson,
} from "./ffmpeg/audio-fx.js";
import {
  extractAudioArgs,
  pcmArgs,
  planSprite,
  proxyArgs,
  spriteArgs,
  thumbnailArgs,
} from "./ffmpeg/builders.js";
import { detectHardwareEncoders, HW_FAILURE_PATTERN } from "./ffmpeg/encoders.js";
import { bucketsPerSecondFor, PeakAccumulator } from "./ffmpeg/peaks.js";
import { parseProbe, runFfprobe, type ProbeInfo } from "./ffmpeg/probe.js";
import { FfmpegError, runFfmpeg, type RunFfmpegOptions, type RunResult } from "./ffmpeg/runner.js";
import { compileExport, type TimelineAsset } from "./ffmpeg/timeline.js";

export type { ProbeInfo } from "./ffmpeg/probe.js";
export type { TimelineAsset } from "./ffmpeg/timeline.js";
export { FfmpegError } from "./ffmpeg/runner.js";

const execFileAsync = promisify(execFile);

export interface ProgressOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Receives stderr lines / notes for the job log. */
  log?: (line: string) => void;
}

export interface ExportInput {
  project: Project;
  preset: ExportPresetExt;
  assets: ReadonlyMap<string, TimelineAsset>;
  /** Absolute output path (extension decided by the caller from the preset). */
  output: string;
  /** Absolute scratch dir for graph/text/subtitle files (ffmpeg cwd). */
  workDir: string;
  range?: { start: number; end: number };
  /** Preferred H.264 encoder (falls back to libx264 once on hardware failure). */
  encoder?: VideoEncoderId;
  fontFile?: string;
}

export interface ExportOutcome {
  encoder: VideoEncoderId;
  durationSec: number;
  warnings: string[];
  /** True when a hardware encoder failed and libx264 was used instead. */
  fellBack: boolean;
}

export interface VersionInfo {
  line: string;
  major: number;
}

/**
 * FFmpeg/ffprobe orchestration used by job handlers (spawned directly, no shell, no fluent-ffmpeg).
 * Exposed as `app.ctx.ffmpeg` to every module (e.g. module d uses extractAudio for Whisper).
 */
export interface FfmpegService {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  version(): Promise<string | undefined>;
  versionInfo(): Promise<VersionInfo | undefined>;
  /** Whether a filter is compiled in (e.g. "rubberband"). Cached. */
  hasFilter(name: string): Promise<boolean>;
  probe(absPath: string, signal?: AbortSignal): Promise<ProbeInfo & { raw: unknown }>;
  /** Generic runner with -progress parsing and AbortSignal cancel. */
  run(args: readonly string[], opts?: RunFfmpegOptions): Promise<RunResult>;
  thumbnail(input: string, output: string, atSec?: number, opts?: ProgressOptions): Promise<void>;
  /** Sprite sheet; returns its layout (path filled by the caller). */
  sprite(
    input: string,
    output: string,
    durationSec: number,
    opts?: ProgressOptions,
  ): Promise<Omit<SpriteSheet, "path">>;
  makeProxy(
    input: string,
    output: string,
    opts?: ProgressOptions & { durationSec?: number; hasAudio?: boolean },
  ): Promise<void>;
  waveformPeaks(
    input: string,
    durationSec?: number,
    opts?: ProgressOptions,
  ): Promise<WaveformPeaks>;
  extractAudio(
    input: string,
    output: string,
    o?: { sampleRate?: number; channels?: number },
    opts?: ProgressOptions & { durationSec?: number },
  ): Promise<void>;
  /** Voice/audio effects (two-pass loudnorm, ducking with `musicPath`). Output 48 kHz. */
  applyVoiceEffects(
    input: string,
    output: string,
    effects: readonly AudioEffect[],
    opts?: ProgressOptions & {
      durationSec?: number;
      musicPath?: string;
      audioCodecArgs?: string[];
    },
  ): Promise<void>;
  exportProject(input: ExportInput, opts?: ProgressOptions): Promise<ExportOutcome>;
  /** Usable H.264 encoders in preference order (hardware first, libx264 always last). Cached. */
  detectEncoders(force?: boolean): Promise<VideoEncoderId[]>;
}

export function createFfmpegService(ffmpegPath: string, ffprobePath: string): FfmpegService {
  let versionCache: Promise<VersionInfo | undefined> | undefined;
  let filtersCache: Promise<Set<string>> | undefined;
  let encodersCache: Promise<VideoEncoderId[]> | undefined;

  const run = (args: readonly string[], opts: RunFfmpegOptions = {}) =>
    runFfmpeg(ffmpegPath, args, opts);
  const runOpts = (opts: ProgressOptions | undefined, durationSec?: number): RunFfmpegOptions => ({
    ...(opts?.signal && { signal: opts.signal }),
    ...(durationSec !== undefined && { durationSec }),
    ...(opts?.onProgress && { onProgress: (r: number) => opts.onProgress!(r) }),
    ...(opts?.log && { onStderrLine: opts.log }),
  });

  const service: FfmpegService = {
    ffmpegPath,
    ffprobePath,
    async version() {
      return (await service.versionInfo())?.line;
    },
    versionInfo() {
      versionCache ??= execFileAsync(ffmpegPath, ["-version"], { timeout: 5000, windowsHide: true })
        .then(({ stdout }) => {
          const line = stdout.split("\n")[0]?.trim() ?? "";
          const m = /version\s+n?(\d+)/i.exec(line);
          return { line, major: m ? Number(m[1]) : 6 };
        })
        .catch(() => {
          versionCache = undefined;
          return undefined;
        });
      return versionCache;
    },
    async hasFilter(name) {
      filtersCache ??= execFileAsync(ffmpegPath, ["-hide_banner", "-filters"], {
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      })
        .then(({ stdout }) => {
          const set = new Set<string>();
          for (const line of stdout.split("\n")) {
            const m = /^\s*[TSC.]{3}\s+(\S+)/.exec(line);
            if (m) set.add(m[1]!);
          }
          return set;
        })
        .catch(() => new Set<string>());
      return (await filtersCache).has(name);
    },
    async probe(absPath, signal) {
      const raw = await runFfprobe(ffprobePath, absPath, signal);
      return { ...parseProbe(raw), raw };
    },
    run,
    async thumbnail(input, output, atSec, opts) {
      await run(
        thumbnailArgs({ input, output, ...(atSec !== undefined && { atSec }) }),
        runOpts(opts),
      );
    },
    async sprite(input, output, durationSec, opts) {
      const plan = planSprite(durationSec);
      await run(spriteArgs({ input, output, plan }), runOpts(opts, durationSec));
      const probe = await service.probe(output).catch(() => undefined);
      const tileHeight = probe?.height
        ? Math.round(probe.height / plan.rows)
        : Math.round((plan.tileWidth * 9) / 16);
      return {
        columns: plan.columns,
        rows: plan.rows,
        tileWidth: plan.tileWidth,
        tileHeight,
        intervalSec: plan.intervalSec,
        count: plan.count,
      };
    },
    async makeProxy(input, output, opts) {
      await run(
        proxyArgs({
          input,
          output,
          ...(opts?.hasAudio !== undefined && { hasAudio: opts.hasAudio }),
        }),
        runOpts(opts, opts?.durationSec),
      );
    },
    async waveformPeaks(input, durationSec, opts) {
      const sampleRate = 8000;
      const acc = new PeakAccumulator(sampleRate, bucketsPerSecondFor(durationSec));
      let decoded = 0;
      await run(pcmArgs({ input, sampleRate }), {
        ...runOpts(opts),
        onStdout: (chunk) => {
          acc.push(chunk);
          decoded += chunk.length / 2;
          if (durationSec && opts?.onProgress)
            opts.onProgress(Math.min(0.99, decoded / sampleRate / durationSec));
        },
      });
      return acc.result();
    },
    async extractAudio(input, output, o = {}, opts) {
      await run(extractAudioArgs({ input, output, ...o }), runOpts(opts, opts?.durationSec));
    },
    async applyVoiceEffects(input, output, effects, opts) {
      const rubberband = await service.hasFilter("rubberband");
      const fx = buildAudioFxGraph(effects, "0:a", "fxout", {
        mode: "standalone",
        rubberband,
        prefix: "fx",
      });
      for (const w of fx.warnings) opts?.log?.(w);
      const inputs = ["-i", input];
      let graph = fx.graph;
      let last = "fxout";
      if (fx.ducking) {
        if (!opts?.musicPath) throw new Error("Ducking requiere la pista de música");
        inputs.push("-i", opts.musicPath);
        graph += ";" + duckingFragment(fx.ducking, last, "1:a", "ducked", "dk");
        last = "ducked";
      }
      const codec = opts?.audioCodecArgs ?? ["-c:a", "pcm_s16le"];
      const dur = opts?.durationSec;
      if (fx.loudnorm) {
        // Pass 1: measure (JSON on stderr at info level).
        const measureGraph = `${graph};[${last}]${loudnormFilter(fx.loudnorm, "measure")}[ln]`;
        const onProgress = opts?.onProgress;
        const pass1 = await run(
          [...inputs, "-filter_complex", measureGraph, "-map", "[ln]", "-f", "null", "-"],
          {
            ...runOpts(opts, dur),
            logLevel: "info",
            ...(onProgress && { onProgress: (r: number) => onProgress(r * 0.5) }),
          },
        );
        const measured = parseLoudnormJson(pass1.stderr);
        opts?.log?.(
          `loudnorm medido: I=${measured.input_i} TP=${measured.input_tp} LRA=${measured.input_lra}`,
        );
        graph = `${graph};[${last}]${loudnormFilter(fx.loudnorm, { measured })}[ln]`;
        last = "ln";
        await run(
          [
            ...inputs,
            "-filter_complex",
            graph,
            "-map",
            `[${last}]`,
            "-ar",
            "48000",
            ...codec,
            output,
          ],
          {
            ...runOpts(opts, dur),
            ...(onProgress && { onProgress: (r: number) => onProgress(0.5 + r * 0.5) }),
          },
        );
        return;
      }
      await run(
        [
          ...inputs,
          "-filter_complex",
          graph,
          "-map",
          `[${last}]`,
          "-ar",
          "48000",
          ...codec,
          output,
        ],
        runOpts(opts, dur),
      );
    },
    async exportProject(input, opts) {
      const version = await service.versionInfo();
      const rubberband = await service.hasFilter("rubberband");
      const attempt = async (encoder: VideoEncoderId) => {
        const compiled = compileExport({
          project: input.project,
          preset: input.preset,
          assets: input.assets,
          output: input.output,
          encoder,
          rubberband,
          ffmpegMajor: version?.major ?? 6,
          ...(input.range && { range: input.range }),
          ...(input.fontFile && { fontFile: input.fontFile }),
        });
        await mkdir(input.workDir, { recursive: true });
        for (const f of compiled.files)
          await writeFile(path.join(input.workDir, f.name), f.content, "utf8");
        for (const w of compiled.warnings) opts?.log?.(`AVISO: ${w}`);
        await run(compiled.args, { ...runOpts(opts, compiled.durationSec), cwd: input.workDir });
        return compiled;
      };
      const preferred = input.encoder ?? "libx264";
      try {
        const c = await attempt(preferred);
        return {
          encoder: preferred,
          durationSec: c.durationSec,
          warnings: c.warnings,
          fellBack: false,
        };
      } catch (err) {
        const hwFailed =
          preferred !== "libx264" &&
          err instanceof FfmpegError &&
          HW_FAILURE_PATTERN.test(err.stderrTail.join("\n") + err.message);
        if (!hwFailed) throw err;
        opts?.log?.(`Encoder ${preferred} falló; reintentando con libx264`);
        await rm(input.output, { force: true });
        const c = await attempt("libx264");
        return {
          encoder: "libx264",
          durationSec: c.durationSec,
          warnings: c.warnings,
          fellBack: true,
        };
      }
    },
    detectEncoders(force = false) {
      if (force || !encodersCache) encodersCache = detectHardwareEncoders(ffmpegPath);
      return encodersCache;
    },
  };
  return service;
}
