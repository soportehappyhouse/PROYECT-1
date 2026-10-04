import { z } from "zod";
import { IdSchema } from "./common.js";

/** FFmpeg-based voice effects (applied by the api via audio filter graphs). */
export const VoiceEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pitch"), semitones: z.number().min(-24).max(24) }),
  z.object({ type: z.literal("robot"), intensity: z.number().min(0).max(1).default(0.7) }),
  z.object({
    type: z.literal("reverb"),
    roomSize: z.number().min(0).max(1).default(0.5),
    wet: z.number().min(0).max(1).default(0.3),
  }),
  z.object({ type: z.literal("telephone") }),
  z.object({
    type: z.literal("echo"),
    delayMs: z.number().min(1).max(5000).default(250),
    decay: z.number().min(0).max(1).default(0.4),
  }),
  z.object({ type: z.literal("speed"), factor: z.number().min(0.25).max(4) }),
  // FFmpeg-only effects; filter chains from docs/trabajo/fuentes-audio.md §4.
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
export type VoiceEffect = z.infer<typeof VoiceEffectSchema>;
export type VoiceEffectType = VoiceEffect["type"];

export const VoiceEffectRequestSchema = z.object({
  assetId: IdSchema,
  effects: z.array(VoiceEffectSchema).min(1),
  /** Output container for the rendered audio (default wav, 48 kHz). */
  format: z.enum(["wav", "mp3", "m4a"]).default("wav"),
});
export type VoiceEffectRequest = z.infer<typeof VoiceEffectRequestSchema>;

/** Named one-click presets for the Voice panel (Spanish labels). */
export const VOICE_EFFECT_PRESETS: readonly { id: string; name: string; effects: VoiceEffect[] }[] =
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

export const TtsProviderSchema = z.enum(["piper", "elevenlabs", "openai"]);
export type TtsProvider = z.infer<typeof TtsProviderSchema>;

export const TtsRequestSchema = z.object({
  provider: TtsProviderSchema.default("piper"),
  text: z.string().min(1).max(20_000),
  /** Provider voice id, e.g. "es_AR-daniela-high" for Piper. */
  voice: z.string().min(1),
  /** Speaking rate multiplier. */
  speed: z.number().min(0.5).max(2).default(1),
  format: z.enum(["wav", "mp3"]).default("wav"),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;
export type TtsRequestInput = z.input<typeof TtsRequestSchema>;

export const TtsVoiceSchema = z.object({
  provider: TtsProviderSchema,
  id: z.string(),
  name: z.string(),
  language: z.string(),
  installed: z.boolean(),
});
export type TtsVoice = z.infer<typeof TtsVoiceSchema>;

export const RvcDeviceSchema = z.enum(["cpu", "cuda"]);

export const RvcRequestSchema = z.object({
  assetId: IdSchema,
  modelId: z.string().min(1),
  /** Pitch shift in semitones (e.g. +12 male->female). */
  pitchShift: z.number().int().min(-24).max(24).default(0),
  /** Feature index ratio 0..1. */
  indexRate: z.number().min(0).max(1).default(0.75),
  f0Method: z.enum(["rmvpe", "harvest", "pm", "crepe"]).default("rmvpe"),
  device: RvcDeviceSchema.optional(),
});
export type RvcRequest = z.infer<typeof RvcRequestSchema>;

export const RvcModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Relative to MODELS_DIR, e.g. "rvc/my-voice/model.pth". */
  modelPath: z.string(),
  indexPath: z.string().optional(),
});
export type RvcModel = z.infer<typeof RvcModelSchema>;
