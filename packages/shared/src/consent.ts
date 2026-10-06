import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";

/**
 * Sprint 4 (docs/trabajo/sprint4-contratos.md): Personas registry with consent history, the
 * on-screen licence acceptance of the face swap models, AI provenance of generated assets and the
 * isolated tool runtimes (FaceFusion / Chatterbox). Gate: apps/api/src/services/persons/gate.ts.
 */

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

/** storage/consent/persons/<id>/{photos,voice,consents/<cid>}/…; archive/<id>/. Never served by /files. */
export const CONSENT_DIR = "consent";
export const CONSENT_TEXT_VERSION = "2026-10-06";
export const CONSENT_TEXT_ES =
  "Yo, {nombre}, mayor de edad, autorizo expresamente a quien usa este equipo a usar mi {alcance} " +
  "para generar contenido alterado con IA en sus videos (por ejemplo, poner mi cara sobre la de un doble de riesgo o " +
  "leer textos con mi voz). Puedo revocarlo cuando quiera; la revocación impide usos nuevos.";

/** «rostro» | «voz» | «rostro y voz». */
export const ConsentScopeSchema = z.enum(["face", "voice", "both"]);
export type ConsentScope = z.infer<typeof ConsentScopeSchema>;

export const ConsentMethodSchema = z.enum(["firma en pantalla", "documento adjunto"]);
export type ConsentMethod = z.infer<typeof ConsentMethodSchema>;

export const ConsentSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  text_version: z.string(),
  /** sha256 of the text shown, already rendered with name and scope. */
  text_sha256: Sha256Schema,
  accepted_at: TimestampSchema,
  method: ConsentMethodSchema,
  signer_name: z.string().trim().min(1).max(120),
  /** Signature PNG of the canvas, or PDF/JPG/PNG of the signed document. */
  evidence_path: z.string(),
  evidence_sha256: Sha256Schema,
  scope: ConsentScopeSchema,
  expires_at: TimestampSchema.optional(),
  revoked_at: TimestampSchema.optional(),
});
export type Consent = z.infer<typeof ConsentSchema>;

export const PersonPhotoSchema = z.object({
  id: IdSchema,
  path: z.string(),
  sha256: Sha256Schema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  faces: z.number().int().nonnegative().nullable(),
});
export type PersonPhoto = z.infer<typeof PersonPhotoSchema>;

export const PersonVoiceSampleSchema = z.object({
  id: IdSchema,
  path: z.string(),
  sha256: Sha256Schema,
  durationSec: z.number().min(5).max(60),
});
export type PersonVoiceSample = z.infer<typeof PersonVoiceSampleSchema>;

export const PersonSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).optional(),
  photos: z.array(PersonPhotoSchema).max(10).default([]),
  voiceSamples: z.array(PersonVoiceSampleSchema).max(5).default([]),
  /** History: the latest valid one counts (decision 7). */
  consents: z.array(ConsentSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Person = z.infer<typeof PersonSchema>;
export type PersonInput = z.input<typeof PersonSchema>;

export const ConsentStateSchema = z.enum(["vigente", "vencido", "revocado", "sin consentimiento"]);
export type ConsentState = z.infer<typeof ConsentStateSchema>;

export const PersonSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  photos: z.number().int(),
  voiceSamples: z.number().int(),
  face: ConsentStateSchema,
  voice: ConsentStateSchema,
  expires_at: TimestampSchema.optional(),
});
export type PersonSummary = z.infer<typeof PersonSummarySchema>;

export const PersonCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type PersonCreate = z.infer<typeof PersonCreateSchema>;

export const PersonPatchSchema = PersonCreateSchema.partial();
export type PersonPatch = z.infer<typeof PersonPatchSchema>;

/** Multipart fields of POST /api/persons/:id/consents (+ file `evidence`). */
export const ConsentCreateFieldsSchema = z.object({
  scope: ConsentScopeSchema,
  method: ConsentMethodSchema,
  signer_name: z.string().trim().min(1).max(120),
  text_version: z.string(),
  expires_at: TimestampSchema.optional(),
  accept: z.literal("true"),
});
export type ConsentCreateFields = z.infer<typeof ConsentCreateFieldsSchema>;

export const LicenceIdSchema = z.enum(["faceswap"]);
export type LicenceId = z.infer<typeof LicenceIdSchema>;

export const LICENCES = {
  faceswap: {
    name_es: "Cambio de cara (modelos no comerciales + OpenRAIL-AS)",
    text_version: "2026-10-06",
    packs: ["faceswap", "faceswap-extra"],
    urls: [
      "https://github.com/facefusion/facefusion",
      "https://github.com/deepinsight/insightface#license",
      "https://www.licenses.ai/",
    ],
    text_es:
      "El cambio de cara usa FaceFusion (licencia OpenRAIL-AS, con restricciones de uso: prohíbe suplantar a alguien sin su " +
      "consentimiento, el contenido sexual no consentido y la desinformación) y modelos de terceros: ArcFace, inswapper y " +
      "kim_vocal_2 (InsightFace y otros: solo uso no comercial / investigación), hyperswap (ResearchRAIL) y xseg (GPL-3). " +
      "Acepto usarlos solo sin fines comerciales, con el consentimiento de las personas y sin monetizar el resultado.",
  },
} as const;

export const LicenceAcceptanceSchema = z.object({
  id: LicenceIdSchema,
  text_version: z.string(),
  text_sha256: Sha256Schema,
  accepted_at: TimestampSchema,
  revoked_at: TimestampSchema.optional(),
});
export type LicenceAcceptance = z.infer<typeof LicenceAcceptanceSchema>;

export const LicenceStatusSchema = z.object({
  id: LicenceIdSchema,
  name_es: z.string(),
  text_es: z.string(),
  text_version: z.string(),
  urls: z.array(z.string()),
  packs: z.array(z.string()),
  accepted: z.boolean(),
  acceptance: LicenceAcceptanceSchema.optional(),
});
export type LicenceStatus = z.infer<typeof LicenceStatusSchema>;

export const LicenceAcceptRequestSchema = z
  .object({ text_version: z.string(), accept: z.literal(true) })
  .strict();
export type LicenceAcceptRequest = z.infer<typeof LicenceAcceptRequestSchema>;

/**
 * Read-only mirror for workers/models_cli/doctor: {accepted: {[id]: {text_version, accepted_at}}}.
 * Written by the api (relative to STORAGE_DIR).
 */
export const LICENCE_MIRROR_PATH = "consent/licences.json";

export const AiProvenanceKindSchema = z.enum(["face", "voice-synthetic", "voice-cloned"]);
export type AiProvenanceKind = z.infer<typeof AiProvenanceKindSchema>;

export const AiProvenanceSchema = z.object({
  kind: AiProvenanceKindSchema,
  /** "facefusion 3.9.1 hyperswap_1a_256" | "chatterbox mtl-v3" | "piper <voz>". */
  tool: z.string().max(120),
  personId: IdSchema.optional(),
  consentId: IdSchema.optional(),
  /** «Voz propia» (the user's own voice, asset kind "voice-ref"). */
  self: z.boolean().optional(),
  licences: z.array(LicenceIdSchema).optional(),
  jobId: IdSchema.optional(),
  sourceAssetId: IdSchema.optional(),
  createdAt: TimestampSchema,
});
export type AiProvenance = z.infer<typeof AiProvenanceSchema>;

/** `details` of 403 CONSENT_REQUIRED. */
export const ConsentRequiredDetailsSchema = z.object({
  personId: IdSchema,
  scope: z.enum(["face", "voice"]),
  reason: z.enum(["none", "expired", "revoked", "scope", "deleted"]),
});
export type ConsentRequiredDetails = z.infer<typeof ConsentRequiredDetailsSchema>;
export type ConsentRequiredReason = ConsentRequiredDetails["reason"];

/** `details` of 403 LICENCE_REQUIRED. */
export const LicenceRequiredDetailsSchema = z.object({
  licenceId: LicenceIdSchema,
  text_version: z.string(),
});
export type LicenceRequiredDetails = z.infer<typeof LicenceRequiredDetailsSchema>;

export const ToolIdSchema = z.enum(["facefusion", "chatterbox"]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const ToolStateSchema = z.enum(["ready", "stale", "missing", "broken", "python"]);
export type ToolState = z.infer<typeof ToolStateSchema>;

/** `details` of 409 TOOL_MISSING. */
export const ToolMissingDetailsSchema = z.object({
  tool: ToolIdSchema,
  state: ToolStateSchema,
  packId: z.string(),
});
export type ToolMissingDetails = z.infer<typeof ToolMissingDetailsSchema>;

/** Spanish labels used by the error messages and the UI. */
export const TOOL_NAME_ES: Record<ToolId, string> = {
  facefusion: "FaceFusion",
  chatterbox: "Chatterbox",
};
export const TOOL_STATE_ES: Record<ToolState, string> = {
  ready: "listo",
  stale: "desactualizado",
  missing: "falta",
  broken: "roto",
  python: "falta Python 3.12",
};
export const CONSENT_REASON_ES: Record<ConsentRequiredReason, string> = {
  none: "sin consentimiento",
  expired: "vencido",
  revoked: "revocado",
  scope: "el consentimiento no cubre ese uso",
  deleted: "la persona fue dada de baja",
};
