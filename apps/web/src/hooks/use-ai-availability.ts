import type { GpuFeature } from "@studio/shared";

/** What an AI action depends on: the workers, a GPU feature (pack + workers) or Ollama. */
export type AiAvailabilityFeature = "workers" | GpuFeature | "ollama";

export interface AiAvailability {
  enabled: boolean;
  /** Why it is disabled (Spanish, shown as the button tooltip). */
  reason_es?: string;
}

/**
 * Sprint 5 (M1): whether an AI button can be used, from the service-status-store (workers up/down)
 * and Ollama/pack state. Paso 0 stub: always enabled. M1 implements it without changing the
 * signature.
 */
export function useAiAvailability(_feature: AiAvailabilityFeature): AiAvailability {
  return { enabled: true };
}
