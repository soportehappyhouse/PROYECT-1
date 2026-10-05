import type { TtsVoiceInfo } from "@studio/shared";

/**
 * Spanish Piper voices offered for download (mirror of apps/workers/.../tts/piper_catalog.py).
 * The workers list them too; this fallback keeps them visible with older workers.
 */
export const PIPER_SPANISH_CATALOG: readonly Pick<
  TtsVoiceInfo,
  "id" | "name" | "language" | "quality"
>[] = [
  {
    id: "es_AR-daniela-high",
    name: "Daniela (Argentina, rioplatense)",
    language: "es-AR",
    quality: "high",
  },
  { id: "es_MX-claude-high", name: "Claude (Mexico)", language: "es-MX", quality: "high" },
  { id: "es_MX-ald-medium", name: "Ald (Mexico)", language: "es-MX", quality: "medium" },
  { id: "es_ES-davefx-medium", name: "Davefx (Espana)", language: "es-ES", quality: "medium" },
  {
    id: "es_ES-sharvard-medium",
    name: "Sharvard (Espana, multi-voz)",
    language: "es-ES",
    quality: "medium",
  },
  {
    id: "es_ES-mls_10246-low",
    name: "MLS 10246 (Espana, baja)",
    language: "es-ES",
    quality: "low",
  },
  { id: "es_ES-mls_9972-low", name: "MLS 9972 (Espana, baja)", language: "es-ES", quality: "low" },
  {
    id: "es_ES-carlfm-x_low",
    name: "Carlfm (Espana, muy baja)",
    language: "es-ES",
    quality: "x_low",
  },
];

/** Piper voices from the api plus catalog voices it did not list (as not installed). */
export function withPiperCatalog(voices: readonly TtsVoiceInfo[]): TtsVoiceInfo[] {
  const known = new Set(voices.filter((v) => v.provider === "piper").map((v) => v.id));
  return [
    ...voices,
    ...PIPER_SPANISH_CATALOG.filter((v) => !known.has(v.id)).map((v): TtsVoiceInfo => ({
      ...v,
      provider: "piper",
      installed: false,
    })),
  ];
}

/** "63 MB" */
export function formatMb(bytes: number | null | undefined): string {
  return bytes ? `${Math.max(1, Math.round(bytes / 1_000_000))} MB` : "";
}
