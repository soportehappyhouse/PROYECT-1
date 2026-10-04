import {
  WORKER_ROUTES,
  WorkerHealthSchema,
  type RvcModel,
  type Transcript,
  type TtsVoice,
  type WorkerHealth,
} from "@studio/shared";

/** HTTP client for apps/workers (FastAPI). All paths are relative to STORAGE_DIR. */
export interface WorkersClient {
  health(): Promise<WorkerHealth | undefined>;
  transcribe(req: {
    inputPath: string;
    language: string;
    model?: string;
    wordTimestamps: boolean;
  }): Promise<Transcript>;
  ttsVoices(): Promise<TtsVoice[]>;
  tts(req: { text: string; voice: string; speed: number; outputPath: string }): Promise<{
    path: string;
    durationSec: number;
  }>;
  rvcModels(): Promise<RvcModel[]>;
  rvcConvert(req: {
    inputPath: string;
    modelId: string;
    pitchShift: number;
    indexRate: number;
    f0Method: string;
    device?: string;
    outputPath: string;
  }): Promise<{ path: string }>;
}

export function createWorkersClient(baseUrl: string): WorkersClient {
  const url = (route: string) => new URL(route, baseUrl).toString();
  const notYet = (what: string) => () =>
    Promise.reject(new Error(`TODO(module-d): workers client ${what} not implemented`));

  return {
    async health() {
      try {
        const res = await fetch(url(WORKER_ROUTES.health), { signal: AbortSignal.timeout(2000) });
        return res.ok ? WorkerHealthSchema.parse(await res.json()) : undefined;
      } catch {
        return undefined;
      }
    },
    // TODO(module-d): POST JSON, parse responses with shared zod schemas, propagate AbortSignal.
    transcribe: notYet("transcribe"),
    ttsVoices: notYet("ttsVoices"),
    tts: notYet("tts"),
    rvcModels: notYet("rvcModels"),
    rvcConvert: notYet("rvcConvert"),
  };
}
