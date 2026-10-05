import {
  API_ROUTES,
  type JobType,
  type Pack,
  type PublishSettings,
  type Scene,
  type SilenceOptions,
} from "@studio/shared";

/**
 * Sprint 1 (docs/trabajo/sprint1-contratos.md) contract as the web uses it. The types live in
 * @studio/shared (packages/shared/src/ai.ts); this module only adds web aliases and helpers.
 */
export type {
  CutRange,
  GpuStatus,
  PackFile,
  PerfResult,
  PublishFlags,
  PublishSettings,
  SilenceCut,
  SilenceOptions,
} from "@studio/shared";
export { DEFAULT_AI_LABEL_TEXT, PublishSettingsSchema } from "@studio/shared";

/** GET /api/ai/packs item. */
export type PackInfo = Pack;
/** analyze.scenes item, in source seconds of the asset. */
export type SceneRange = Scene;

export const AI_ROUTES = {
  gpu: API_ROUTES.aiGpu,
  gpuRelease: API_ROUTES.aiGpuRelease,
  packs: API_ROUTES.aiPacks,
  packDownload: API_ROUTES.aiPackDownload,
  analyzeScenes: API_ROUTES.aiAnalyzeScenes,
  analyzeSilences: API_ROUTES.aiAnalyzeSilences,
  applyCuts: API_ROUTES.aiApplyCuts,
  denoise: API_ROUTES.aiDenoise,
  perfRun: API_ROUTES.aiPerfRun,
  perf: API_ROUTES.aiPerf,
} as const;

/** The Sprint 1 job types. */
export type AiJobType = Extract<
  JobType,
  | "packs.download"
  | "analyze.scenes"
  | "analyze.silences"
  | "timeline.apply-cuts"
  | "audio.denoise"
  | "perf.run"
>;

/** Every job type the dashboard tracks. */
export type AnyJobType = JobType;

export type PackState = "installed" | "partial" | "missing";

export function packState(p: Pick<Pack, "installed" | "partial">): PackState {
  return p.installed ? "installed" : p.partial ? "partial" : "missing";
}

/** What the «Paquete requerido» dialog needs from a PACK_REQUIRED body. */
export interface PackRequiredInfo {
  packId: string;
  name_es?: string;
  size_bytes?: number;
  /** Spanish explanation from the api (e.g. how to install Ollama for agent-llm). */
  message?: string;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  minSilenceMs: 500,
  noiseDb: -35,
  paddingMs: 120,
  fillers: true,
};

export const DEFAULT_PUBLISH: PublishSettings = {
  forSocial: false,
  flags: { aiFace: false, aiVoice: false, aiOther: false, music: false, thirdParty: false },
  aiLabel: false,
};
