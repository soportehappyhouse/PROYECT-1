import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  duckSidechainGain,
  SOCIAL_LOUDNESS,
  type AspectFit,
  type LoudnessTarget,
  type VoiceEffect,
  type ExportPreset,
  type Project,
  type SpriteSheet,
  type VideoEncoderId,
  type WaveformPeaks,
  type TrackFile,
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
import { presetEncoding } from "./ffmpeg/encoders.js";
import { sec } from "./ffmpeg/escape.js";
import {
  planSegments,
  pruneSegmentCache,
  segmentHash,
  segmentPresetBlocker,
  segmentProgressMessage,
  type SegmentWindow,
} from "./ffmpeg/segments.js";
import {
  compileExport,
  metadataArgs,
  resolveExportProject,
  timelineDuration,
  type AudioMixPlan,
  type CompileExportOptions,
  type TimelineAsset,
} from "./ffmpeg/timeline.js";
import {
  loudnormApplyFilter,
  loudnormMeasureArgs,
  parseLoudnormStats,
  SILENCE_LUFS,
  type LoudnormStats,
} from "./export/loudness.js";

export type { ProbeInfo } from "./ffmpeg/probe.js";
export type { TimelineAsset } from "./ffmpeg/timeline.js";
export { FfmpegError } from "./ffmpeg/runner.js";

const execFileAsync = promisify(execFile);

export interface ProgressOptions {
  signal?: AbortSignal;
  /**
   * 0..1, plus a Spanish status line when the step changes (segment render: "N/M bloques") and,
   * in the block render, the items done/total (blocks + 1 final audio/mux step) for the job ETA.
   */
  onProgress?: (
    progress: number,
    message?: string,
    items?: { done: number; total: number },
  ) => void;
  /** Receives stderr lines / notes for the job log. */
  log?: (line: string) => void;
}

export interface ExportInput {
  project: Project;
  preset: ExportPreset;
  assets: ReadonlyMap<string, TimelineAsset>;
  /** Absolute output path (extension decided by the caller from the preset). */
  output: string;
  /** Absolute scratch dir for graph/text/subtitle files (ffmpeg cwd). */
  workDir: string;
  range?: { start: number; end: number };
  /** Preferred H.264 encoder (falls back to libx264 once on hardware failure). */
  encoder?: VideoEncoderId;
  fontFile?: string;
  /** See ExportRequest.burnSubtitles (absent = auto). */
  burnSubtitles?: boolean;
  /**
   * Segment cache render (absolute cache dir + LRU size limit). Absent = single pass. Unsupported
   * presets / timelines fall back to the single pass (ExportOutcome.fallbackReason).
   */
  segmentCache?: { dir: string; maxBytes: number };
  /** Sprint 2: track files of the clips' trackRef (asset id -> TrackFile). */
  tracks?: ReadonlyMap<string, TrackFile>;
  /**
   * Sprint 4: `-metadata comment=` of the output (AI content detected, decision 9). Written on the
   * single pass and on the final concat of the segment render (never inside the cached blocks, so
   * it does not change their hash).
   */
  metadataComment?: string;
  /** Sprint 5: framing of a canvas of another aspect (see effectiveAspectFit). */
  aspectFit?: AspectFit;
  /** Sprint 5: loudness target of the mix (two-pass loudnorm); null/absent = not normalized. */
  loudness?: LoudnessTarget | null;
  /** Sprint 5: track roles + automatic ducking of the mix. */
  audioMix?: AudioMixPlan;
}

export interface ExportOutcome {
  encoder: VideoEncoderId;
  durationSec: number;
  warnings: string[];
  /** True when a hardware encoder failed and libx264 was used instead. */
  fellBack: boolean;
  mode: "segments" | "single";
  segments?: { total: number; cached: number; rendered: number };
  /** Why a requested segment render used the single pass (Spanish). */
  fallbackReason?: string;
  /** Sprint 5: loudnorm measurement (input) and result (output) of the mix. */
  loudness?: { input_i: number; input_tp: number; output_i: number; output_tp: number };
  /** Sprint 5: tracks in the automatic ducking buses. */
  ducked?: { voiceTracks: number; musicTracks: number };
  /** Sprint 5: warning codes of the job result (LOUDNESS_MEASURE_FAILED). */
  warningCodes?: string[];
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
  /**
   * 360p proxy with `encoder` (hardware H.264 when available); a hardware failure retries once
   * with libx264. Returns the encoder actually used and whether it fell back.
   */
  makeProxy(
    input: string,
    output: string,
    opts?: ProgressOptions & { durationSec?: number; hasAudio?: boolean; encoder?: VideoEncoderId },
  ): Promise<{ encoder: VideoEncoderId; fellBack: boolean }>;
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
    effects: readonly VoiceEffect[],
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
      const attempt = (encoder: VideoEncoderId) =>
        run(
          proxyArgs({
            input,
            output,
            encoder,
            ...(opts?.hasAudio !== undefined && { hasAudio: opts.hasAudio }),
          }),
          runOpts(opts, opts?.durationSec),
        );
      const preferred = opts?.encoder ?? "libx264";
      try {
        await attempt(preferred);
        return { encoder: preferred, fellBack: false };
      } catch (err) {
        const hwFailed =
          preferred !== "libx264" &&
          err instanceof FfmpegError &&
          HW_FAILURE_PATTERN.test(err.stderrTail.join("\n") + err.message);
        if (!hwFailed) throw err;
        opts?.log?.(`Encoder ${preferred} falló en el proxy; reintentando con libx264`);
        await rm(output, { force: true });
        await attempt("libx264");
        return { encoder: "libx264", fellBack: true };
      }
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
    async exportProject(rawInput, opts) {
      // Sprint 2: trackRef -> position keyframes once, for the compiler AND the segment hash.
      const input = rawInput.tracks?.size
        ? {
            ...rawInput,
            project: resolveExportProject(rawInput.project, rawInput.assets, rawInput.tracks),
          }
        : rawInput;
      const version = await service.versionInfo();
      const rubberband = await service.hasFilter("rubberband");
      const base = (encoder: VideoEncoderId): CompileExportOptions => ({
        project: input.project,
        preset: input.preset,
        assets: input.assets,
        output: input.output,
        encoder,
        rubberband,
        ffmpegMajor: version?.major ?? 6,
        ...(input.range && { range: input.range }),
        ...(input.fontFile && { fontFile: input.fontFile }),
        ...(input.burnSubtitles !== undefined && { burnSubtitles: input.burnSubtitles }),
        ...(input.metadataComment && { metadataComment: input.metadataComment }),
        ...(input.aspectFit && { aspectFit: input.aspectFit }),
        ...(input.audioMix && { audioMix: input.audioMix }),
      });
      const writeFiles = async (dir: string, files: { name: string; content: string }[]) => {
        await mkdir(dir, { recursive: true });
        for (const f of files) await writeFile(path.join(dir, f.name), f.content, "utf8");
      };
      const report = (r: number, msg: string, items?: { done: number; total: number }) =>
        opts?.onProgress?.(Math.min(0.999, r), msg, items);

      // Sprint 5: the audio mix is rendered apart (loudnorm two-pass, role ducking) and muxed
      // with the video (-c:v copy). GIF has no audio and alpha keeps its one-pass render.
      const probeEnc = presetEncoding(input.preset, "libx264");
      const separateAudio = probeEnc.extension !== "gif" && !probeEnc.alpha;
      /** Share of the progress bar for the video when the audio is processed apart. */
      const VIDEO = separateAudio ? 0.85 : 1;

      // Segment plan (or the reason to render in one pass).
      let plan: { segments: SegmentWindow[]; start: number; end: number } | undefined;
      let fallbackReason: string | undefined;
      if (input.segmentCache) {
        const total = timelineDuration(input.project);
        const start = Math.max(0, input.range?.start ?? 0);
        const end = Math.min(input.range?.end ?? total, total);
        fallbackReason = segmentPresetBlocker(input.preset);
        if (!fallbackReason && end - start > 1e-3) {
          const p = planSegments(input.project, { fps: input.preset.fps, start, end });
          if ("segments" in p) plan = { segments: p.segments, start, end };
          else fallbackReason = p.fallback;
        }
        if (fallbackReason) opts?.log?.(`Render por bloques desactivado: ${fallbackReason}`);
      }

      interface VideoPass {
        durationSec: number;
        warnings: string[];
        segments?: ExportOutcome["segments"];
        /** Input argv of the rendered video for the final mux (absent = output already complete). */
        videoInput?: string[];
        ducked?: ExportOutcome["ducked"];
        /** Prefix of the audio stage messages (block render: «3/3 bloques (3 en caché)»). */
        label?: string;
      }

      const single = async (encoder: VideoEncoderId): Promise<VideoPass> => {
        if (!separateAudio) {
          const compiled = compileExport(base(encoder));
          await writeFiles(input.workDir, compiled.files);
          for (const w of compiled.warnings) opts?.log?.(`AVISO: ${w}`);
          await run(compiled.args, { ...runOpts(opts, compiled.durationSec), cwd: input.workDir });
          return { durationSec: compiled.durationSec, warnings: compiled.warnings };
        }
        const ext = presetEncoding(input.preset, encoder).extension;
        const videoFile = path.join(input.workDir, `video.${ext}`);
        const compiled = compileExport({ ...base(encoder), output: videoFile, videoOnly: true });
        await writeFiles(input.workDir, compiled.files);
        for (const w of compiled.warnings) opts?.log?.(`AVISO: ${w}`);
        report(0, "Video");
        await run(compiled.args, {
          ...runOpts(opts, compiled.durationSec),
          cwd: input.workDir,
          onProgress: (r: number) => report(r * VIDEO, "Video"),
        });
        return {
          durationSec: compiled.durationSec,
          warnings: compiled.warnings,
          videoInput: ["-i", videoFile],
        };
      };

      const segmented = async (
        encoder: VideoEncoderId,
        p: NonNullable<typeof plan>,
      ): Promise<VideoPass> => {
        const cache = input.segmentCache!;
        await mkdir(cache.dir, { recursive: true });
        const fps = input.preset.fps;
        const gopFrames = Math.max(1, Math.round(fps * 2));
        const stamps = new Map<string, { mtimeMs: number; size: number }>();
        for (const a of input.assets.values()) {
          const st = await stat(a.absPath).catch(() => undefined);
          if (st) stamps.set(a.id, { mtimeMs: Math.round(st.mtimeMs), size: st.size });
        }
        const items = p.segments.map((w) => {
          const hash = segmentHash({
            project: input.project,
            preset: input.preset,
            encoder,
            window: w,
            gopFrames,
            assets: input.assets,
            stamps,
            ...(input.burnSubtitles !== undefined && { burnSubtitles: input.burnSubtitles }),
            ...(input.fontFile && { fontFile: input.fontFile }),
            ...(version?.line && { ffmpegVersion: version.line }),
            ...(input.aspectFit && { aspectFit: input.aspectFit }),
          });
          return { w, hash, file: path.join(cache.dir, `${hash}.mp4`) };
        });
        const exists = await Promise.all(
          items.map((it) =>
            access(it.file).then(
              () => true,
              () => false,
            ),
          ),
        );
        const cached = exists.filter(Boolean).length;
        const M = items.length;
        const totalDur = p.end - p.start;
        const videoMsg = (done: number) => `Video: ${segmentProgressMessage(done, M, cached)}`;
        const warnings = new Set<string>();
        let doneDur = 0;
        let done = 0;
        // Integration (M1 ↔ M3): blocks as items for the ETA; +1 = mix, loudness and mux.
        const itemsOf = (n: number) => ({ done: n, total: M + 1 });
        report(0, videoMsg(0), itemsOf(0));
        for (const [i, it] of items.entries()) {
          const segDur = it.w.end - it.w.start;
          if (exists[i]) {
            const now = new Date();
            await utimes(it.file, now, now).catch(() => undefined); // LRU: mark as used
          } else {
            const dir = path.join(input.workDir, `seg-${i}`);
            const part = path.join(
              cache.dir,
              `${it.hash}.${process.pid}-${randomBytes(4).toString("hex")}.part.mp4`,
            );
            const compiled = compileExport({
              ...base(encoder),
              output: part,
              window: {
                start: it.w.start,
                end: it.w.end,
                timelineEnd: p.end,
                gopFrames,
                frames: it.w.frames,
              },
            });
            await writeFiles(dir, compiled.files);
            for (const w of compiled.warnings) warnings.add(w);
            const msg = videoMsg(done + 1);
            try {
              await run(compiled.args, {
                ...runOpts(opts, segDur),
                cwd: dir,
                onProgress: (r: number) =>
                  report(((doneDur + r * segDur) / totalDur) * VIDEO, msg, itemsOf(done)),
              });
              await rename(part, it.file);
            } catch (err) {
              await rm(part, { force: true });
              throw err;
            }
          }
          done++;
          doneDur += segDur;
          report((doneDur / totalDur) * VIDEO, videoMsg(done), itemsOf(done));
        }
        for (const w of warnings) opts?.log?.(`AVISO: ${w}`);
        opts?.log?.(
          `Render por bloques: ${M} bloques, ${cached} en caché, ${M - cached} renderizados`,
        );
        // Concat demuxer (-c copy), muxed with the audio mix below.
        const list = [
          "ffconcat version 1.0",
          ...items.map((it) => `file '${it.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`),
          "",
        ].join("\n");
        await writeFile(path.join(input.workDir, "segments.ffconcat"), list, "utf8");
        return {
          durationSec: totalDur,
          warnings: [...warnings],
          segments: { total: M, cached, rendered: M - cached },
          videoInput: ["-f", "concat", "-safe", "0", "-i", "segments.ffconcat"],
          label: segmentProgressMessage(M, M, cached),
        };
      };

      /**
       * Sprint 5: level of the voice bus (loudnorm measurement of the voice tracks alone) -> the
       * sidechain gain that makes a quiet recording duck the music as much as a loud one. A failed
       * measurement keeps the default gain (logged, never fails the export).
       */
      const calibrateDuck = async (
        encoder: VideoEncoderId,
        mix: AudioMixPlan,
        msg: (stage: string) => string,
      ): Promise<AudioMixPlan> => {
        const voiceProject = {
          ...input.project,
          tracks: input.project.tracks.filter((t) => mix.roles.get(t.id) === "voice"),
        };
        const dir = path.join(input.workDir, "voice");
        try {
          const voice = compileExport({
            ...base(encoder),
            project: voiceProject,
            output: "voice.wav",
            audioOnly: true,
            audioCodecArgs: ["-c:a", "pcm_f32le", "-ar", "48000"],
          });
          await writeFiles(dir, voice.files);
          report(VIDEO, msg("Midiendo la voz"));
          await run(voice.args, {
            ...(opts?.signal && { signal: opts.signal }),
            durationSec: voice.durationSec,
            cwd: dir,
          });
          const measured = await run(
            loudnormMeasureArgs(path.join(dir, "voice.wav"), SOCIAL_LOUDNESS),
            { ...(opts?.signal && { signal: opts.signal }), logLevel: "info" },
          );
          const lufs = parseLoudnormStats(measured.stderr).input_i;
          const levelSc = duckSidechainGain(lufs);
          opts?.log?.(`Voz a ${lufs} LUFS: ganancia de la cadena lateral ×${levelSc}`);
          return { ...mix, duck: { ...mix.duck!, levelSc } };
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          opts?.log?.(`AVISO: no se pudo medir la voz para el ducking (${String(err)})`);
          return mix;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      };

      /**
       * Sprint 5: audio mix of the whole range -> mix.wav (float PCM 48 kHz: headroom before the
       * normalization), loudnorm pass 1 on it, then pass 2 (linear) encoded straight into the
       * final mux with the rendered video (-c:v copy).
       */
      const audioAndMux = async (
        encoder: VideoEncoderId,
        video: VideoPass,
      ): Promise<Pick<ExportOutcome, "loudness" | "ducked" | "warningCodes">> => {
        const enc = presetEncoding(input.preset, encoder);
        const audioDir = path.join(input.workDir, "audio");
        const msg = (stage: string) => (video.label ? `${video.label} · ${stage}` : stage);
        const mixOf = (audioMix: AudioMixPlan | undefined) =>
          compileExport({
            ...base(encoder),
            ...(audioMix && { audioMix }),
            output: "mix.wav",
            audioOnly: true,
            audioCodecArgs: ["-c:a", "pcm_f32le", "-ar", "48000"],
          });
        let audio = mixOf(input.audioMix);
        // The sidechain is only built with audible voice AND music: calibrate it then.
        if (audio.ducked && input.audioMix?.duck)
          audio = mixOf(await calibrateDuck(encoder, input.audioMix, msg));
        await writeFiles(audioDir, audio.files);
        for (const w of audio.warnings) if (!video.warnings.includes(w)) video.warnings.push(w);
        if (audio.ducked)
          opts?.log?.(
            `Ducking automático: ${audio.ducked.musicTracks} pista(s) de música bajo ${audio.ducked.voiceTracks} de voz`,
          );
        report(VIDEO, msg("Mezclando audio"));
        await run(audio.args, {
          ...runOpts(opts, audio.durationSec),
          cwd: audioDir,
          onProgress: (r: number) => report(VIDEO + r * 0.05, msg("Mezclando audio")),
        });
        const mixFile = path.join(audioDir, "mix.wav");
        const warningCodes: string[] = [];
        let applyFilter: string | undefined;
        let measured: LoudnormStats | undefined;
        const target = input.loudness ?? undefined;
        if (target) {
          report(0.9, msg("Midiendo sonoridad"));
          try {
            const pass1 = await run(loudnormMeasureArgs(mixFile, target), {
              ...(opts?.signal && { signal: opts.signal }),
              durationSec: audio.durationSec,
              logLevel: "info",
              onProgress: (r: number) => report(0.9 + r * 0.04, msg("Midiendo sonoridad")),
            });
            measured = parseLoudnormStats(pass1.stderr);
            opts?.log?.(
              `Sonoridad medida: I=${measured.input_i} LUFS TP=${measured.input_tp} dBTP LRA=${measured.input_lra}`,
            );
            if (measured.input_i <= SILENCE_LUFS) {
              opts?.log?.("Mezcla en silencio: no se normaliza");
              measured = undefined;
            } else applyFilter = loudnormApplyFilter(target, measured);
          } catch (err) {
            if (opts?.signal?.aborted) throw err;
            const cause = err instanceof Error ? err.message : String(err);
            opts?.log?.(`AVISO: LOUDNESS_MEASURE_FAILED: ${cause}`);
            warningCodes.push("LOUDNESS_MEASURE_FAILED");
          }
        }
        const stage = msg(applyFilter ? "Normalizando audio" : "Uniendo");
        report(0.94, stage);
        const mux = await run(
          [
            ...video.videoInput!,
            "-i",
            path.join("audio", "mix.wav"),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            ...(input.preset.videoCodec === "h265" ? ["-tag:v", "hvc1"] : []),
            ...(applyFilter ? ["-af", applyFilter] : []),
            "-ar",
            "48000",
            ...enc.audio,
            ...metadataArgs(input.metadataComment),
            ...enc.container,
            "-t",
            sec(video.durationSec),
            input.output,
          ],
          {
            ...(opts?.signal && { signal: opts.signal }),
            durationSec: video.durationSec,
            cwd: input.workDir,
            ...(applyFilter && { logLevel: "info" as const }),
            onProgress: (r: number) => report(0.94 + r * 0.05, stage),
          },
        );
        let loudness: ExportOutcome["loudness"];
        if (applyFilter && measured) {
          let out: LoudnormStats | undefined;
          try {
            out = parseLoudnormStats(mux.stderr);
          } catch {
            out = undefined;
          }
          loudness = {
            input_i: measured.input_i,
            input_tp: measured.input_tp,
            output_i: out?.output_i ?? target!.integrated,
            output_tp: out?.output_tp ?? Math.min(measured.input_tp, target!.truePeak),
          };
          opts?.log?.(
            `Sonoridad final: I=${loudness.output_i} LUFS TP=${loudness.output_tp} dBTP${
              out?.normalization_type ? ` (${out.normalization_type})` : ""
            }`,
          );
        }
        return {
          ...(loudness && { loudness }),
          ...(audio.ducked && { ducked: audio.ducked }),
          ...(warningCodes.length && { warningCodes }),
        };
      };

      const attempt = (encoder: VideoEncoderId) =>
        plan ? segmented(encoder, plan) : single(encoder);
      const preferred = input.encoder ?? "libx264";
      let encoder = preferred;
      let fellBack = false;
      let video: VideoPass;
      try {
        video = await attempt(preferred);
      } catch (err) {
        const hwFailed =
          preferred !== "libx264" &&
          err instanceof FfmpegError &&
          HW_FAILURE_PATTERN.test(err.stderrTail.join("\n") + err.message);
        if (!hwFailed) throw err;
        opts?.log?.(`Encoder ${preferred} falló; reintentando con libx264`);
        await rm(input.output, { force: true });
        encoder = "libx264";
        fellBack = true;
        video = await attempt("libx264");
      }
      const extra = video.videoInput ? await audioAndMux(encoder, video) : {};
      if (plan && input.segmentCache) {
        const pruned = await pruneSegmentCache(input.segmentCache.dir, input.segmentCache.maxBytes);
        if (pruned) opts?.log?.(`Caché de bloques: ${pruned} bloques viejos borrados (LRU)`);
      }
      return {
        encoder,
        durationSec: video.durationSec,
        warnings: video.warnings,
        fellBack,
        mode: plan ? "segments" : "single",
        ...(video.segments && { segments: video.segments }),
        ...(fallbackReason && { fallbackReason }),
        ...extra,
      };
    },
    detectEncoders(force = false) {
      if (force || !encodersCache) encodersCache = detectHardwareEncoders(ffmpegPath);
      return encodersCache;
    },
  };
  return service;
}
