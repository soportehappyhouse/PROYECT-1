import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  API_ROUTES,
  CONSENT_TEXT_VERSION,
  ConsentCreateFieldsSchema,
  ConsentRevokeScopeRequestSchema,
  consentCovers,
  LICENCES,
  LicenceAcceptRequestSchema,
  LicenceIdSchema,
  PersonCreateSchema,
  PersonPatchSchema,
  renderConsentText,
  revocableConsents,
  type Consent,
  type ConsentAuditRow,
  type LicenceAcceptance,
  type LicenceId,
  type LicenceStatus,
  type Person,
  type PersonPhoto,
  type PersonVoiceSample,
} from "@studio/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { errorBody, HttpError, sprint4Error } from "../lib/errors.js";
import { safeInputArgs, sniffAudio } from "../services/audio-upload.js";
import { createFaceWorkers } from "../services/persons/face-workers.js";
import {
  archivePersonFiles,
  decodePngRgba,
  isPdf,
  LIMITS,
  MIN_SIGNATURE_INK,
  personRel,
  removeStorageFile,
  SAFE_ID,
  sha256,
  signatureInk,
  sniffImage,
  writeStorageFile,
} from "../services/persons/files.js";
import {
  assertBrowserRead,
  assertHumanOrigin,
  createConsentGate,
  licenceTextSha256,
  type PersonsService,
} from "../services/persons/gate.js";
import { resolveStoragePath } from "../services/storage.js";

/**
 * Sprint 4 M1 routes (docs/trabajo/sprint4-contratos.md «M1 · API»): the Personas registry
 * (/api/persons: CRUD, photos, voice samples, consents with history + revocation) and the on-screen
 * licences (/api/ai/licences). Creating a consent, uploading a photo / voice sample, reading the
 * audit and accepting a licence are HUMAN_ONLY (exact Origin of the dashboard, never
 * `X-Studio-Client: mcp`); photos, samples and evidence are only read by the browser
 * (assertBrowserRead). Files live in storage/consent/ (never served by /files). Every change
 * rewrites the workers' mirrors (consent/active.json, consent/licences.json).
 */

const FILE_TOO_LARGE = "FST_REQ_FILE_TOO_LARGE";

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

async function readUpload(
  req: FastifyRequest,
  fields: readonly string[],
  maxBytes: number,
  what: string,
): Promise<{ data: Buffer; filename: string; mimetype: string }> {
  if (!req.isMultipart())
    throw new HttpError(400, "BAD_REQUEST", `Mandá ${what} como multipart (campo «${fields[0]}»)`);
  let file;
  try {
    file = await req.file({ limits: { fileSize: maxBytes } });
  } catch (err) {
    throw new HttpError(400, "BAD_REQUEST", `No se pudo leer ${what}: ${String(err)}`);
  }
  if (!file || !fields.includes(file.fieldname))
    throw new HttpError(400, "BAD_REQUEST", `Falta ${what} (campo «${fields[0]}»)`);
  try {
    return { data: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype };
  } catch (err) {
    if ((err as { code?: string }).code === FILE_TOO_LARGE)
      throw new HttpError(413, "FILE_TOO_LARGE", `${what} supera ${mb(maxBytes)}`);
    throw err;
  }
}

function sendStorageFile(
  reply: FastifyReply,
  storageDir: string,
  rel: string,
  mime: string,
): FastifyReply {
  const abs = resolveStoragePath(storageDir, rel);
  return reply
    .type(mime)
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .send(createReadStream(abs));
}

const mimeOf = (rel: string) => {
  const ext = path.extname(rel).toLowerCase();
  return ext === ".png"
    ? "image/png"
    : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".pdf"
          ? "application/pdf"
          : ext === ".wav"
            ? "audio/wav"
            : "application/octet-stream";
};

export function licenceStatus(gate: PersonsService, id: LicenceId): LicenceStatus {
  const l = LICENCES[id];
  const acceptance = gate.licences.get(id);
  return {
    id,
    name_es: l.name_es,
    text_es: l.text_es,
    text_version: l.text_version,
    urls: [...l.urls],
    packs: [...l.packs],
    accepted: gate.isLicenceAccepted(id),
    ...(acceptance && { acceptance }),
  };
}

export const personsRoutes: FastifyPluginAsync = async (app) => {
  const { config, ffmpeg } = app.ctx;
  const gate = createConsentGate(app.ctx.db, config.storageDir);
  const face = createFaceWorkers(config.workersUrl);
  const storage = config.storageDir;

  const load = (id: string): Person => {
    const p = SAFE_ID.test(id) ? gate.persons.get(id) : undefined;
    if (!p) throw sprint4Error("PERSON_NOT_FOUND", {}, { personId: id });
    return p;
  };
  const browserRead = (req: FastifyRequest) => assertBrowserRead(req, config);
  /** Rewrite consent/active.json + licences.json after a change (the workers read them). */
  const mirrors = async (req: FastifyRequest) => {
    try {
      await gate.writeMirrors();
    } catch (err) {
      req.log.error({ err: String(err) }, "No se pudieron escribir los espejos de consentimiento");
      throw err;
    }
  };

  // ------------------------------------------------------------------------------- persons
  app.get(API_ROUTES.persons, async (req) => {
    const q = z.object({ scope: z.enum(["face", "voice"]).optional() }).parse(req.query);
    return gate.summaries(q.scope);
  });

  app.post(API_ROUTES.persons, async (req, reply) => {
    const body = PersonCreateSchema.parse(req.body);
    const now = new Date().toISOString();
    const person = gate.persons.insert({
      id: nanoid(12),
      name: body.name,
      ...(body.notes && { notes: body.notes }),
      photos: [],
      voiceSamples: [],
      consents: [],
      createdAt: now,
      updatedAt: now,
    });
    gate.audit({ action: "person.create", personId: person.id });
    return reply.code(201).send(person);
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.person, async (req) => load(req.params.id));

  app.patch<{ Params: { id: string } }>(API_ROUTES.person, async (req) => {
    const patch = PersonPatchSchema.parse(req.body ?? {});
    const p = load(req.params.id);
    const next = gate.persons.save({
      ...p,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    });
    if (patch.name !== undefined && patch.name !== p.name)
      gate.audit({
        action: "person.rename",
        personId: p.id,
        data: { from: p.name, to: next.name },
      });
    return next;
  });

  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    API_ROUTES.person,
    async (req, reply) => {
      const p = load(req.params.id);
      if (req.query.confirm !== "1" && req.query.confirm !== "true")
        throw new HttpError(
          409,
          "CONFIRM_REQUIRED",
          `¿Borrar a «${p.name}»? Se borran sus fotos y muestras de voz; los consentimientos se ` +
            "archivan. Repetí el pedido con ?confirm=1.",
        );
      const at = new Date().toISOString();
      await archivePersonFiles(storage, p.id);
      const archived: Person = {
        ...p,
        photos: [],
        voiceSamples: [],
        consents: p.consents.map((c) => ({
          ...c,
          ...(!c.revoked_at && { revoked_at: at }),
        })),
        updatedAt: at,
      };
      gate.persons.markDeleted(archived, at);
      await mirrors(req);
      gate.audit({
        action: "person.delete",
        personId: p.id,
        data: {
          photos: p.photos.length,
          voiceSamples: p.voiceSamples.length,
          consents: p.consents.length,
        },
      });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------------- photos
  app.post<{ Params: { id: string } }>(API_ROUTES.personPhotos, async (req) => {
    assertHumanOrigin(req, config); // audit fix 3: biometrics only from the screen
    const p = load(req.params.id);
    if (p.photos.length >= LIMITS.photos)
      throw new HttpError(400, "LIMIT_REACHED", `Cada Persona admite hasta ${LIMITS.photos} fotos`);
    const up = await readUpload(req, ["photo", "file"], LIMITS.photoBytes, "la foto");
    const img = sniffImage(up.data);
    if (!img)
      throw new HttpError(400, "UNSUPPORTED_MEDIA", "La foto tiene que ser JPG, PNG o WebP");
    if (img.width < 1 || img.height < 1 || Math.max(img.width, img.height) > LIMITS.photoSide)
      throw new HttpError(
        400,
        "UNSUPPORTED_MEDIA",
        `La foto mide ${img.width}×${img.height}: el lado mayor tiene que ser ≤ ${LIMITS.photoSide} px`,
      );
    const photoId = nanoid(12);
    const rel = personRel(p.id, "photos", `${photoId}.${img.ext}`);
    await writeStorageFile(storage, rel, up.data);
    let faces: number | null = null;
    try {
      faces = (await face.detect(rel, 0)).faces.length;
    } catch (err) {
      // No pack (reframe/faceswap), no workers: the photo is kept, faces unknown (UI warns).
      req.log.warn({ err: String(err) }, "No se pudieron contar las caras de la foto");
    }
    if (faces === 0) {
      await removeStorageFile(storage, rel);
      throw sprint4Error("NO_FACE", { donde: "la foto" });
    }
    const photo: PersonPhoto = {
      id: photoId,
      path: rel,
      sha256: sha256(up.data),
      width: img.width,
      height: img.height,
      faces,
    };
    const current = load(p.id);
    const next = gate.persons.save({ ...current, photos: [...current.photos, photo] });
    gate.audit({
      action: "person.photo.add",
      personId: p.id,
      data: { photoId, faces, sha256: photo.sha256 },
    });
    await mirrors(req);
    return next;
  });

  app.get<{ Params: { id: string; photoId: string } }>(
    API_ROUTES.personPhoto,
    async (req, reply) => {
      browserRead(req);
      const p = load(req.params.id);
      const photo = p.photos.find((ph) => ph.id === req.params.photoId);
      if (!photo) return reply.code(404).send(errorBody("NOT_FOUND", "Foto no encontrada"));
      return sendStorageFile(reply, storage, photo.path, mimeOf(photo.path));
    },
  );

  app.delete<{ Params: { id: string; photoId: string } }>(
    API_ROUTES.personPhoto,
    async (req, reply) => {
      const p = load(req.params.id);
      const photo = p.photos.find((ph) => ph.id === req.params.photoId);
      if (!photo) return reply.code(404).send(errorBody("NOT_FOUND", "Foto no encontrada"));
      const next = gate.persons.save({ ...p, photos: p.photos.filter((ph) => ph.id !== photo.id) });
      await mirrors(req);
      await removeStorageFile(storage, photo.path);
      gate.audit({ action: "person.photo.delete", personId: p.id, data: { photoId: photo.id } });
      return next;
    },
  );

  // ------------------------------------------------------------------------- voice samples
  app.post<{ Params: { id: string } }>(API_ROUTES.personVoiceSamples, async (req) => {
    assertHumanOrigin(req, config); // audit fix 3: biometrics only from the screen
    const p = load(req.params.id);
    if (p.voiceSamples.length >= LIMITS.voiceSamples)
      throw new HttpError(
        400,
        "LIMIT_REACHED",
        `Cada Persona admite hasta ${LIMITS.voiceSamples} muestras de voz`,
      );
    const up = await readUpload(req, ["audio", "file"], LIMITS.voiceBytes, "la muestra de voz");
    // Audit fix 20: the demuxer comes from the real type, never from the client's file name.
    const type = sniffAudio(up.data);
    if (!type)
      throw sprint4Error("VOICE_SAMPLE_INVALID", {}, { reason: "formato de audio no reconocido" });
    const sampleId = nanoid(12);
    const tmpDir = resolveStoragePath(storage, `tmp/persons/${sampleId}`);
    await mkdir(tmpDir, { recursive: true });
    const input = path.join(tmpDir, `input.${type.ext}`);
    const decoded = path.join(tmpDir, "decoded.wav");
    const rel = personRel(p.id, "voice", `${sampleId}.wav`);
    try {
      await writeFile(input, up.data);
      await ffmpeg.run([
        ...safeInputArgs(type),
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-t",
        String(LIMITS.voiceMaxSec + 1),
        "-c:a",
        "pcm_s16le",
        decoded,
      ]);
      const src = await ffmpeg.probe(decoded).catch(() => undefined);
      const dur = src?.durationSec ?? 0;
      if (!src?.hasAudio || dur < LIMITS.voiceMinSec || dur > LIMITS.voiceMaxSec + 0.05)
        throw sprint4Error("VOICE_SAMPLE_INVALID");
      const out = resolveStoragePath(storage, rel);
      await mkdir(path.dirname(out), { recursive: true });
      const trim = "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB";
      await ffmpeg.run([
        "-i",
        decoded,
        "-af",
        `${trim},areverse,${trim},areverse,loudnorm=I=-20:TP=-2:LRA=11`,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-t",
        String(LIMITS.voiceKeepSec),
        "-c:a",
        "pcm_s16le",
        out,
      ]);
      const norm = await ffmpeg.probe(out).catch(() => undefined);
      const kept = norm?.durationSec ?? 0;
      if (kept < LIMITS.voiceMinSec) {
        await rm(out, { force: true });
        throw sprint4Error("VOICE_SAMPLE_INVALID");
      }
      const sample: PersonVoiceSample = {
        id: sampleId,
        path: rel,
        sha256: sha256(await readFile(out)),
        durationSec: Math.round(Math.min(kept, LIMITS.voiceMaxSec) * 100) / 100,
      };
      const current = load(p.id);
      const next = gate.persons.save({
        ...current,
        voiceSamples: [...current.voiceSamples, sample],
      });
      gate.audit({
        action: "person.voice.add",
        personId: p.id,
        data: { sampleId, durationSec: sample.durationSec, sha256: sample.sha256 },
      });
      await mirrors(req);
      return next;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw sprint4Error("VOICE_SAMPLE_INVALID", {}, { reason: String(err).slice(0, 300) });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  app.get<{ Params: { id: string; sampleId: string } }>(
    API_ROUTES.personVoiceSample,
    async (req, reply) => {
      browserRead(req);
      const p = load(req.params.id);
      const s = p.voiceSamples.find((v) => v.id === req.params.sampleId);
      if (!s) return reply.code(404).send(errorBody("NOT_FOUND", "Muestra no encontrada"));
      return sendStorageFile(reply, storage, s.path, "audio/wav");
    },
  );

  app.delete<{ Params: { id: string; sampleId: string } }>(
    API_ROUTES.personVoiceSample,
    async (req, reply) => {
      const p = load(req.params.id);
      const s = p.voiceSamples.find((v) => v.id === req.params.sampleId);
      if (!s) return reply.code(404).send(errorBody("NOT_FOUND", "Muestra no encontrada"));
      const next = gate.persons.save({
        ...p,
        voiceSamples: p.voiceSamples.filter((v) => v.id !== s.id),
      });
      await mirrors(req);
      await removeStorageFile(storage, s.path);
      gate.audit({ action: "person.voice.delete", personId: p.id, data: { sampleId: s.id } });
      return next;
    },
  );

  // ------------------------------------------------------------------------------ consents
  app.post<{ Params: { id: string } }>(API_ROUTES.personConsents, async (req, reply) => {
    assertHumanOrigin(req, config);
    const p = load(req.params.id);
    if (!req.isMultipart())
      throw new HttpError(400, "BAD_REQUEST", "Mandá el consentimiento como multipart");
    const fields: Record<string, string> = {};
    let evidence: Buffer | undefined;
    try {
      for await (const part of req.parts({ limits: { fileSize: LIMITS.evidenceBytes } })) {
        if (part.type === "file") {
          if (part.fieldname === "evidence" && !evidence) evidence = await part.toBuffer();
          else await part.toBuffer();
        } else if (typeof part.value === "string") fields[part.fieldname] = part.value;
      }
    } catch (err) {
      if ((err as { code?: string }).code === FILE_TOO_LARGE)
        throw new HttpError(
          413,
          "FILE_TOO_LARGE",
          `La evidencia supera ${mb(LIMITS.evidenceBytes)}`,
        );
      throw err;
    }
    const body = ConsentCreateFieldsSchema.parse({
      ...fields,
      ...(fields.expires_at === "" && { expires_at: undefined }),
    });
    if (body.text_version !== CONSENT_TEXT_VERSION) throw sprint4Error("TEXT_OUTDATED");
    if (body.expires_at && Date.parse(body.expires_at) <= Date.now())
      throw new HttpError(400, "BAD_REQUEST", "El vencimiento tiene que ser una fecha futura");
    if (!evidence || evidence.length === 0)
      throw new HttpError(
        400,
        "BAD_REQUEST",
        body.method === "firma en pantalla"
          ? "Falta la firma (dibujala en el recuadro)"
          : "Falta el documento firmado (PDF, JPG o PNG)",
      );
    const img = sniffImage(evidence);
    let ext: string;
    if (body.method === "firma en pantalla") {
      if (img?.type !== "png")
        throw new HttpError(400, "UNSUPPORTED_MEDIA", "La firma tiene que ser una imagen PNG");
      if (evidence.length > LIMITS.signatureBytes)
        throw new HttpError(413, "FILE_TOO_LARGE", `La firma supera ${mb(LIMITS.signatureBytes)}`);
      // Audit fix 16: a blank canvas (all transparent / all white) is not a signature.
      const pixels = decodePngRgba(evidence);
      if (!pixels)
        throw new HttpError(400, "UNSUPPORTED_MEDIA", "La firma no es una imagen PNG legible");
      if (signatureInk(pixels) < MIN_SIGNATURE_INK)
        throw new HttpError(
          400,
          "SIGNATURE_EMPTY",
          "La firma está en blanco: que la persona firme en el recuadro.",
        );
      ext = "png";
    } else if (isPdf(evidence)) ext = "pdf";
    else if (img && (img.type === "png" || img.type === "jpeg")) ext = img.ext;
    else throw new HttpError(400, "UNSUPPORTED_MEDIA", "El documento tiene que ser PDF, JPG o PNG");
    const consentId = nanoid(12);
    const evidenceRel = personRel(p.id, "consents", consentId, `evidence.${ext}`);
    await writeStorageFile(storage, evidenceRel, evidence);
    const current = load(p.id);
    // Audit fix 3: the consent covers exactly the photos / samples loaded now (id + sha256).
    const refs = (items: readonly { id: string; sha256: string }[]) =>
      items.map((x) => ({ id: x.id, sha256: x.sha256 }));
    const consent: Consent = {
      id: consentId,
      personId: p.id,
      text_version: body.text_version,
      text_sha256: sha256(renderConsentText(p.name, body.scope)),
      accepted_at: new Date().toISOString(),
      method: body.method,
      signer_name: body.signer_name,
      evidence_path: evidenceRel,
      evidence_sha256: sha256(evidence),
      scope: body.scope,
      ...(body.expires_at && { expires_at: body.expires_at }),
      photo_ids: consentCovers(body, "face") ? refs(current.photos) : [],
      sample_ids: consentCovers(body, "voice") ? refs(current.voiceSamples) : [],
    };
    gate.persons.save({ ...current, consents: [...current.consents, consent] });
    await mirrors(req);
    gate.audit({
      action: "consent.create",
      personId: p.id,
      consentId,
      data: {
        scope: consent.scope,
        method: consent.method,
        text_version: consent.text_version,
        text_sha256: consent.text_sha256,
        evidence_sha256: consent.evidence_sha256,
        ...(consent.expires_at && { expires_at: consent.expires_at }),
        photo_ids: consent.photo_ids,
        sample_ids: consent.sample_ids,
      },
    });
    return reply.code(201).send(consent);
  });

  app.post<{ Params: { id: string; consentId: string } }>(
    API_ROUTES.personConsentRevoke,
    async (req, reply) => {
      const p = load(req.params.id);
      const c = p.consents.find((x) => x.id === req.params.consentId);
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Consentimiento no encontrado"));
      if (c.revoked_at) return c;
      const revoked: Consent = { ...c, revoked_at: new Date().toISOString() };
      gate.persons.save({ ...p, consents: p.consents.map((x) => (x.id === c.id ? revoked : x)) });
      await mirrors(req);
      gate.audit({
        action: "consent.revoke",
        personId: p.id,
        consentId: c.id,
        data: { scope: c.scope },
      });
      return revoked;
    },
  );

  // Audit fix 2: «Revocar rostro» / «Revocar voz» / «Revocar todo» — every non-revoked consent of
  // that scope (a «rostro y voz» one is revoked entirely: one consent, one revocation date).
  app.post<{ Params: { id: string } }>(API_ROUTES.personConsentsRevoke, async (req) => {
    const body = ConsentRevokeScopeRequestSchema.parse(req.body ?? {});
    const p = load(req.params.id);
    const targets = new Set(revocableConsents(p, body.scope).map((c) => c.id));
    if (targets.size === 0) return p;
    const at = new Date().toISOString();
    const next = gate.persons.save({
      ...p,
      consents: p.consents.map((c) => (targets.has(c.id) ? { ...c, revoked_at: at } : c)),
    });
    await mirrors(req);
    for (const id of targets)
      gate.audit({
        action: "consent.revoke",
        personId: p.id,
        consentId: id,
        data: { scope: p.consents.find((c) => c.id === id)?.scope, by: body.scope },
      });
    return next;
  });

  // Audit fix 11: the Person's audit trail (web only) + whether the hash chain is intact.
  app.get<{ Params: { id: string } }>(API_ROUTES.personAudit, async (req) => {
    assertHumanOrigin(req, config);
    const id = req.params.id;
    if (!SAFE_ID.test(id) || !gate.persons.find(id))
      throw sprint4Error("PERSON_NOT_FOUND", {}, { personId: id });
    const rows: ConsentAuditRow[] = gate.auditLog.list({ personId: id, limit: 500 });
    return { rows, chain: gate.auditLog.verify() };
  });

  app.get<{ Params: { id: string; consentId: string } }>(
    API_ROUTES.personConsentEvidence,
    async (req, reply) => {
      browserRead(req);
      const p = load(req.params.id);
      const c = p.consents.find((x) => x.id === req.params.consentId);
      if (!c) return reply.code(404).send(errorBody("NOT_FOUND", "Consentimiento no encontrado"));
      const exists = await stat(resolveStoragePath(storage, c.evidence_path)).catch(
        () => undefined,
      );
      if (!exists) return reply.code(404).send(errorBody("NOT_FOUND", "Evidencia no encontrada"));
      return sendStorageFile(reply, storage, c.evidence_path, mimeOf(c.evidence_path));
    },
  );

  // ------------------------------------------------------------------------------ licences
  app.get(API_ROUTES.aiLicences, async () =>
    LicenceIdSchema.options.map((id) => licenceStatus(gate, id)),
  );

  app.post<{ Params: { id: string } }>(API_ROUTES.aiLicenceAccept, async (req) => {
    assertHumanOrigin(req, config);
    const id = LicenceIdSchema.parse(req.params.id);
    const body = LicenceAcceptRequestSchema.parse(req.body);
    if (body.text_version !== LICENCES[id].text_version) throw sprint4Error("TEXT_OUTDATED");
    const acceptance: LicenceAcceptance = gate.licences.save({
      id,
      text_version: body.text_version,
      text_sha256: licenceTextSha256(id),
      accepted_at: new Date().toISOString(),
    });
    await mirrors(req);
    gate.audit({
      action: "licence.accept",
      data: {
        licenceId: id,
        text_version: acceptance.text_version,
        text_sha256: acceptance.text_sha256,
      },
    });
    return acceptance;
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.aiLicenceRevoke, async (req, reply) => {
    const id = LicenceIdSchema.parse(req.params.id);
    const current = gate.licences.get(id);
    if (!current)
      return reply.code(404).send(errorBody("NOT_FOUND", "La licencia no estaba aceptada"));
    const revoked = current.revoked_at
      ? current
      : gate.licences.save({ ...current, revoked_at: new Date().toISOString() });
    await mirrors(req);
    gate.audit({ action: "licence.revoke", data: { licenceId: id } });
    return revoked;
  });
};
