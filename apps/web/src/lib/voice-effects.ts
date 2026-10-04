import {
  AudioEffectSchema,
  VOICE_EFFECT_PRESETS,
  VoiceEffectSchema,
  type AudioEffect,
  type AudioEffectType,
  type VoiceEffect,
} from "@studio/shared";

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** Effects editable in the chain editor (ducking needs a second asset: not exposed here). */
export type EditableEffectType = Exclude<AudioEffectType, "ducking">;
export type EditableEffect = Exclude<AudioEffect, { type: "ducking" }>;

/** Editable numeric parameters of each effect (ranges mirror the shared zod schemas). */
export const EFFECT_DEFS: Record<EditableEffectType, { label: string; params: EffectParamDef[] }> =
  {
    pitch: {
      label: "Tono",
      params: [{ key: "semitones", label: "Semitonos", min: -24, max: 24, step: 1, default: 0 }],
    },
    robot: {
      label: "Robot",
      params: [{ key: "intensity", label: "Intensidad", min: 0, max: 1, step: 0.05, default: 0.7 }],
    },
    reverb: {
      label: "Reverberación",
      params: [
        { key: "roomSize", label: "Tamaño de sala", min: 0, max: 1, step: 0.05, default: 0.5 },
        { key: "wet", label: "Mezcla", min: 0, max: 1, step: 0.05, default: 0.3 },
      ],
    },
    telephone: { label: "Teléfono", params: [] },
    echo: {
      label: "Eco",
      params: [
        { key: "delayMs", label: "Retardo (ms)", min: 1, max: 5000, step: 10, default: 250 },
        { key: "decay", label: "Decaimiento", min: 0, max: 1, step: 0.05, default: 0.4 },
      ],
    },
    speed: {
      label: "Velocidad",
      params: [{ key: "factor", label: "Factor", min: 0.25, max: 4, step: 0.05, default: 1 }],
    },
    chipmunk: { label: "Ardilla", params: [] },
    deep: { label: "Voz grave", params: [] },
    radio: { label: "Radio AM", params: [] },
    megaphone: { label: "Megáfono", params: [] },
    underwater: { label: "Bajo el agua", params: [] },
    denoise: {
      label: "Reducción de ruido",
      params: [
        { key: "reductionDb", label: "Reducción (dB)", min: 0.01, max: 97, step: 1, default: 12 },
        {
          key: "noiseFloorDb",
          label: "Piso de ruido (dB)",
          min: -80,
          max: -20,
          step: 1,
          default: -25,
        },
      ],
    },
    loudnorm: {
      label: "Normalizar volumen",
      params: [
        {
          key: "integrated",
          label: "Sonoridad (LUFS)",
          min: -70,
          max: -5,
          step: 0.5,
          default: -16,
        },
        { key: "truePeak", label: "Pico real (dBTP)", min: -9, max: 0, step: 0.1, default: -1.5 },
        { key: "lra", label: "Rango (LU)", min: 1, max: 50, step: 1, default: 11 },
      ],
    },
  };

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS) as EditableEffectType[];

export function defaultEffect(type: EditableEffectType): EditableEffect {
  const params = Object.fromEntries(EFFECT_DEFS[type].params.map((p) => [p.key, p.default]));
  return AudioEffectSchema.parse({ type, ...params }) as EditableEffect;
}

export function effectLabel(type: AudioEffectType): string {
  return type === "ducking" ? "Ducking" : EFFECT_DEFS[type].label;
}

export function effectSummary(effect: AudioEffect): string {
  if (effect.type === "ducking") return "Ducking";
  const def = EFFECT_DEFS[effect.type];
  const values = def.params.map(
    (p) => `${p.label.toLowerCase()} ${(effect as Record<string, unknown>)[p.key] as number}`,
  );
  return values.length ? `${def.label} (${values.join(", ")})` : def.label;
}

/** True when every effect belongs to the base contract (storable in `Clip.voiceEffects`). */
export function isBaseVoiceChain(chain: readonly AudioEffect[]): chain is VoiceEffect[] {
  return chain.every((e) => VoiceEffectSchema.safeParse(e).success);
}

export interface VoicePreset {
  id: string;
  name: string;
  effects: EditableEffect[];
}

const LOCAL_PRESETS: readonly VoicePreset[] = [
  {
    id: "monstruo",
    name: "Monstruo",
    effects: [
      { type: "pitch", semitones: -10 },
      { type: "reverb", roomSize: 0.6, wet: 0.35 },
    ],
  },
  { id: "catedral", name: "Catedral", effects: [{ type: "reverb", roomSize: 0.9, wet: 0.5 }] },
  { id: "bajo-agua", name: "Bajo el agua", effects: [{ type: "underwater" }] },
  { id: "megafono", name: "Megáfono", effects: [{ type: "megaphone" }] },
];

/** One-click presets: the api's shared presets first, then local extras. */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  ...VOICE_EFFECT_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    effects: p.effects.filter((e): e is EditableEffect => e.type !== "ducking"),
  })),
  ...LOCAL_PRESETS.filter((l) => !VOICE_EFFECT_PRESETS.some((p) => p.name === l.name)),
];
