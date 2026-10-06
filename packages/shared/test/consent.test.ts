import { describe, expect, it } from "vitest";
import {
  ALWAYS_CONFIRM_OPS,
  activeConsent,
  CONSENT_TEXT_ES,
  consentReason,
  consentState,
  EditOpSchema,
  personSummary,
  PersonSchema,
  renderConsentText,
  type Consent,
  type Person,
} from "../src/index.js";

const SHA = "a".repeat(64);
const NOW = new Date("2026-10-06T12:00:00.000Z");

function consent(id: string, over: Partial<Consent> = {}): Consent {
  return {
    id,
    personId: "p1",
    text_version: "2026-10-06",
    text_sha256: SHA,
    accepted_at: "2026-10-01T10:00:00.000Z",
    method: "firma en pantalla",
    signer_name: "Ana Pérez",
    evidence_path: `consent/persons/p1/consents/${id}/evidence.png`,
    evidence_sha256: SHA,
    scope: "face",
    ...over,
  };
}

function person(consents: Consent[]): Person {
  return PersonSchema.parse({
    id: "p1",
    name: "Ana Pérez",
    consents,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  });
}

describe("consent state (M1)", () => {
  it("no consent at all / another scope", () => {
    expect(consentState(person([]), "face", NOW)).toBe("sin consentimiento");
    expect(consentReason(person([]), "face", NOW)).toBe("none");
    const voiceOnly = person([consent("c1", { scope: "voice" })]);
    expect(consentState(voiceOnly, "face", NOW)).toBe("sin consentimiento");
    expect(consentReason(voiceOnly, "face", NOW)).toBe("scope");
    expect(consentState(voiceOnly, "voice", NOW)).toBe("vigente");
  });

  it("`both` covers face and voice", () => {
    const p = person([consent("c1", { scope: "both" })]);
    expect(activeConsent(p, "face", NOW)?.id).toBe("c1");
    expect(activeConsent(p, "voice", NOW)?.id).toBe("c1");
  });

  it("expiry: expired at or before now, valid before", () => {
    const p = person([consent("c1", { expires_at: "2026-10-06T12:00:00.000Z" })]);
    expect(consentState(p, "face", NOW)).toBe("vencido");
    expect(consentReason(p, "face", NOW)).toBe("expired");
    expect(consentState(p, "face", new Date("2026-10-06T11:59:59.000Z"))).toBe("vigente");
  });

  it("revocation blocks the consent; a later valid one counts again (history)", () => {
    const revoked = consent("c1", { revoked_at: "2026-10-02T10:00:00.000Z" });
    expect(consentState(person([revoked]), "face", NOW)).toBe("revocado");
    const renewed = consent("c2", { accepted_at: "2026-10-03T10:00:00.000Z" });
    const p = person([revoked, renewed]);
    expect(activeConsent(p, "face", NOW)?.id).toBe("c2");
    // latest covering one revoked, older one still valid: the latest valid one counts
    const p2 = person([
      consent("old", { scope: "both" }),
      consent("new", { accepted_at: "2026-10-05T10:00:00.000Z", revoked_at: NOW.toISOString() }),
    ]);
    expect(activeConsent(p2, "face", NOW)?.id).toBe("old");
    const p3 = person([
      consent("old", { revoked_at: "2026-10-02T00:00:00.000Z" }),
      consent("new", {
        accepted_at: "2026-10-05T10:00:00.000Z",
        expires_at: "2026-10-05T11:00:00.000Z",
      }),
    ]);
    expect(consentState(p3, "face", NOW)).toBe("vencido");
  });

  it("renders the versioned text with name and scope", () => {
    expect(CONSENT_TEXT_ES).toContain("{nombre}");
    const t = renderConsentText("  Ana Pérez ", "both");
    expect(t).toMatch(/^Yo, Ana Pérez, mayor de edad/);
    expect(t).toContain("usar mi rostro y voz para generar");
    expect(renderConsentText("Ana", "voice")).toContain("usar mi voz para");
  });

  it("person summary has the per-scope states and no paths", () => {
    const p = person([consent("c1", { scope: "face", expires_at: "2027-01-01T00:00:00.000Z" })]);
    const s = personSummary(p, NOW);
    expect(s).toEqual({
      id: "p1",
      name: "Ana Pérez",
      photos: 0,
      voiceSamples: 0,
      face: "vigente",
      voice: "sin consentimiento",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(s)).not.toContain("consent/");
  });

  it("face_swap is always confirmed and `person` is {id} or {name}", () => {
    expect(ALWAYS_CONFIRM_OPS).toContain("face_swap");
    const base = { op: "face_swap", clip: { id: "c1" } };
    expect(EditOpSchema.safeParse({ ...base, person: { id: "p1" } }).success).toBe(true);
    expect(EditOpSchema.safeParse({ ...base, person: { name: "Ana" } }).success).toBe(true);
    expect(EditOpSchema.safeParse({ ...base, person: { id: "p1", name: "Ana" } }).success).toBe(
      false,
    );
    expect(EditOpSchema.safeParse({ ...base, person: {} }).success).toBe(false);
  });
});
