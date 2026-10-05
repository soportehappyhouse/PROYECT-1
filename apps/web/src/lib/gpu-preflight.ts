import { willRunOnCpu, type GpuFeature, type SuggestedPack } from "@studio/shared";
import { toast } from "sonner";
import { aiApi } from "./api";

/** Toast shown BEFORE a GPU feature starts when it will run on the CPU (decision 7). */
export const CPU_PREFLIGHT_MESSAGE = "Va a correr en CPU (más lento)";

const FEATURE_TEXT: Record<GpuFeature, string> = {
  transcribe: "Transcribir",
  rvc: "Conversión RVC",
  denoise: "Limpiar voz",
  matting: "Quitar fondo",
  sam2: "Máscara / seguir objeto (SAM 2)",
  birefnet: "Quitar fondo de la imagen (BiRefNet)",
};

/**
 * Ask GET /api/ai/gpu before launching `feature`; when it will run on the CPU (CPU mode or less free
 * VRAM than FEATURE_VRAM_MB) show a warning toast. Never blocks for long nor fails the action: no
 * answer within `timeoutMs` (or an error) = no warning. Resolves true when it warned.
 */
export async function warnIfCpu(feature: GpuFeature, timeoutMs = 1500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    aiApi.gpu().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!willRunOnCpu(status, feature)) return false;
  toast.warning(CPU_PREFLIGHT_MESSAGE, {
    description: `${FEATURE_TEXT[feature]}: ${
      status?.mode === "cpu"
        ? "no hay GPU disponible para la IA."
        : feature === "birefnet" && status?.onnx_provider === "cpu"
          ? "onnxruntime es la versión CPU (volvé a descargar «Quitar fondo de imágenes» para usar la GPU)."
          : "la GPU no tiene memoria libre suficiente."
    }`,
  });
  return true;
}

/** `result.suggestedPack` of a job (soft suggestion, e.g. whisper-turbo with CUDA). */
export function suggestedPackOf(result: unknown): SuggestedPack | undefined {
  const p = (result as { suggestedPack?: Partial<SuggestedPack> } | null | undefined)
    ?.suggestedPack;
  if (!p || typeof p.packId !== "string") return undefined;
  return { packId: p.packId, name_es: p.name_es ?? p.packId, size_bytes: p.size_bytes ?? 0 };
}

/** "Descargar whisper-turbo (1.6 GB)". */
export function suggestedPackLabel(p: SuggestedPack): string {
  return p.size_bytes > 0
    ? `Descargar ${p.packId} (${(p.size_bytes / 1e9).toFixed(1)} GB)`
    : `Descargar ${p.packId}`;
}
