import { z } from "zod";
import { IdSchema } from "./common.js";
import type { ChatterboxModel, TtsRequest, VoiceRef } from "./voice.js";

/**
 * Sprint 4 M2 «Voz»: Chatterbox Multilingual TTS + zero-shot cloning (docs/trabajo/sprint4-contratos.md
 * «M2»). Voices of `TtsRequest.voice` for the chatterbox provider (also used by the Assistant's
 * `tts` op): `chatterbox:multilingual` (the voice in conds.pt), `chatterbox:self` (latest «Voz
 * propia»), `chatterbox:person:<personId>` (a Person with voice consent).
 */
export const CHATTERBOX_PACK_ID = "tts-chatterbox";
export const CHATTERBOX_VOICE_MULTILINGUAL = "chatterbox:multilingual";
export const CHATTERBOX_VOICE_SELF = "chatterbox:self";
export const CHATTERBOX_VOICE_PERSON_PREFIX = "chatterbox:person:";

/** Text limit of one Chatterbox request; the workers split it in chunks ≤ 300 characters. */
export const CHATTERBOX_MAX_TEXT = 5000;
export const CHATTERBOX_CHUNK_CHARS = 300;
export const CHATTERBOX_SAMPLE_RATE = 24_000;
/** Chatterbox Multilingual V2/V3 `SUPPORTED_LANGUAGES` (23). */
export const CHATTERBOX_LANGUAGES = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "sw",
  "tr",
  "zh",
] as const;
export type ChatterboxLanguage = (typeof CHATTERBOX_LANGUAGES)[number];

/**
 * Defaults (contract): `language_id="es"`; exaggeration 0.5; cfg 0.5 (with a reference in the same
 * language it lets the speaker's accent through: what we want for rioplatense; 0.3 when the
 * reference speaks fast; 0 only when the reference language differs); temperature 0.8. `model`
 * is the installed one (mtl-v3; mtl-v2 is the PyPI fallback), so it has no default here.
 */
export const CHATTERBOX_DEFAULTS = {
  language: "es",
  exaggeration: 0.5,
  cfg: 0.5,
  temperature: 0.8,
} as const;

/** Spanish labels of the checkpoints (UI). */
export const CHATTERBOX_MODEL_LABELS_ES: Record<ChatterboxModel, string> = {
  "mtl-v3": "Multilingüe V3",
  "mtl-v2": "Multilingüe V2 (respaldo)",
};

/** «Voz propia» / Person voice samples: 5–60 s, ≤ 25 MB; stored normalized (WAV 24 kHz mono ≤ 30 s). */
export const VOICE_SAMPLE_LIMITS = {
  minSec: 5,
  maxSec: 60,
  maxBytes: 25 * 1024 * 1024,
  keepSec: 30,
  sampleRate: 24_000,
} as const;

/** Sentence the user reads when recording the «Voz propia» sample (≈ 10 s, rioplatense). */
export const SELF_VOICE_PROMPT_ES =
  "Che, ¿viste que mañana llueve? Yo llevo el paraguas, vos traé el mate y nos vemos en la plaza " +
  "a las cinco.";

/** Seconds recorded in the browser for the «Voz propia» sample. */
export const SELF_VOICE_RECORD_SEC = 10;

/** Multipart fields of POST /api/voice/self-refs (+ file `audio`). */
export const SelfVoiceRefFieldsSchema = z.object({ attestSelf: z.literal("true") });

/** Result of parsing a `chatterbox:*` voice id. */
export type ParsedChatterboxVoice =
  | { kind: "multilingual"; voiceRef?: undefined }
  | { kind: "self"; voiceRef?: undefined }
  | { kind: "person"; voiceRef: { personId: string } };

/** True for any `chatterbox:` voice id (the Assistant's `tts` op routes those to Chatterbox). */
export function isChatterboxVoice(voice: string | undefined | null): boolean {
  return typeof voice === "string" && voice.startsWith("chatterbox:");
}

/**
 * Parse a Chatterbox voice id. `chatterbox:self` has no `voiceRef` here: the api resolves it to the
 * most recent «Voz propia» asset. Unknown ids → undefined (400 in the api).
 */
export function parseChatterboxVoice(voice: string): ParsedChatterboxVoice | undefined {
  if (voice === CHATTERBOX_VOICE_MULTILINGUAL || voice === "chatterbox") {
    return { kind: "multilingual" };
  }
  if (voice === CHATTERBOX_VOICE_SELF) return { kind: "self" };
  if (voice.startsWith(CHATTERBOX_VOICE_PERSON_PREFIX)) {
    const personId = voice.slice(CHATTERBOX_VOICE_PERSON_PREFIX.length);
    if (IdSchema.safeParse(personId).success && !/[\s/\\:]/.test(personId)) {
      return { kind: "person", voiceRef: { personId } };
    }
  }
  return undefined;
}

/** Voice id for a clone source (the inverse of parseChatterboxVoice). */
export function chatterboxVoiceId(ref: VoiceRef | "self" | undefined): string {
  if (ref === undefined) return CHATTERBOX_VOICE_MULTILINGUAL;
  if (ref === "self" || "assetId" in ref) return CHATTERBOX_VOICE_SELF;
  return `${CHATTERBOX_VOICE_PERSON_PREFIX}${ref.personId}`;
}

/** What the api sends to the workers after validation (explicit fields win over the voice id). */
export interface ResolvedChatterboxRequest {
  language: string;
  model?: ChatterboxModel;
  /** Explicit or parsed reference; undefined + `selfLatest` = the latest «Voz propia». */
  voiceRef?: VoiceRef;
  selfLatest: boolean;
  exaggeration: number;
  cfg: number;
  temperature: number;
  seed?: number;
}

export type ChatterboxValidation =
  | { ok: true; value: ResolvedChatterboxRequest }
  | { ok: false; code: "TEXT_TOO_LONG" | "BAD_LANGUAGE" | "BAD_VOICE"; message: string };

/**
 * Chatterbox-specific checks on a parsed TtsRequest (zod already checked the ranges): text ≤ 5000
 * characters, supported language, voice id. `voiceRef`/`model` fields win over the voice id.
 */
export function validateChatterboxRequest(req: TtsRequest): ChatterboxValidation {
  if (req.text.length > CHATTERBOX_MAX_TEXT) {
    return {
      ok: false,
      code: "TEXT_TOO_LONG",
      message: `Chatterbox lee hasta ${CHATTERBOX_MAX_TEXT} caracteres por vez (el texto tiene ${req.text.length}): dividilo.`,
    };
  }
  const language = req.language ?? CHATTERBOX_DEFAULTS.language;
  if (!(CHATTERBOX_LANGUAGES as readonly string[]).includes(language)) {
    return {
      ok: false,
      code: "BAD_LANGUAGE",
      message: `Chatterbox no tiene el idioma «${language}».`,
    };
  }
  let voiceRef: VoiceRef | undefined = req.voiceRef;
  let selfLatest = false;
  if (!voiceRef) {
    const parsed = parseChatterboxVoice(req.voice);
    if (!parsed) {
      return {
        ok: false,
        code: "BAD_VOICE",
        message: `Voz de Chatterbox desconocida: «${req.voice}» (chatterbox:multilingual, chatterbox:self o chatterbox:person:<id>).`,
      };
    }
    if (parsed.kind === "person") voiceRef = parsed.voiceRef;
    selfLatest = parsed.kind === "self";
  }
  return {
    ok: true,
    value: {
      language,
      ...(req.model && { model: req.model }),
      ...(voiceRef && { voiceRef }),
      selfLatest,
      exaggeration: req.exaggeration ?? CHATTERBOX_DEFAULTS.exaggeration,
      cfg: req.cfg ?? CHATTERBOX_DEFAULTS.cfg,
      temperature: req.temperature ?? CHATTERBOX_DEFAULTS.temperature,
      ...(req.seed !== undefined && { seed: req.seed }),
    },
  };
}

/**
 * Rough characters → speech seconds (≈ 14 characters per second of Spanish speech), used with
 * `chatterbox_rtf` of the performance test for the «≈ X s» estimate.
 */
export function estimateSpeechSeconds(text: string): number {
  return Math.max(1, text.trim().length / 14);
}

/** Estimated synthesis seconds: speech seconds × RTF (undefined without a measured RTF). */
export function estimateChatterboxSeconds(text: string, rtf: number | null | undefined) {
  if (rtf == null || !Number.isFinite(rtf) || rtf <= 0) return undefined;
  return Math.round(estimateSpeechSeconds(text) * rtf);
}

/** `aiProvenance.tool` of a Chatterbox result, e.g. "chatterbox mtl-v3". */
export function chatterboxTool(model: ChatterboxModel | string | undefined): string {
  return `chatterbox ${model ?? "mtl-v3"}`;
}

/** Workers POST /tts body extension for Chatterbox (camelCase; paths already resolved by the api). */
export interface WorkerChatterboxFields {
  language?: string;
  model?: ChatterboxModel;
  /** `path` relative to STORAGE_DIR; `consent` = "self" or the consentId (for the log). */
  voiceRef?: { path: string; consent: string };
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
  seed?: number;
}

/** Workers POST /tts answer (camelCase) with the Sprint 4 additive fields. */
export const WorkerTtsResultSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative(),
  wavPath: z.string().nullish(),
  sampleRate: z.number().int().nullish(),
  provider: z.string().nullish(),
  device: z.enum(["cuda", "cpu"]).nullish(),
  warnings: z.array(z.string()).nullish(),
  watermark: z.literal("perth").nullish(),
  rtf: z.number().nullish(),
  model: z.string().nullish(),
});
export type WorkerTtsResult = z.infer<typeof WorkerTtsResultSchema>;
