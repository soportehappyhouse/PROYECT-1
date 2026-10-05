import type { GpuStatus, PerfResult } from "./ai-types";

/** Feature ids of `required_by` (packs.json) in Spanish. */
export const FEATURE_LABELS: Record<string, string> = {
  transcribir: "Transcribir",
  transcribe: "Transcribir",
  tts: "Texto a voz",
  rvc: "Conversión RVC",
  escenas: "Detectar escenas",
  scenes: "Detectar escenas",
  denoise: "Limpiar voz",
  silencios: "Quitar silencios",
  silences: "Quitar silencios",
};

export function featureLabel(id: string): string {
  return FEATURE_LABELS[id] ?? id;
}

/** 1.25 -> "1,3" (Spanish decimal comma). */
export function formatDecimal(value: number, digits = 1): string {
  return value.toFixed(digits).replace(".", ",");
}

/** Seconds -> "0,8 s" / "45 s" / "2 min 5 s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 10) return `${formatDecimal(seconds)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** MB -> "3,2 GB" (or "850 MB"). */
export function formatVram(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  return mb >= 1024 ? `${formatDecimal(mb / 1024)} GB` : `${Math.round(mb)} MB`;
}

/** Short header label: "GPU · 3,2 GB libres" / "CPU". */
export function gpuBadgeText(s: GpuStatus): string {
  if (s.mode !== "gpu") return "CPU";
  return s.vram_free_mb != null ? `GPU · ${formatVram(s.vram_free_mb)} libres` : "GPU";
}

/** Multi-line tooltip of the GPU indicator. */
export function gpuTooltip(s: GpuStatus): string {
  const lines = [
    s.mode === "gpu"
      ? `IA en GPU${s.gpu_name ? `: ${s.gpu_name}` : ""}`
      : s.cuda
        ? "IA en CPU (la GPU no tiene memoria libre suficiente)"
        : "IA en CPU (no se detectó CUDA)",
  ];
  if (s.vram_total_mb != null)
    lines.push(`VRAM libre: ${formatVram(s.vram_free_mb)} de ${formatVram(s.vram_total_mb)}`);
  lines.push(`Modelo cargado: ${s.resident_model ?? "ninguno"}`);
  if (s.warnings?.includes("gpu_fallback_cpu"))
    lines.push("Aviso: la última tarea pasó a CPU por falta de VRAM.");
  if (s.sysmem_fallback)
    lines.push("Aviso: el driver usa memoria del sistema como VRAM (mucho más lento).");
  lines.push("Clic: liberar la GPU");
  return lines.join("\n");
}

export interface PerfEstimate {
  label: string;
  seconds: number;
}

/** Times derived from the measured speeds ("transcribir 10 min ≈ X s"). */
export function perfEstimates(r: PerfResult): PerfEstimate[] {
  const out: PerfEstimate[] = [];
  if (r.whisper_turbo_s_per_min != null)
    out.push({ label: "Transcribir 10 min de audio", seconds: r.whisper_turbo_s_per_min * 10 });
  if (r.piper_s_per_100chars != null)
    out.push({
      label: "Locución de 1000 caracteres (Piper)",
      seconds: r.piper_s_per_100chars * 10,
    });
  if (r.rvc_s_per_min != null)
    out.push({ label: "Convertir 1 min de voz con RVC", seconds: r.rvc_s_per_min });
  if (r.scenes_fps != null && r.scenes_fps > 0)
    out.push({
      label: "Detectar escenas en 10 min a 30 fps",
      seconds: (10 * 60 * 30) / r.scenes_fps,
    });
  return out;
}
