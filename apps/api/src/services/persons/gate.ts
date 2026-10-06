import {
  activeConsent,
  CONSENT_REASON_ES,
  consentReason,
  LICENCES,
  personSummary,
  type Consent,
  type ConsentRequiredDetails,
  type LicenceAcceptance,
  type LicenceId,
  type LicenceRequiredDetails,
  type Person,
  type PersonSummary,
} from "@studio/shared";
import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "../../config.js";
import type { SqlDatabase } from "../../db/adapter.js";
import { isAllowedOrigin } from "../../lib/cors.js";
import { sprint4Error } from "../../lib/errors.js";
import {
  ConsentAudit,
  ensurePersonsSchema,
  LicencesRepo,
  PersonsRepo,
  type AuditEntry,
} from "./db.js";
import { sha256 } from "./files.js";

/**
 * Sprint 4 consent gate (docs/trabajo/sprint4-contratos.md «M1 · Gate»; fixed signature, M2 and
 * M3 import it): every use of a Person's face or voice and every face swap job goes through here,
 * at enqueue time AND again when the job starts (a revocation blocks queued jobs).
 */
export interface ConsentGate {
  /** 404 PERSON_NOT_FOUND | 403 CONSENT_REQUIRED. */
  assertConsent(personId: string, need: "face" | "voice"): { person: Person; consent: Consent };
  /** Relative to STORAGE_DIR (the most recent sample); 409 VOICE_SAMPLE_MISSING. */
  voiceSamplePath(personId: string): string;
  /** 403 LICENCE_REQUIRED (also when the accepted text_version is not the current one). */
  assertLicence(id: LicenceId): LicenceAcceptance;
  isLicenceAccepted(id: LicenceId): boolean;
  /** First Person with a valid face consent and a photo with a face (perf test source). */
  benchFaceSource(): { personId: string; consentId: string; photoPath: string } | null;
  /** Append-only consent_audit row. */
  audit(e: {
    action: string;
    personId?: string;
    consentId?: string;
    jobId?: string;
    assetId?: string;
    data?: unknown;
  }): void;
}

/** Gate + the repositories the persons/face routes use (same SQLite connection). */
export interface PersonsService extends ConsentGate {
  readonly persons: PersonsRepo;
  readonly licences: LicencesRepo;
  readonly auditLog: ConsentAudit;
  readonly storageDir: string;
  /** Live Persons as GET /api/persons rows (optionally only those valid for `scope`). */
  summaries(scope?: "face" | "voice"): PersonSummary[];
}

/** sha256 of the licence text shown on screen (stored with the acceptance). */
export const licenceTextSha256 = (id: LicenceId) => sha256(LICENCES[id].text_es);

const ALCANCE_ES = { face: "cara", voice: "voz" } as const;

export function consentRequired(
  person: Pick<Person, "id" | "name">,
  need: "face" | "voice",
  reason: ConsentRequiredDetails["reason"],
) {
  const details: ConsentRequiredDetails = { personId: person.id, scope: need, reason };
  return sprint4Error(
    "CONSENT_REQUIRED",
    { nombre: person.name, alcance: ALCANCE_ES[need], motivo: CONSENT_REASON_ES[reason] },
    details,
  );
}

export function licenceRequired(id: LicenceId) {
  const details: LicenceRequiredDetails = {
    licenceId: id,
    text_version: LICENCES[id].text_version,
  };
  return sprint4Error("LICENCE_REQUIRED", {}, details);
}

const services = new WeakMap<SqlDatabase, Map<string, PersonsService>>();

/** Creates the tables when needed (ensurePersonsSchema); one instance per db + storage dir. */
export function createConsentGate(db: SqlDatabase, storageDir: string): PersonsService {
  let byDir = services.get(db);
  if (!byDir) services.set(db, (byDir = new Map()));
  const cached = byDir.get(storageDir);
  if (cached) return cached;
  ensurePersonsSchema(db);
  const persons = new PersonsRepo(db);
  const licences = new LicencesRepo(db);
  const auditLog = new ConsentAudit(db);

  const accepted = (id: LicenceId): LicenceAcceptance | undefined => {
    const a = licences.get(id);
    return a && !a.revoked_at && a.text_version === LICENCES[id].text_version ? a : undefined;
  };

  const service: PersonsService = {
    persons,
    licences,
    auditLog,
    storageDir,
    summaries(scope) {
      const now = new Date();
      return persons
        .list()
        .map((p) => personSummary(p, now))
        .filter((s) => !scope || s[scope] === "vigente");
    },
    assertConsent(personId, need) {
      const row = persons.find(personId);
      if (!row) throw sprint4Error("PERSON_NOT_FOUND", {}, { personId });
      if (row.deletedAt) throw consentRequired(row.person, need, "deleted");
      const consent = activeConsent(row.person, need);
      if (!consent)
        throw consentRequired(row.person, need, consentReason(row.person, need) ?? "none");
      return { person: row.person, consent };
    },
    voiceSamplePath(personId) {
      const row = persons.find(personId);
      if (!row || row.deletedAt) throw sprint4Error("PERSON_NOT_FOUND", {}, { personId });
      const last = row.person.voiceSamples.at(-1);
      if (!last)
        throw sprint4Error("VOICE_SAMPLE_MISSING", { nombre: row.person.name }, { personId });
      return last.path;
    },
    assertLicence(id) {
      const a = accepted(id);
      if (!a) throw licenceRequired(id);
      return a;
    },
    isLicenceAccepted: (id) => !!accepted(id),
    benchFaceSource() {
      for (const p of persons.list()) {
        const consent = activeConsent(p, "face");
        const photo = p.photos.find((ph) => ph.faces !== 0);
        if (consent && photo)
          return { personId: p.id, consentId: consent.id, photoPath: photo.path };
      }
      return null;
    },
    audit(e: AuditEntry) {
      auditLog.append(e);
    },
  };
  byDir.set(storageDir, service);
  return service;
}

/** Header that studio-mcp sends on every request (the console / assistant, never a human click). */
export const STUDIO_CLIENT_HEADER = "x-studio-client";

/**
 * Consents and licence acceptances are only made from the Studio screen: the request must come
 * from the web (browser `Origin` of the dashboard, same list as CORS) and must not carry
 * `X-Studio-Client: mcp`. A reasonable defence, not strong security (Studio has no auth, §1).
 */
export function assertHumanOrigin(
  req: Pick<FastifyRequest, "headers">,
  config: Pick<ApiConfig, "webOrigin">,
): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (isMcpRequest(req) || !isAllowedOrigin(config, origin)) throw sprint4Error("HUMAN_ONLY");
}

/** True when the request comes from studio-mcp (files of a Person are never handed to it). */
export function isMcpRequest(req: Pick<FastifyRequest, "headers">): boolean {
  const client = req.headers[STUDIO_CLIENT_HEADER];
  return (Array.isArray(client) ? client : [client]).some(
    (c) => typeof c === "string" && c.trim().toLowerCase() === "mcp",
  );
}
