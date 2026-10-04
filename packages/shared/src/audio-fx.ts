import { z } from "zod";
import { IdSchema } from "./common.js";
import { VoiceEffectSchema } from "./voice.js";

/**
 * Additive extension of VoiceEffect (module b). Extra FFmpeg-only effects whose filter chains come
 * from docs/trabajo/fuentes-audio.md §4. Pending contract merge into VoiceEffectSchema.
 */
export const ExtraVoiceEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chipmunk") }),
  z.object({ type: z.literal("deep") }),
  z.object({ type: z.literal("radio") }),
  z.object({ type: z.literal("megaphone") }),
  z.object({ type: z.literal("underwater") }),
  z.object({
    type: z.literal("denoise"),
    /** Noise reduction in dB (afftdn nr). */
    reductionDb: z.number().min(0.01).max(97).default(12),
    /** Noise floor in dB (afftdn nf). */
    noiseFloorDb: z.number().min(-80).max(-20).default(-25),
  }),
  z.object({
    type: z.literal("loudnorm"),
    /** Integrated loudness target in LUFS (-16 web/YouTube, -14 Reels/TikTok). */
    integrated: z.number().min(-70).max(-5).default(-16),
    truePeak: z.number().min(-9).max(0).default(-1.5),
    lra: z.number().min(1).max(50).default(11),
    /** Two-pass (measure + linear apply). One pass = dynamic mode. */
    twoPass: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("ducking"),
    /** Music/bed asset ducked under this voice and mixed into the output. */
    musicAssetId: IdSchema,
    threshold: z.number().min(0.000977).max(1).default(0.05),
    ratio: z.number().min(1).max(20).default(8),
    attackMs: z.number().min(0.01).max(2000).default(20),
    releaseMs: z.number().min(0.01).max(9000).default(400),
    musicVolume: z.number().min(0).max(4).default(1),
  }),
]);
export type ExtraVoiceEffect = z.infer<typeof ExtraVoiceEffectSchema>;

/** Any audio effect the api can render: shared VoiceEffect plus the extras above. */
export const AudioEffectSchema = z.union([VoiceEffectSchema, ExtraVoiceEffectSchema]);
export type AudioEffect = z.infer<typeof AudioEffectSchema>;
export type AudioEffectType = AudioEffect["type"];

/** Superset of VoiceEffectRequest accepted by POST /api/voice/effects. */
export const AudioEffectRequestSchema = z.object({
  assetId: IdSchema,
  effects: z.array(AudioEffectSchema).min(1),
  /** Output container for the rendered audio (default wav, 48 kHz). */
  format: z.enum(["wav", "mp3", "m4a"]).default("wav"),
});
export type AudioEffectRequest = z.infer<typeof AudioEffectRequestSchema>;

/** Named one-click presets for the Voice panel (Spanish labels). */
export const VOICE_EFFECT_PRESETS: readonly { id: string; name: string; effects: AudioEffect[] }[] =
  [
    { id: "pitch-up", name: "Tono +4", effects: [{ type: "pitch", semitones: 4 }] },
    { id: "pitch-down", name: "Tono -4", effects: [{ type: "pitch", semitones: -4 }] },
    { id: "chipmunk", name: "Ardilla", effects: [{ type: "chipmunk" }] },
    { id: "deep", name: "Voz grave", effects: [{ type: "deep" }] },
    { id: "robot", name: "Robot", effects: [{ type: "robot", intensity: 1 }] },
    { id: "telephone", name: "Teléfono", effects: [{ type: "telephone" }] },
    { id: "radio", name: "Radio AM", effects: [{ type: "radio" }] },
    { id: "reverb", name: "Sala", effects: [{ type: "reverb", roomSize: 0.5, wet: 0.3 }] },
    { id: "echo", name: "Eco", effects: [{ type: "echo", delayMs: 250, decay: 0.4 }] },
    {
      id: "clean-voice",
      name: "Voz limpia",
      effects: [
        { type: "denoise", reductionDb: 10, noiseFloorDb: -30 },
        { type: "loudnorm", integrated: -16, truePeak: -1.5, lra: 11, twoPass: true },
      ],
    },
  ];
