import {
  activeConsent,
  CONSENT_REASON_ES,
  consentCovers,
  consentReason,
  coveredPhotos,
  coveredVoiceSamples,
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
import { isWebOrigin } from "../../lib/cors.js";
import { sprint4Error } from "../../lib/errors.js";
import {
  ConsentAudit,
  ensurePersonsSchema,
  LicencesRepo,
  PersonsRepo,
  type AuditEntry,
} from "./db.js";
import { CONSENT_MIRROR_PATH, sha256, writeJsonAtomic, writeLicenceMirror } from "./files.js";
import { resolveStoragePath } from "../storage.js";

/**
 * Sprint 4 consent gate (docs/trabajo/sprint4-contratos.md «M1 · Gate»; fixed signature, M2 and
 * M3 import it): every use of a Person's face or voice and every face swap job goes through here,
 * at enqueue time AND again when the job starts (a revocation blocks queued jobs).
 */
export interface ConsentGate {
  /** 404 PERSON_NOT_FOUND | 403 CONSENT_REQUIRED. */
  assertConsent(personId: string, need: "face" | "voice"): { person: Person; consent: Consent };
  /**
   * Relative to STORAGE_DIR: the most recent sample COVERED by the active voice consent (audit
   * fix 3); 403 CONSENT_REQUIRED (none / not covered) | 409 VOICE_SAMPLE_MISSING.
   */
  voiceSamplePath(personId: string): string;
  /** 403 LICENCE_REQUIRED (also when the accepted text_version is not the current one). */
  assertLicence(id: LicenceId): LicenceAcceptance;
  isLicenceAccepted(id: LicenceId): boolean;
  /**
   * Perf test source: the Person with the MOST RECENT valid face consent (audit fix 15) and a
   * covered photo with a face.
   */
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
  /**
   * Rewrite the read-only mirrors of the workers (audit fixes 4 / 17): consent/licences.json and
   * consent/active.json (valid consents with the covered photo / sample paths). Called after every
   * change of a Person, consent or licence and when the api starts.
   */
  writeMirrors(): Promise<void>;
}

/** One entry of storage/consent/active.json (snake_case for the workers). */
export interface ConsentMirrorEntry {
  personId: string;
  consentId: string;
  scope: Consent["scope"];
  expires_at: string | null;
  /** STORAGE_DIR-relative, consent/persons/<personId>/photos/… covered by this consent. */
  photo_paths: string[];
  /** STORAGE_DIR-relative, consent/persons/<personId>/voice/… covered by this consent. */
  sample_paths: string[];
}

/** The valid consents of live Persons with the files each one authorizes (face / voice). */
export function consentMirror(persons: readonly Person[], now = new Date()): ConsentMirrorEntry[] {
  const out = new Map<string, ConsentMirrorEntry>();
  for (const p of persons) {
    for (const need of ["face", "voice"] as const) {
      const c = activeConsent(p, need, now);
      if (!c || !consentCovers(c, need)) continue;
      const entry = out.get(c.id) ?? {
        personId: p.id,
        consentId: c.id,
        scope: c.scope,
        expires_at: c.expires_at ?? null,
        photo_paths: [],
        sample_paths: [],
      };
      if (need === "face") entry.photo_paths = coveredPhotos(p, now).map((ph) => ph.path);
      else entry.sample_paths = coveredVoiceSamples(p, now).map((v) => v.path);
      out.set(c.id, entry);
    }
  }
  return [...out.values()];
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
      const p = row.person;
      if (p.voiceSamples.length === 0)
        throw sprint4Error("VOICE_SAMPLE_MISSING", { nombre: p.name }, { personId });
      if (!activeConsent(p, "voice"))
        throw consentRequired(p, "voice", consentReason(p, "voice") ?? "none");
      const last = coveredVoiceSamples(p).at(-1);
      // samples exist but were added after the consent: a new consent has to cover them
      if (!last) throw consentRequired(p, "voice", "scope");
      return last.path;
    },
    assertLicence(id) {
      const a = accepted(id);
      if (!a) throw licenceRequired(id);
      return a;
    },
    isLicenceAccepted: (id) => !!accepted(id),
    benchFaceSource() {
      const candidates = persons
        .list()
        .map((p) => ({ p, consent: activeConsent(p, "face") }))
        .filter((x): x is { p: Person; consent: Consent } => !!x.consent)
        .sort((a, b) => b.consent.accepted_at.localeCompare(a.consent.accepted_at));
      for (const { p, consent } of candidates) {
        const photo = coveredPhotos(p).find((ph) => ph.faces !== 0);
        if (photo) return { personId: p.id, consentId: consent.id, photoPath: photo.path };
      }
      return null;
    },
    audit(e: AuditEntry) {
      auditLog.append(e);
    },
    async writeMirrors() {
      await writeLicenceMirror(storageDir, licences.list());
      await writeJsonAtomic(resolveStoragePath(storageDir, CONSENT_MIRROR_PATH), {
        consents: consentMirror(persons.list()),
        updated_at: new Date().toISOString(),
      });
    },
  };
  byDir.set(storageDir, service);
  return service;
}

/** Header that studio-mcp sends on every request (the console / assistant, never a human click). */
export const STUDIO_CLIENT_HEADER = "x-studio-client";

/**
 * Consents, licence acceptances, Person photos / voice samples, «Voz propia» and the audit log are
 * only handled from the Studio screen: the request must carry the EXACT `Origin` of the web
 * (config.webOrigin, or the same port on localhost / 127.0.0.1; not the permissive CORS list) and
 * must not carry `X-Studio-Client: mcp`. A reasonable defence, not authentication: Studio has no
 * login, so a local process that forges the headers still gets through (ARQUITECTURA §1, manual §24.4).
 */
export function assertHumanOrigin(
  req: Pick<FastifyRequest, "headers">,
  config: Pick<ApiConfig, "webOrigin">,
): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (isMcpRequest(req) || !isWebOrigin(config, origin)) throw sprint4Error("HUMAN_ONLY");
}

/**
 * Biometric reads (Person photos, voice samples, consent evidence; audit fix 5): never for
 * studio-mcp, and only for a browser request of the Studio web: `Sec-Fetch-Site: same-origin|same-site`
 * or the exact web `Origin` (the web loads them with crossOrigin="anonymous" / fetch, so the browser
 * sends it). curl and other scripts send neither unless they forge them (not authentication).
 */
export function assertBrowserRead(
  req: Pick<FastifyRequest, "headers">,
  config: Pick<ApiConfig, "webOrigin">,
): void {
  if (isMcpRequest(req)) throw sprint4Error("HUMAN_ONLY");
  const site = req.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "same-site") return;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isWebOrigin(config, origin)) throw sprint4Error("HUMAN_ONLY");
}

/** True when the request comes from studio-mcp (files of a Person are never handed to it). */
export function isMcpRequest(req: Pick<FastifyRequest, "headers">): boolean {
  const client = req.headers[STUDIO_CLIENT_HEADER];
  return (Array.isArray(client) ? client : [client]).some(
    (c) => typeof c === "string" && c.trim().toLowerCase() === "mcp",
  );
}
