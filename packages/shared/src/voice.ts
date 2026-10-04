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
]);
export type VoiceEffect = z.infer<typeof VoiceEffectSchema>;
export type VoiceEffectType = VoiceEffect["type"];

export const VoiceEffectRequestSchema = z.object({
  assetId: IdSchema,
  effects: z.array(VoiceEffectSchema).min(1),
});
export type VoiceEffectRequest = z.infer<typeof VoiceEffectRequestSchema>;

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
