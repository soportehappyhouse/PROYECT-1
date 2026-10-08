import { API_DOWN_ES, WORKERS_DOWN_ES, type GpuFeature } from "@studio/shared";
import { useEffect } from "react";
import { useAgentStore } from "@/stores/agent-store";
import { startServiceStatus, useServiceStatusStore } from "@/stores/service-status-store";

/** What an AI action depends on: the workers, a GPU feature (pack + workers) or Ollama. */
export type AiAvailabilityFeature = "workers" | GpuFeature | "ollama";

export interface AiAvailability {
  enabled: boolean;
  /** Why it is disabled (Spanish, shown as the button tooltip). */
  reason_es?: string;
}

export const OLLAMA_DOWN_ES =
  "Ollama no está en marcha: abrilo desde el menú Inicio (o instalalo en Ajustes → Asistente local).";
export const OLLAMA_MODEL_MISSING_ES =
  "Falta el modelo del asistente: descargalo en Ajustes → Asistente local.";

/** Pure rule behind useAiAvailability (tests). */
export function aiAvailability(
  feature: AiAvailabilityFeature,
  s: {
    api: "up" | "down";
    workers: "up" | "down" | "unknown";
    ollama?: boolean | undefined;
    ollamaReady?: boolean | undefined;
  },
): AiAvailability {
  if (s.api === "down") return { enabled: false, reason_es: API_DOWN_ES };
  if (s.workers === "down") return { enabled: false, reason_es: WORKERS_DOWN_ES };
  if (feature === "ollama") {
    if (s.ollama === false) return { enabled: false, reason_es: OLLAMA_DOWN_ES };
    if (s.ollamaReady === false) return { enabled: false, reason_es: OLLAMA_MODEL_MISSING_ES };
  }
  // A missing pack does not disable the button: the action opens «Paquete requerido».
  return { enabled: true };
}

/**
 * Sprint 5 (M1): whether an AI button can be used, from the service-status-store (api/workers
 * up/down) and the Ollama state of the assistant. Disabled buttons show `reason_es` as tooltip.
 */
export function useAiAvailability(feature: AiAvailabilityFeature): AiAvailability {
  const api = useServiceStatusStore((s) => s.api);
  const workers = useServiceStatusStore((s) => s.workers);
  const ollama = useAgentStore((s) => (feature === "ollama" ? s.status?.ollama : undefined));
  const ollamaReady = useAgentStore((s) => (feature === "ollama" ? s.status?.ready : undefined));
  useEffect(() => startServiceStatus(), []);
  return aiAvailability(feature, { api, workers, ollama, ollamaReady });
}
