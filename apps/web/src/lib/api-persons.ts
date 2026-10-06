import {
  API_ROUTES,
  type Consent,
  type ConsentMethod,
  type ConsentScope,
  type LicenceAcceptance,
  type LicenceId,
  type LicenceStatus,
  type Person,
  type PersonCreate,
  type PersonPatch,
  type PersonSummary,
} from "@studio/shared";
import { apiFetch, apiUrl } from "./api";

/**
 * Sprint 4 M1 client: Personas registry (/api/persons) and on-screen licences (/api/ai/licences).
 * Uploads go as multipart (FormData through apiFetch: the browser sets the boundary and the
 * `Origin` header the api checks for consents and licences — HUMAN_ONLY).
 */

export interface ConsentInput {
  scope: ConsentScope;
  method: ConsentMethod;
  signerName: string;
  textVersion: string;
  /** ISO timestamp (end of the chosen day) or undefined = no expiry. */
  expiresAt?: string;
  /** Signature PNG of the canvas, or the signed document (PDF/JPG/PNG). */
  evidence: Blob;
  evidenceName: string;
}

function form(field: string, file: Blob, name: string): FormData {
  const fd = new FormData();
  fd.append(field, file, name);
  return fd;
}

export const personsApi = {
  list: (scope?: "face" | "voice") =>
    apiFetch<PersonSummary[]>(API_ROUTES.persons, { ...(scope && { query: { scope } }) }),
  create: (body: PersonCreate) =>
    apiFetch<Person>(API_ROUTES.persons, { method: "POST", json: body }),
  get: (id: string) => apiFetch<Person>(API_ROUTES.person, { params: { id } }),
  patch: (id: string, body: PersonPatch) =>
    apiFetch<Person>(API_ROUTES.person, { method: "PATCH", params: { id }, json: body }),
  /** Deletes photos and samples, archives the consents (needs the explicit confirmation). */
  remove: (id: string) =>
    apiFetch<void>(API_ROUTES.person, { method: "DELETE", params: { id }, query: { confirm: 1 } }),
  uploadPhoto: (id: string, file: Blob, name = "foto.jpg") =>
    apiFetch<Person>(API_ROUTES.personPhotos, {
      method: "POST",
      params: { id },
      body: form("photo", file, name),
    }),
  deletePhoto: (id: string, photoId: string) =>
    apiFetch<Person>(API_ROUTES.personPhoto, { method: "DELETE", params: { id, photoId } }),
  photoUrl: (id: string, photoId: string) => apiUrl(API_ROUTES.personPhoto, { id, photoId }),
  uploadVoice: (id: string, file: Blob, name = "muestra.webm") =>
    apiFetch<Person>(API_ROUTES.personVoiceSamples, {
      method: "POST",
      params: { id },
      body: form("audio", file, name),
    }),
  deleteVoice: (id: string, sampleId: string) =>
    apiFetch<Person>(API_ROUTES.personVoiceSample, {
      method: "DELETE",
      params: { id, sampleId },
    }),
  voiceUrl: (id: string, sampleId: string) =>
    apiUrl(API_ROUTES.personVoiceSample, { id, sampleId }),
  addConsent: (id: string, c: ConsentInput) => {
    const fd = new FormData();
    fd.append("scope", c.scope);
    fd.append("method", c.method);
    fd.append("signer_name", c.signerName);
    fd.append("text_version", c.textVersion);
    if (c.expiresAt) fd.append("expires_at", c.expiresAt);
    fd.append("accept", "true");
    fd.append("evidence", c.evidence, c.evidenceName);
    return apiFetch<Consent>(API_ROUTES.personConsents, {
      method: "POST",
      params: { id },
      body: fd,
    });
  },
  revokeConsent: (id: string, consentId: string) =>
    apiFetch<Consent>(API_ROUTES.personConsentRevoke, {
      method: "POST",
      params: { id, consentId },
    }),
  evidenceUrl: (id: string, consentId: string) =>
    apiUrl(API_ROUTES.personConsentEvidence, { id, consentId }),
};

export const licencesApi = {
  list: () => apiFetch<LicenceStatus[]>(API_ROUTES.aiLicences),
  accept: (id: LicenceId, textVersion: string) =>
    apiFetch<LicenceAcceptance>(API_ROUTES.aiLicenceAccept, {
      method: "POST",
      params: { id },
      json: { text_version: textVersion, accept: true },
    }),
  revoke: (id: LicenceId) =>
    apiFetch<LicenceAcceptance>(API_ROUTES.aiLicenceRevoke, { method: "POST", params: { id } }),
};
