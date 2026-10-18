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
  { id: "es_MX-claude-high", name: "Claude (México)", language: "es-MX", quality: "high" },
  { id: "es_MX-ald-medium", name: "Ald (México)", language: "es-MX", quality: "medium" },
  { id: "es_ES-davefx-medium", name: "Davefx (España)", language: "es-ES", quality: "medium" },
  {
    id: "es_ES-sharvard-medium",
    name: "Sharvard (España, multi-voz)",
    language: "es-ES",
    quality: "medium",
  },
  {
    id: "es_ES-mls_10246-low",
    name: "MLS 10246 (España, baja)",
    language: "es-ES",
    quality: "low",
  },
  { id: "es_ES-mls_9972-low", name: "MLS 9972 (España, baja)", language: "es-ES", quality: "low" },
  {
    id: "es_ES-carlfm-x_low",
    name: "Carlfm (España, muy baja)",
    language: "es-ES",
    quality: "x_low",
  },
];

/**
 * Sprint 6 M2 (H19): voice names as shown in the UI — accents restored («Espana» → «España»,
 * «Mexico» → «México») whatever the workers' catalog sends.
 */
export function voiceDisplayName(name: string): string {
  return name.replace(/\bEspana\b/g, "España").replace(/\bMexico\b/g, "México");
}

/** Piper voices from the api plus catalog voices it did not list (as not installed). */
export function withPiperCatalog(voices: readonly TtsVoiceInfo[]): TtsVoiceInfo[] {
  const known = new Set(voices.filter((v) => v.provider === "piper").map((v) => v.id));
  return [
    ...voices.map((v) => ({ ...v, name: voiceDisplayName(v.name) })),
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
