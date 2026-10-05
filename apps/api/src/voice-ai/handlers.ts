import { rm } from "node:fs/promises";
import {
  FEATURE_PACKS,
  RvcRequestSchema,
  TranscribeRequestSchema,
  type SuggestedPack,
  TtsRequestSchema,
  type AudioJobResult,
  type RvcRequest,
  type TranscribeJobResult,
  type TranscribeRequest,
  type TtsRequest,
} from "@studio/shared";
import type { AppContext } from "../context.js";
import { viaPacks } from "../jobs/handlers/ai.js";
import type { JobContext, JobHandler } from "../jobs/types.js";
import { resolveStoragePath } from "../services/storage.js";
import type { WorkerCallOptions, WorkersClient } from "../services/workers-client.js";
import { registerAudioAsset, requireMediaAsset } from "./media-bridge.js";
import { extractSpeechWav } from "./proc.js";

/** Dependencies of the workers-backed handlers (subset of AppContext, easy to fake in tests). */
export type VoiceAiDeps = Pick<AppContext, "config" | "repos" | "queue" | "workers">;

/** Map worker progress (0..1) into [from, to] of the job progress bar. */
function progressOpts(ctx: JobContext, from: number, to: number): WorkerCallOptions {
  return {
    signal: ctx.signal,
    onProgress: (p, message) => ctx.reportProgress(from + (to - from) * p, message),
  };
}

/**
 * Decision 6 (soft): CUDA is available but the `whisper-turbo` pack is missing -> suggest it in the
 * transcribe result (the web offers the download). Never throws: unknown state = no suggestion.
 */
export async function suggestTurboPack(workers: WorkersClient): Promise<SuggestedPack | undefined> {
  const safe = <T>(fn: () => Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .catch(() => undefined);
  const [gpu, packs] = await Promise.all([
    safe(() => workers.gpuStatus()),
    safe(() => workers.packs()),
  ]);
  if (!gpu?.cuda) return undefined;
  const pack = packs?.find((p) => p.id === FEATURE_PACKS.transcribeGpu);
  if (!pack || pack.installed) return undefined;
  return { packId: pack.id, name_es: pack.name_es, size_bytes: pack.size_bytes };
}

export function createTranscribeHandler(
  deps: VoiceAiDeps,
): JobHandler<TranscribeRequest, TranscribeJobResult> {
  return {
    type: "subtitles.transcribe",
    parse: (payload) => TranscribeRequestSchema.parse(payload),
    async run(payload, ctx, job) {
      const asset = requireMediaAsset(deps, payload.assetId);
      const storage = deps.config.storageDir;
      const wavRel = `tmp/${job.id}.wav`;
      ctx.reportProgress(0.02, "Extrayendo audio (16 kHz mono)");
      await extractSpeechWav(
        deps.config.ffmpegPath,
        resolveStoragePath(storage, asset.path),
        resolveStoragePath(storage, wavRel),
        ctx.signal,
      );
      try {
        ctx.reportProgress(0.08, "Transcribiendo con Whisper");
        const transcript = await deps.workers.transcribe(
          {
            inputPath: wavRel,
            language: payload.language,
            ...(payload.model && { model: payload.model }),
            wordTimestamps: payload.wordTimestamps,
            ...(payload.vad !== undefined && { vad: payload.vad }),
            jobId: job.id,
            outputBase: `renders/${job.id}`,
          },
          progressOpts(ctx, 0.08, 0.98),
        );
        const suggestedPack = payload.model ? undefined : await suggestTurboPack(deps.workers);
        const files = transcript.files ?? {
          jsonPath: `renders/${job.id}.json`,
          srt: `renders/${job.id}.srt`,
          ass: `renders/${job.id}.ass`,
        };
        return {
          assetId: asset.id,
          path: files.jsonPath,
          srtPath: files.srt,
          assPath: files.ass,
          transcript: {
            language: transcript.language,
            durationSec: transcript.durationSec,
            segments: transcript.segments,
          },
          ...(transcript.warnings?.length && { warnings: transcript.warnings }),
          ...(suggestedPack && { suggestedPack }),
        };
      } finally {
        await rm(resolveStoragePath(storage, wavRel), { force: true });
      }
    },
  };
}

export function createTtsHandler(deps: VoiceAiDeps): JobHandler<TtsRequest, AudioJobResult> {
  return {
    type: "voice.tts",
    parse: (payload) => TtsRequestSchema.parse(payload),
    async run(payload, ctx, job) {
      const outputPath = `renders/${job.id}.${payload.format}`;
      ctx.reportProgress(0.05, "Sintetizando voz");
      const res = await deps.workers.tts(
        {
          text: payload.text,
          voice: payload.voice,
          speed: payload.speed,
          outputPath,
          provider: payload.provider,
          format: payload.format,
          jobId: job.id,
        },
        progressOpts(ctx, 0.05, 0.95),
      );
      const snippet = payload.text.replace(/\s+/g, " ").trim().slice(0, 40);
      const asset = await registerAudioAsset(deps, {
        path: res.path,
        name: `Voz (${payload.voice}): ${snippet}`,
        durationSec: res.durationSec,
        ...(res.sampleRate && res.path.endsWith(".wav") && { sampleRate: res.sampleRate }),
      });
      return { assetId: asset.id, path: res.path, durationSec: res.durationSec };
    },
  };
}

export function createRvcHandler(deps: VoiceAiDeps): JobHandler<RvcRequest, AudioJobResult> {
  return {
    type: "voice.rvc",
    parse: (payload) => RvcRequestSchema.parse(payload),
    async run(payload, ctx, job) {
      const source = requireMediaAsset(deps, payload.assetId);
      const device = payload.device ?? (deps.config.useCuda ? "cuda" : "cpu");
      ctx.reportProgress(
        0.02,
        device === "cpu" ? "Convirtiendo voz en CPU (puede tardar)" : "Convirtiendo voz (CUDA)",
      );
      // 409 PACK_REQUIRED (rvc-base) from the workers -> failed job with the body (dialog).
      const res = await viaPacks(() =>
        deps.workers.rvcConvert(
          {
            inputPath: source.path,
            modelId: payload.modelId,
            pitchShift: payload.pitchShift,
            indexRate: payload.indexRate,
            f0Method: payload.f0Method,
            device,
            outputPath: `renders/${job.id}.wav`,
            jobId: job.id,
          },
          progressOpts(ctx, 0.02, 0.97),
        ),
      );
      const asset = await registerAudioAsset(deps, {
        path: res.path,
        name: `${source.name} (RVC ${payload.modelId})`,
        ...(res.durationSec != null && { durationSec: res.durationSec }),
        ...(res.sampleRate != null && { sampleRate: res.sampleRate }),
      });
      return {
        assetId: asset.id,
        path: res.path,
        ...(res.durationSec != null && { durationSec: res.durationSec }),
        ...(res.warnings?.length && { warnings: res.warnings }),
      };
    },
  };
}

/** Register the module (d) job handlers on the queue. */
export function registerVoiceAiHandlers(deps: VoiceAiDeps): void {
  deps.queue
    .register(createTranscribeHandler(deps) as JobHandler)
    .register(createTtsHandler(deps) as JobHandler)
    .register(createRvcHandler(deps) as JobHandler);
}
