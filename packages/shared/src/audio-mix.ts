import type { MediaAsset } from "./media.js";
import {
  DEFAULT_EXPORT_PRESETS,
  EXTRA_EXPORT_PRESETS,
  type ExportPreset,
  type LoudnessTarget,
} from "./export.js";
import { AUTO_DUCK, type Track, type TrackRole } from "./timeline.js";

/**
 * Sprint 5 (M3): roles of the audio mix (automatic ducking at export) and loudness targets.
 */

type RoleAsset = Pick<MediaAsset, "kind"> & Partial<Pick<MediaAsset, "aiProvenance">>;

/** Asset that is a voice: «Voz propia» sample or AI voice (TTS / clone). */
function isVoiceAsset(a: RoleAsset | undefined): boolean {
  if (!a) return false;
  if (a.kind === "voice-ref") return true;
  const k = a.aiProvenance?.kind;
  return k === "voice-synthetic" || k === "voice-cloned";
}

/**
 * Role of a track in the mix. Explicit `role` wins; otherwise a video track is `voice` (people
 * talking), an audio track whose clips are all voices (TTS, cloned voice, «Voz propia») is
 * `voice`, and anything else is `other`: a doubtful track is never ducked.
 */
export function inferTrackRole(
  track: Pick<Track, "kind" | "clips"> & { role?: TrackRole | undefined },
  assetOf: (id: string) => RoleAsset | undefined,
): TrackRole {
  if (track.role) return track.role;
  if (track.kind === "video") return "voice";
  if (track.kind !== "audio") return "other";
  const ids = track.clips.map((c) => c.assetId).filter((id): id is string => !!id);
  if (ids.length > 0 && ids.every((id) => isVoiceAsset(assetOf(id)))) return "voice";
  return "other";
}

/** Role of a library sound (Biblioteca / op add_audio): music and ambience duck, the rest is sfx. */
export function libraryRole(kind: string | undefined): TrackRole {
  return kind === "music" || kind === "ambience" ? "music" : "sfx";
}

/** Spanish labels of the roles (Exportar → Sonido). */
export const TRACK_ROLE_LABELS_ES: Record<TrackRole, string> = {
  voice: "Voz",
  music: "Música",
  sfx: "Efectos",
  other: "Otro",
};

const BUILT_IN_PRESETS: readonly ExportPreset[] = [
  ...DEFAULT_EXPORT_PRESETS,
  ...EXTRA_EXPORT_PRESETS,
];

/**
 * Loudness target of a preset, or null (do not normalize). Presets stored before Sprint 5 (the
 * database seeds built-ins with INSERT OR IGNORE) lack the field: built-ins fall back to the
 * catalogue, custom presets without it are not normalized.
 */
export function loudnessFor(
  preset: Pick<ExportPreset, "id"> & { loudness?: LoudnessTarget | null | undefined },
): LoudnessTarget | null {
  if (preset.loudness !== undefined) return preset.loudness;
  return BUILT_IN_PRESETS.find((p) => p.id === preset.id)?.loudness ?? null;
}

/** Sidechain gain of the automatic ducking (+6 dB: typical voice ≈ −18 dBFS RMS sits 14 dB over). */
export const AUTO_DUCK_SIDECHAIN_GAIN = 2;
/** Reference voice level of the ducking calibration (LUFS ≈ RMS dBFS for speech). */
export const AUTO_DUCK_VOICE_REF_LUFS = -18;
/** Level of a typical voice over the threshold, with the sidechain gain (dB). */
const VOICE_OVER_THRESHOLD_DB =
  AUTO_DUCK_VOICE_REF_LUFS +
  20 * Math.log10(AUTO_DUCK_SIDECHAIN_GAIN) -
  20 * Math.log10(AUTO_DUCK.threshold);

/**
 * Sidechain gain (sidechaincompress `level_sc`, 1/64..64) that brings a voice bus measured at
 * `voiceLufs` to the reference level, so a quiet phone recording ducks the music as much as a
 * studio voice. Unknown level (measurement failed / silence) = AUTO_DUCK_SIDECHAIN_GAIN.
 */
export function duckSidechainGain(voiceLufs: number | undefined): number {
  if (voiceLufs === undefined || !Number.isFinite(voiceLufs) || voiceLufs <= -70)
    return AUTO_DUCK_SIDECHAIN_GAIN;
  const g = AUTO_DUCK_SIDECHAIN_GAIN * 10 ** ((AUTO_DUCK_VOICE_REF_LUFS - voiceLufs) / 20);
  return Math.round(Math.min(64, Math.max(1 / 64, g)) * 1000) / 1000;
}

/**
 * sidechaincompress ratio giving ≈ `duckDb` of gain reduction on the music under a typical voice
 * (reduction = over × (1 − 1/ratio)); clamped to the filter range 1..20. −12 dB -> ≈ 7.
 */
export function duckRatioFor(duckDb: number): number {
  const d = Math.min(Math.abs(duckDb), VOICE_OVER_THRESHOLD_DB - 0.01);
  if (d <= 0) return 1;
  const r = 1 / (1 - d / VOICE_OVER_THRESHOLD_DB);
  return Math.round(Math.min(20, Math.max(1, r)) * 100) / 100;
}

/** Tolerances of «Revisión para redes» → Sonoridad (± 1 LU; +0.2 dB of measurement on TP). */
export const LOUDNESS_TOLERANCE_LU = 1;
export const TRUE_PEAK_TOLERANCE_DB = 0.2;

/** True when a measured export meets the target (integrated ± 1 LU and true peak under the max). */
export function loudnessOk(
  measured: { integrated: number; truePeak: number },
  target: LoudnessTarget,
): boolean {
  return (
    Math.abs(measured.integrated - target.integrated) <= LOUDNESS_TOLERANCE_LU &&
    measured.truePeak <= target.truePeak + TRUE_PEAK_TOLERANCE_DB
  );
}

/** «−14,0 LUFS» (Spanish decimal comma, real minus sign). */
export function formatLufsEs(v: number): string {
  return `${v.toFixed(1).replace(".", ",").replace("-", "−")} LUFS`;
}
