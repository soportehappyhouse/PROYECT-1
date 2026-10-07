import { describe, expect, it } from "vitest";
import {
  AiProvenanceSchema,
  ALWAYS_CONFIRM_OPS,
  AudioJobResultSchema,
  ClipSchema,
  ConsentCreateFieldsSchema,
  ConsentSchema,
  EditOpSchema,
  FaceSelectorSchema,
  FaceSwapRequestSchema,
  formatErrorEs,
  JobTypeSchema,
  LicenceAcceptRequestSchema,
  MediaAssetSchema,
  PackSchema,
  PersonCreateSchema,
  PersonSchema,
  SPRINT4_ERRORS,
  TtsProviderInfoSchema,
  TtsRequestSchema,
  validateEditPlan,
} from "../src/index.js";

const NOW = "2026-10-06T12:00:00.000Z";
const SHA = "a".repeat(64);

const consent = {
  id: "c1",
  personId: "p1",
  text_version: "2026-10-06",
  text_sha256: SHA,
  accepted_at: NOW,
  method: "firma en pantalla",
  signer_name: "Ana Pérez",
  evidence_path: "consent/persons/p1/consents/c1/firma.png",
  evidence_sha256: SHA,
  scope: "both",
};

describe("Sprint 4 contracts: Personas + consent", () => {
  it("parses a Person with defaults and a consent history", () => {
    const p = PersonSchema.parse({ id: "p1", name: "  Ana  ", createdAt: NOW, updatedAt: NOW });
    expect(p).toMatchObject({ name: "Ana", photos: [], voiceSamples: [], consents: [] });
    const full = PersonSchema.parse({
      id: "p1",
      name: "Ana",
      photos: [
        {
          id: "f1",
          path: "consent/persons/p1/photos/f1.jpg",
          sha256: SHA,
          width: 640,
          height: 480,
          faces: null,
        },
      ],
      voiceSamples: [
        { id: "v1", path: "consent/persons/p1/voice/v1.wav", sha256: SHA, durationSec: 10 },
      ],
      consents: [consent, { ...consent, id: "c2", revoked_at: NOW }],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(full.consents.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("rejects invalid Persons and consents", () => {
    const base = { id: "p1", name: "Ana", createdAt: NOW, updatedAt: NOW };
    expect(PersonSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    const photo = { id: "f", path: "x.jpg", sha256: SHA, width: 1, height: 1, faces: 1 };
    expect(PersonSchema.safeParse({ ...base, photos: Array(11).fill(photo) }).success).toBe(false);
    const sample = { id: "v", path: "v.wav", sha256: SHA, durationSec: 4 };
    expect(PersonSchema.safeParse({ ...base, voiceSamples: [sample] }).success).toBe(false);
    expect(ConsentSchema.safeParse(consent).success).toBe(true);
    expect(ConsentSchema.safeParse({ ...consent, text_sha256: "ABC" }).success).toBe(false);
    expect(ConsentSchema.safeParse({ ...consent, scope: "body" }).success).toBe(false);
    expect(ConsentSchema.safeParse({ ...consent, method: "email" }).success).toBe(false);
    expect(PersonCreateSchema.safeParse({ name: "Ana", consents: [] }).success).toBe(false);
    const fields = {
      scope: "face",
      method: "documento adjunto",
      signer_name: "Ana",
      text_version: "2026-10-06",
    };
    expect(ConsentCreateFieldsSchema.safeParse({ ...fields, accept: "true" }).success).toBe(true);
    expect(ConsentCreateFieldsSchema.safeParse({ ...fields, accept: "false" }).success).toBe(false);
    expect(LicenceAcceptRequestSchema.safeParse({ text_version: "x", accept: false }).success).toBe(
      false,
    );
  });
});

describe("Sprint 4 contracts: face swap", () => {
  it("parses a FaceSwap payload with defaults and requires confirmed: true", () => {
    const r = FaceSwapRequestSchema.parse({
      personId: "p1",
      assetId: "a1",
      target: { projectId: "pr", clipId: "c" },
      confirmed: true,
    });
    expect(r.selector).toEqual({ mode: "one" });
    expect(r.options).toEqual({
      model: "hyperswap_1a_256",
      enhancer: true,
      enhancerBlend: 80,
      strength: 1,
    });
    const base = { personId: "p1", assetId: "a1" };
    expect(FaceSwapRequestSchema.safeParse(base).success).toBe(false);
    expect(FaceSwapRequestSchema.safeParse({ ...base, confirmed: false }).success).toBe(false);
    const bad = { ...base, confirmed: true, options: { model: "simswap" } };
    expect(FaceSwapRequestSchema.safeParse(bad).success).toBe(false);
    expect(FaceSelectorSchema.parse({ mode: "reference", t: 2, faceIndex: 1 })).toEqual({
      mode: "reference",
      t: 2,
      faceIndex: 1,
      distance: 0.3,
    });
    expect(FaceSelectorSchema.safeParse({ mode: "many" }).success).toBe(false);
  });

  it("adds face_swap to the EditPlan (always confirmed), jobs and clips", () => {
    const op = { op: "face_swap", clip: { index: 1 }, person: { name: "Ana" } };
    expect(EditOpSchema.safeParse(op).success).toBe(true);
    expect(EditOpSchema.safeParse({ ...op, person: { id: "p1", name: "Ana" } }).success).toBe(
      false,
    );
    expect(EditOpSchema.safeParse({ ...op, strength: 2 }).success).toBe(false);
    expect(validateEditPlan({ version: 1, summary_es: "Cambio la cara", ops: [op] }).ok).toBe(true);
    expect(ALWAYS_CONFIRM_OPS).toContain("face_swap");
    expect(JobTypeSchema.parse("face.swap")).toBe("face.swap");
    expect(JobTypeSchema.parse("face.preview")).toBe("face.preview");
    const clip = ClipSchema.parse({
      id: "c",
      trackId: "t",
      assetId: "new",
      start: 0,
      out: 5,
      faceSwap: {
        prev: { assetId: "old", in: 2, out: 7 },
        personId: "p1",
        consentId: "c1",
        jobId: "j",
      },
    });
    expect(clip.faceSwap?.prev.assetId).toBe("old");
    expect(ClipSchema.parse({ id: "c", trackId: "t", start: 0, out: 5 }).faceSwap).toBeUndefined();
  });
});

describe("Sprint 4 contracts: additive fields stay backward compatible", () => {
  it("media assets, provenance and packs", () => {
    const asset = {
      id: "a",
      kind: "voice-ref",
      name: "Voz propia",
      path: "media/a.wav",
      sizeBytes: 1,
      createdAt: NOW,
    };
    expect(MediaAssetSchema.parse(asset).kind).toBe("voice-ref");
    const prov = { kind: "voice-cloned", tool: "chatterbox mtl-v3", self: true, createdAt: NOW };
    expect(
      MediaAssetSchema.parse({ ...asset, aiAltered: true, aiProvenance: prov }).aiAltered,
    ).toBe(true);
    expect(AiProvenanceSchema.safeParse({ ...prov, kind: "deepfake" }).success).toBe(false);
    const pack = { id: "core", name_es: "Básico", size_bytes: 1, installed: false };
    expect(PackSchema.parse(pack).licence_gate).toBeUndefined();
    const gated = PackSchema.parse({
      ...pack,
      licence_gate: "faceswap",
      tool: { id: "facefusion", state: "python" },
    });
    expect(gated.tool).toEqual({ id: "facefusion", state: "python" });
    expect(PackSchema.parse({ ...pack, licence_gate: null, tool: null }).tool).toBeNull();
    expect(
      PackSchema.safeParse({ ...pack, tool: { id: "facefusion", state: "rota" } }).success,
    ).toBe(false);
  });

  it("TTS requests: Piper unchanged, Chatterbox fields optional", () => {
    const piper = TtsRequestSchema.parse({ text: "Hola", voice: "es_AR-daniela-high" });
    expect(piper).toEqual({
      provider: "piper",
      text: "Hola",
      voice: "es_AR-daniela-high",
      speed: 1,
      format: "wav",
    });
    const cb = TtsRequestSchema.parse({
      provider: "chatterbox",
      text: "Che",
      voice: "chatterbox:self",
      language: "es",
      model: "mtl-v3",
      voiceRef: { assetId: "a", self: true },
      cfg: 0.5,
    });
    expect(cb.voiceRef).toEqual({ assetId: "a", self: true });
    expect(TtsRequestSchema.safeParse({ ...cb, language: "es-AR" }).success).toBe(false);
    expect(TtsRequestSchema.safeParse({ ...cb, voiceRef: { assetId: "a" } }).success).toBe(false);
    expect(TtsRequestSchema.safeParse({ ...cb, exaggeration: 3 }).success).toBe(false);
    const row = {
      id: "chatterbox",
      name: "Chatterbox",
      enabled: false,
      status: "falta paquete",
      packId: "tts-chatterbox",
    };
    expect(TtsProviderInfoSchema.parse(row).packId).toBe("tts-chatterbox");
    expect(
      AudioJobResultSchema.parse({ path: "x.wav", aiVoice: "cloned", watermark: "perth" }).aiVoice,
    ).toBe("cloned");
  });

  it("error codes carry the contract status and Spanish messages", () => {
    expect(SPRINT4_ERRORS.CONSENT_REQUIRED.status).toBe(403);
    expect(SPRINT4_ERRORS.TOOL_FAILED.status).toBe(502);
    expect(SPRINT4_ERRORS.CLIP_TOO_LONG.status).toBe(400);
    expect(
      formatErrorEs("CONSENT_REQUIRED", { nombre: "Ana", alcance: "cara", motivo: "revocado" }),
    ).toBe(
      "Ana no tiene un consentimiento vigente para usar su cara (revocado). Registralo en Ajustes → Personas.",
    );
    expect(formatErrorEs("NO_FACE", {})).toBe("No se encontró una cara en {donde}.");
    expect(formatErrorEs("TOOL_MISSING", { herramienta: "FaceFusion", estado: "roto" })).toContain(
      "scripts\\windows\\setup.ps1 -Update",
    );
  });
});
