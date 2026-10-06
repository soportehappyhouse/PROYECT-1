import { describe, expect, it } from "vitest";
import {
  CHATTERBOX_DEFAULTS,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_MAX_TEXT,
  chatterboxTool,
  chatterboxVoiceId,
  estimateChatterboxSeconds,
  FEATURE_PACKS,
  FEATURE_VRAM_MB,
  isChatterboxVoice,
  MediaKindSchema,
  parseChatterboxVoice,
  SELF_VOICE_PROMPT_ES,
  SelfVoiceRefFieldsSchema,
  TtsRequestSchema,
  validateChatterboxRequest,
  VOICE_SAMPLE_LIMITS,
  WorkerTtsResultSchema,
} from "../src/index.js";

const req = (extra: Record<string, unknown> = {}) =>
  TtsRequestSchema.parse({ provider: "chatterbox", text: "Hola, che", voice: "x", ...extra });

describe("Chatterbox voices (sprint 4 M2)", () => {
  it("parses the three voice ids", () => {
    expect(parseChatterboxVoice("chatterbox:multilingual")).toEqual({ kind: "multilingual" });
    expect(parseChatterboxVoice("chatterbox:self")).toEqual({ kind: "self" });
    expect(parseChatterboxVoice("chatterbox:person:p_123")).toEqual({
      kind: "person",
      voiceRef: { personId: "p_123" },
    });
    expect(parseChatterboxVoice("chatterbox:person:")).toBeUndefined();
    expect(parseChatterboxVoice("chatterbox:person:a/b")).toBeUndefined();
    expect(parseChatterboxVoice("es_AR-daniela-high")).toBeUndefined();
    expect(isChatterboxVoice("chatterbox:self")).toBe(true);
    expect(isChatterboxVoice("es_AR-daniela-high")).toBe(false);
    expect(isChatterboxVoice(undefined)).toBe(false);
  });

  it("builds the voice id back from a clone source", () => {
    expect(chatterboxVoiceId(undefined)).toBe("chatterbox:multilingual");
    expect(chatterboxVoiceId("self")).toBe("chatterbox:self");
    expect(chatterboxVoiceId({ assetId: "a1", self: true })).toBe("chatterbox:self");
    expect(chatterboxVoiceId({ personId: "p9" })).toBe("chatterbox:person:p9");
    for (const id of ["chatterbox:self", "chatterbox:person:p9", "chatterbox:multilingual"])
      expect(parseChatterboxVoice(id)).toBeDefined();
  });

  it("fills the defaults (language es, exaggeration 0.5, cfg 0.5, temperature 0.8)", () => {
    const v = validateChatterboxRequest(req({ voice: "chatterbox:multilingual" }));
    expect(v).toEqual({
      ok: true,
      value: { language: "es", selfLatest: false, exaggeration: 0.5, cfg: 0.5, temperature: 0.8 },
    });
    expect(CHATTERBOX_DEFAULTS.language).toBe("es");
    expect(CHATTERBOX_LANGUAGES).toHaveLength(23);
    expect(CHATTERBOX_LANGUAGES).toContain("es");
  });

  it("explicit voiceRef / model win over the voice id", () => {
    const v = validateChatterboxRequest(
      req({
        voice: "chatterbox:person:p1",
        voiceRef: { assetId: "a1", self: true },
        model: "mtl-v2",
        cfg: 0.3,
        seed: 7,
      }),
    );
    expect(v.ok && v.value).toMatchObject({
      voiceRef: { assetId: "a1", self: true },
      model: "mtl-v2",
      cfg: 0.3,
      seed: 7,
      selfLatest: false,
    });
    const self = validateChatterboxRequest(req({ voice: "chatterbox:self" }));
    expect(self.ok && self.value.selfLatest).toBe(true);
    const person = validateChatterboxRequest(req({ voice: "chatterbox:person:p1" }));
    expect(person.ok && person.value.voiceRef).toEqual({ personId: "p1" });
  });

  it("rejects long text, unknown languages and voices", () => {
    const long = validateChatterboxRequest(
      req({ voice: "chatterbox:self", text: "a".repeat(CHATTERBOX_MAX_TEXT + 1) }),
    );
    expect(long).toMatchObject({ ok: false, code: "TEXT_TOO_LONG" });
    expect(validateChatterboxRequest(req({ voice: "chatterbox:self", text: "a".repeat(5000) })).ok);
    expect(
      validateChatterboxRequest(req({ voice: "chatterbox:self", language: "xx" })),
    ).toMatchObject({ ok: false, code: "BAD_LANGUAGE" });
    expect(validateChatterboxRequest(req({ voice: "nope" }))).toMatchObject({
      ok: false,
      code: "BAD_VOICE",
    });
  });

  it("zod ranges of the Chatterbox fields (Paso 0 TtsRequest)", () => {
    expect(() => req({ exaggeration: 0.2 })).toThrow();
    expect(() => req({ exaggeration: 2.1 })).toThrow();
    expect(() => req({ cfg: 1.1 })).toThrow();
    expect(() => req({ temperature: 0.01 })).toThrow();
    expect(() => req({ language: "esp" })).toThrow();
    expect(() => req({ voiceRef: { assetId: "a", self: false } })).toThrow();
    expect(() => req({ voiceRef: { personId: "p", extra: 1 } })).toThrow();
    expect(req({ exaggeration: 2, cfg: 0, temperature: 2 })).toMatchObject({ cfg: 0 });
    // Piper requests do not change: no Chatterbox defaults leak in.
    const piper = TtsRequestSchema.parse({ text: "hola", voice: "es_AR-daniela-high" });
    expect(piper).toEqual({
      provider: "piper",
      text: "hola",
      voice: "es_AR-daniela-high",
      speed: 1,
      format: "wav",
    });
  });

  it("limits, prompt, pack, VRAM and the voice-ref asset kind", () => {
    expect(VOICE_SAMPLE_LIMITS).toMatchObject({ minSec: 5, maxSec: 60, keepSec: 30 });
    expect(VOICE_SAMPLE_LIMITS.maxBytes).toBe(25 * 1024 * 1024);
    expect(SELF_VOICE_PROMPT_ES).toMatch(/^Che, ¿viste que mañana llueve\?/);
    expect(FEATURE_PACKS.chatterbox).toBe("tts-chatterbox");
    expect(FEATURE_VRAM_MB.chatterbox).toBe(4500);
    expect(MediaKindSchema.parse("voice-ref")).toBe("voice-ref");
    expect(SelfVoiceRefFieldsSchema.safeParse({ attestSelf: "true" }).success).toBe(true);
    expect(SelfVoiceRefFieldsSchema.safeParse({}).success).toBe(false);
    expect(chatterboxTool("mtl-v2")).toBe("chatterbox mtl-v2");
  });

  it("estimates synthesis time from the measured RTF", () => {
    expect(estimateChatterboxSeconds("a".repeat(140), 0.5)).toBe(5);
    expect(estimateChatterboxSeconds("hola", undefined)).toBeUndefined();
    expect(estimateChatterboxSeconds("hola", 0)).toBeUndefined();
  });

  it("parses the workers result with the additive fields", () => {
    const r = WorkerTtsResultSchema.parse({
      path: "renders/j.wav",
      durationSec: 2,
      device: "cuda",
      warnings: ["gpu_fallback_cpu"],
      watermark: "perth",
      rtf: 0.6,
      model: "mtl-v3",
      provider: "chatterbox",
    });
    expect(r).toMatchObject({ device: "cuda", watermark: "perth", rtf: 0.6 });
  });
});
