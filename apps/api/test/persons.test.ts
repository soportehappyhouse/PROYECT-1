import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderConsentText, type Consent, type Person, type PersonSummary } from "@studio/shared";
import {
  archivePersonFiles,
  decodePngRgba,
  signatureInk,
  sniffImage,
} from "../src/services/persons/files.js";
import { hideConsentPaths } from "../src/reports/builder.js";
import { assertHumanOrigin, createConsentGate } from "../src/services/persons/gate.js";
import { makeApp, tempStorage } from "./helpers.js";
import { addConsent, form, ORIGIN, pngHeader, signaturePng } from "./persons-helpers.js";

/** What a browser of the Studio web sends on an <img>/<audio> of the api (127.0.0.1:3000 → :3001). */
const SAME_SITE = { "sec-fetch-site": "same-site" };

describe("sprint 4 M1: Personas + consent", () => {
  let app: FastifyInstance;
  let storage = "";
  let person: Person;

  beforeAll(async () => {
    ({ app, storage } = await makeApp({ FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("CRUD: create, list, get, patch; delete needs ?confirm=1", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/persons",
      payload: { name: "Ana Pérez", notes: "doble de riesgo" },
    });
    expect(created.statusCode).toBe(201);
    person = created.json();
    expect(person).toMatchObject({ name: "Ana Pérez", photos: [], voiceSamples: [], consents: [] });
    expect(
      (await app.inject({ method: "POST", url: "/api/persons", payload: { name: " " } }))
        .statusCode,
    ).toBe(400);
    const list = (
      await app.inject({ method: "GET", url: "/api/persons" })
    ).json() as PersonSummary[];
    expect(list).toEqual([
      expect.objectContaining({
        id: person.id,
        face: "sin consentimiento",
        voice: "sin consentimiento",
      }),
    ]);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/persons/${person.id}`,
      payload: { notes: "doble de cuerpo" },
    });
    expect(patched.json().notes).toBe("doble de cuerpo");
    const missing = await app.inject({ method: "GET", url: "/api/persons/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("PERSON_NOT_FOUND");
  });

  it("photos: real type and size checked, limit 10, served only by the api (not /files, not to mcp)", async () => {
    const upload = async (
      data: Buffer,
      name = "foto.png",
      field = "photo",
      headers: Record<string, string> = ORIGIN,
    ) => {
      const body = await form({}, { [field]: { data, name, type: "image/png" } });
      return app.inject({
        method: "POST",
        url: `/api/persons/${person.id}/photos`,
        payload: body.payload,
        headers: { ...body.headers, ...headers },
      });
    };
    // audit fix 3: biometrics only from the screen (exact web Origin, never studio-mcp)
    const anonymous = await upload(pngHeader(640, 480), "foto.png", "photo", {});
    expect(anonymous.statusCode).toBe(403);
    expect(anonymous.json().error.code).toBe("HUMAN_ONLY");
    const otherPort = { origin: "http://localhost:5173" };
    expect((await upload(pngHeader(640, 480), "f.png", "photo", otherPort)).statusCode).toBe(403);
    const ok = await upload(pngHeader(640, 480));
    expect(ok.statusCode).toBe(200);
    const p = ok.json() as Person;
    // workers unreachable in tests: the face count is unknown (UI warns), the photo is kept
    expect(p.photos[0]).toMatchObject({ width: 640, height: 480, faces: null });
    expect(p.photos[0]!.path).toMatch(/^consent\/persons\/[\w-]+\/photos\/[\w-]+\.png$/);
    expect(existsSync(path.join(storage, p.photos[0]!.path))).toBe(true);
    expect((await upload(Buffer.from("not an image"), "x.png")).statusCode).toBe(400);
    expect((await upload(pngHeader(9000, 100))).statusCode).toBe(400);

    const photoUrl = `/api/persons/${person.id}/photos/${p.photos[0]!.id}`;
    const photo = await app.inject({ method: "GET", url: photoUrl, headers: SAME_SITE });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toContain("image/png");
    // audit fix 5: same-origin/same-site fetch metadata OR the exact web Origin; nothing -> 403
    const viaOrigin = await app.inject({ method: "GET", url: photoUrl, headers: ORIGIN });
    expect(viaOrigin.statusCode).toBe(200);
    for (const headers of [{}, { "sec-fetch-site": "cross-site" }, { origin: "http://evil.test" }])
      expect((await app.inject({ method: "GET", url: photoUrl, headers })).statusCode).toBe(403);
    const mcp = await app.inject({
      method: "GET",
      url: photoUrl,
      headers: { "x-studio-client": "mcp", ...SAME_SITE },
    });
    expect(mcp.statusCode).toBe(403);
    expect(mcp.json().error.code).toBe("HUMAN_ONLY");
    for (const url of [`/files/${p.photos[0]!.path}`, "/files/consent/licences.json"])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    // Another spelling of the folder is never served either: allowedPath ignores case (404) and,
    // on case-insensitive filesystems (Windows), @fastify/static refuses the alias first (403).
    const alias = await app.inject({
      method: "GET",
      url: `/files/CONSENT/persons/${person.id}/photos/${p.photos[0]!.id}.png`,
    });
    expect([403, 404]).toContain(alias.statusCode);

    for (let i = 1; i < 10; i++) expect((await upload(pngHeader(10, 10))).statusCode).toBe(200);
    const eleventh = await upload(pngHeader(10, 10));
    expect(eleventh.statusCode).toBe(400);
    const full = (
      await app.inject({ method: "GET", url: `/api/persons/${person.id}` })
    ).json() as Person;
    expect(full.photos).toHaveLength(10);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/persons/${person.id}/photos/${full.photos[9]!.id}`,
    });
    expect((del.json() as Person).photos).toHaveLength(9);
    expect(existsSync(path.join(storage, full.photos[9]!.path))).toBe(false);
  });

  it("voice samples: normalized to WAV 24 kHz mono; 5–60 s else VOICE_SAMPLE_INVALID", async () => {
    const work = tempStorage("studio-voice-");
    const make = (sec: number) => {
      const f = path.join(work, `tono-${sec}.wav`);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=f=220:d=${sec}`, f]);
      return readFileSync(f);
    };
    const send = async (data: Buffer, name = "muestra.wav", headers = ORIGIN) => {
      const body = await form({}, { audio: { data, name, type: "audio/wav" } });
      return app.inject({
        method: "POST",
        url: `/api/persons/${person.id}/voice-samples`,
        payload: body.payload,
        headers: { ...body.headers, ...headers },
      });
    };
    expect((await send(make(7), "muestra.wav", {} as typeof ORIGIN)).statusCode).toBe(403);
    // audit fix 20: the client's name does not pick the demuxer (".m3u8" is still a WAV)
    const ok = await send(make(7), "muestra.m3u8");
    expect(ok.statusCode).toBe(200);
    const s = (ok.json() as Person).voiceSamples[0]!;
    expect(s.durationSec).toBeGreaterThanOrEqual(5);
    expect(s.durationSec).toBeLessThanOrEqual(7.2);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", path.join(storage, s.path)],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(probe.streams[0]).toMatchObject({ sample_rate: "24000", channels: 1 });
    const short = await send(make(3));
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe("VOICE_SAMPLE_INVALID");
    const junk = await send(Buffer.from("no es audio"));
    expect(junk.json().error.code).toBe("VOICE_SAMPLE_INVALID");
    const playlist = await send(
      Buffer.from(`#EXTM3U\n#EXTINF:10,\nfile://${path.join(storage, s.path)}\n`),
      "muestra.m3u8",
    );
    expect(playlist.statusCode).toBe(400);
    expect(playlist.json().error.code).toBe("VOICE_SAMPLE_INVALID");
    // without a voice consent the sample is not usable (audit fix 3)
    expect(() => createConsentGate(app.ctx.db, storage).voiceSamplePath(person.id)).toThrow(
      /consentimiento/,
    );
    expect(readdirSync(path.join(storage, "tmp", "persons"))).toEqual([]);
  }, 30_000);

  it("consents: HUMAN_ONLY (Origin of the web, never X-Studio-Client: mcp), TEXT_OUTDATED, evidence", async () => {
    const noOrigin = await addConsent(app, person.id, {}, {});
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error).toMatchObject({ code: "HUMAN_ONLY" });
    expect(noOrigin.json().error.message).toContain("solo se hace desde la pantalla de Studio");
    const fromMcp = await addConsent(app, person.id, {}, { ...ORIGIN, "x-studio-client": "mcp" });
    expect(fromMcp.statusCode).toBe(403);
    const foreign = await addConsent(app, person.id, {}, { origin: "https://evil.example" });
    expect(foreign.statusCode).toBe(403);
    const outdated = await addConsent(app, person.id, { text_version: "2020-01-01" });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json().error.code).toBe("TEXT_OUTDATED");
    // audit fix 16: a blank canvas or a whitespace name is not a signature
    for (const blank of [
      signaturePng(300, 120, { ink: false }),
      signaturePng(300, 120, { ink: false, white: true }),
      pngHeader(300, 120),
    ]) {
      const r = await addConsent(app, person.id, {}, ORIGIN, blank);
      expect(r.statusCode).toBe(400);
    }
    const spaces = await addConsent(app, person.id, { signer_name: "   " });
    expect(spaces.statusCode).toBe(400);
    const noSign = await addConsent(app, person.id, { method: "documento adjunto" });
    expect(noSign.statusCode).toBe(201); // a PNG is also a valid signed document
    const created = await addConsent(app, person.id, { scope: "both" });
    expect(created.statusCode).toBe(201);
    const c = created.json() as Consent;
    // audit fix 3: the consent records the photos / samples loaded now (id + sha256)
    const now = (
      await app.inject({ method: "GET", url: `/api/persons/${person.id}` })
    ).json() as Person;
    expect(c.photo_ids).toEqual(now.photos.map((x) => ({ id: x.id, sha256: x.sha256 })));
    expect(c.sample_ids).toEqual(now.voiceSamples.map((x) => ({ id: x.id, sha256: x.sha256 })));
    const gate = createConsentGate(app.ctx.db, storage);
    expect(gate.voiceSamplePath(person.id)).toBe(now.voiceSamples[0]!.path);
    // audit fix 4: read-only mirror for the workers with the covered files
    const mirror = JSON.parse(readFileSync(path.join(storage, "consent", "active.json"), "utf8"));
    const entry = mirror.consents.find((e: { consentId: string }) => e.consentId === c.id);
    expect(entry).toMatchObject({ personId: person.id, scope: "both", expires_at: null });
    expect(entry.photo_paths).toEqual(now.photos.map((x) => x.path));
    expect(entry.sample_paths).toEqual([now.voiceSamples[0]!.path]);
    const { createHash } = await import("node:crypto");
    expect(c.text_sha256).toBe(
      createHash("sha256").update(renderConsentText("Ana Pérez", "both")).digest("hex"),
    );
    expect(c.evidence_path).toMatch(/^consent\/persons\/.+\/consents\/.+\/evidence\.png$/);
    const list = (
      await app.inject({ method: "GET", url: "/api/persons?scope=voice" })
    ).json() as PersonSummary[];
    expect(list.map((p) => p.id)).toEqual([person.id]);
    const evidenceUrl = `/api/persons/${person.id}/consents/${c.id}/evidence`;
    const evidence = await app.inject({ method: "GET", url: evidenceUrl, headers: ORIGIN });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.headers["content-type"]).toContain("image/png");
    expect((await app.inject({ method: "GET", url: evidenceUrl })).statusCode).toBe(403);
    // a photo added AFTER the consent is not covered until a new consent covers it
    const body = await form(
      {},
      { photo: { data: pngHeader(20, 20), name: "n.png", type: "image/png" } },
    );
    const added = await app.inject({
      method: "POST",
      url: `/api/persons/${person.id}/photos`,
      payload: body.payload,
      headers: { ...body.headers, ...ORIGIN },
    });
    const late = (added.json() as Person).photos.at(-1)!;
    const after = JSON.parse(readFileSync(path.join(storage, "consent", "active.json"), "utf8"));
    const e2 = after.consents.find((e: { consentId: string }) => e.consentId === c.id);
    expect(e2.photo_paths).not.toContain(late.path);
    expect(e2.photo_paths).toHaveLength(now.photos.length);
  });

  it("«Revocar rostro»: every valid consent of the scope; the newest revoked wins (fix 2)", async () => {
    const created = await addConsent(app, person.id, { scope: "face" });
    expect(created.statusCode).toBe(201);
    let rows = (await app.inject({ method: "GET", url: "/api/persons" })).json() as PersonSummary[];
    expect(rows[0]).toMatchObject({ face: "vigente", voice: "vigente" });
    const r = await app.inject({
      method: "POST",
      url: `/api/persons/${person.id}/consents/revoke`,
      payload: { scope: "face" },
    });
    expect(r.statusCode).toBe(200);
    const p = r.json() as Person;
    // face (and the «both» consent, which covers the face) revoked; the document one (face) too
    expect(p.consents.filter((c) => c.scope !== "voice").every((c) => c.revoked_at)).toBe(true);
    rows = (await app.inject({ method: "GET", url: "/api/persons" })).json() as PersonSummary[];
    expect(rows[0]!.face).toBe("revocado");
    const mirror = JSON.parse(readFileSync(path.join(storage, "consent", "active.json"), "utf8"));
    expect(mirror.consents.filter((e: { personId: string }) => e.personId === person.id)).toEqual(
      [],
    );
    const bad = await app.inject({
      method: "POST",
      url: `/api/persons/${person.id}/consents/revoke`,
      payload: { scope: "rostro" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("revocation keeps the history and blocks new uses (state revocado)", async () => {
    const p = (
      await app.inject({ method: "GET", url: `/api/persons/${person.id}` })
    ).json() as Person;
    for (const c of p.consents) {
      const r = await app.inject({
        method: "POST",
        url: `/api/persons/${person.id}/consents/${c.id}/revoke`,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().revoked_at).toBeTruthy();
    }
    const after = (
      await app.inject({ method: "GET", url: "/api/persons" })
    ).json() as PersonSummary[];
    expect(after[0]).toMatchObject({ face: "revocado", voice: "revocado" });
    expect((await app.inject({ method: "GET", url: "/api/persons?scope=face" })).json()).toEqual(
      [],
    );
    const gate = createConsentGate(app.ctx.db, storage);
    expect(() => gate.assertConsent(person.id, "face")).toThrow(/revocado/);
    try {
      gate.assertConsent(person.id, "voice");
    } catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        code: "CONSENT_REQUIRED",
        details: { personId: person.id, scope: "voice", reason: "revoked" },
      });
    }
    const audit = gate.auditLog.list({ personId: person.id });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "person.create",
        "consent.create",
        "consent.revoke",
        "person.photo.add",
      ]),
    );
  });

  it("audit: web-only endpoint, append-only (triggers) and hash chain (fix 11)", async () => {
    const url = `/api/persons/${person.id}/audit`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url, headers: { ...ORIGIN, "x-studio-client": "mcp" } }))
        .statusCode,
    ).toBe(403);
    const res = await app.inject({ method: "GET", url, headers: ORIGIN });
    expect(res.statusCode).toBe(200);
    const { rows, chain } = res.json() as {
      rows: { action: string; hash: string }[];
      chain: { ok: boolean; checked: number };
    };
    expect(chain.ok).toBe(true);
    expect(rows.map((r) => r.action)).toContain("consent.create");
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    expect(() => app.ctx.db.exec("DELETE FROM consent_audit")).toThrow(/append-only/);
    expect(() => app.ctx.db.exec("UPDATE consent_audit SET action = 'x'")).toThrow(/append-only/);
    // a row edited with the triggers gone (another tool) breaks the chain
    app.ctx.db.exec("DROP TRIGGER consent_audit_no_update");
    app.ctx.db.exec("UPDATE consent_audit SET data = '{}' WHERE id = 2");
    const gate = createConsentGate(app.ctx.db, storage);
    expect(gate.auditLog.verify()).toMatchObject({ ok: false, brokenAt: 2 });
    app.ctx.db.exec(
      "CREATE TRIGGER consent_audit_no_update BEFORE UPDATE ON consent_audit BEGIN SELECT RAISE(ABORT, 'consent_audit is append-only'); END;",
    );
  });

  it("delete: photos and samples removed, consents archived, audit kept, PERSON_NOT_FOUND after", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/persons/${person.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFIRM_REQUIRED");
    const ok = await app.inject({ method: "DELETE", url: `/api/persons/${person.id}?confirm=1` });
    expect(ok.statusCode).toBe(204);
    expect(existsSync(path.join(storage, "consent", "persons", person.id))).toBe(false);
    const archive = path.join(storage, "consent", "archive", person.id);
    expect(readdirSync(archive).length).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/persons/${person.id}` })).statusCode).toBe(
      404,
    );
    const gate = createConsentGate(app.ctx.db, storage);
    expect(() => gate.assertConsent(person.id, "face")).toThrow(/dada de baja/);
    expect(gate.auditLog.list({ personId: person.id, action: "person.delete" })).toHaveLength(1);
  });

  it("archive never destroys evidence: copy + verify before deleting; abort keeps everything (fix 7)", async () => {
    const dir = tempStorage("studio-archive-");
    const base = path.join(dir, "consent", "persons", "pA");
    for (const [rel, data] of [
      ["photos/f.png", "foto"],
      ["voice/v.wav", "voz"],
      ["consents/c1/evidence.png", "firma"],
    ] as const) {
      mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
      writeFileSync(path.join(base, rel), data);
    }
    // the archive folder cannot be created (a FILE is in the way): nothing is deleted
    mkdirSync(path.join(dir, "consent", "archive"), { recursive: true });
    writeFileSync(path.join(dir, "consent", "archive", "pA"), "bloqueo");
    await expect(archivePersonFiles(dir, "pA")).rejects.toThrow(/no se borró nada/);
    for (const rel of ["photos/f.png", "voice/v.wav", "consents/c1/evidence.png"])
      expect(existsSync(path.join(base, rel))).toBe(true);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, "consent", "archive", "pA"));
    await archivePersonFiles(dir, "pA");
    expect(existsSync(base)).toBe(false);
    const archived = readdirSync(path.join(dir, "consent", "archive", "pA"));
    expect(archived).toHaveLength(1);
    const copy = path.join(dir, "consent", "archive", "pA", archived[0]!, "c1", "evidence.png");
    expect(readFileSync(copy, "utf8")).toBe("firma");
  });

  it("signature decoder: blank / white / stroke", () => {
    const ink = (b: Buffer) => signatureInk(decodePngRgba(b)!);
    expect(ink(signaturePng())).toBeGreaterThan(100);
    expect(ink(signaturePng(300, 120, { ink: false }))).toBe(0);
    expect(ink(signaturePng(300, 120, { ink: false, white: true }))).toBe(0);
    expect(decodePngRgba(pngHeader(10, 10))).toBeUndefined();
  });

  it("assertHumanOrigin accepts the exact dashboard origins only (fix 5)", () => {
    const cfg = { webOrigin: "http://localhost:3000" };
    expect(() =>
      assertHumanOrigin({ headers: { origin: "http://127.0.0.1:3000" } }, cfg),
    ).not.toThrow();
    // the CORS list still lets any localhost port talk to the api, HUMAN_ONLY does not
    expect(() =>
      assertHumanOrigin({ headers: { origin: "http://127.0.0.1:5173" } }, cfg),
    ).toThrow();
    expect(() =>
      assertHumanOrigin({ headers: { origin: "http://localhost:3000.evil" } }, cfg),
    ).toThrow();
    expect(() => assertHumanOrigin({ headers: {} }, cfg)).toThrow();
    expect(() =>
      assertHumanOrigin(
        { headers: { origin: "http://localhost:3000", "x-studio-client": "MCP" } },
        cfg,
      ),
    ).toThrow();
  });

  it("sniffs JPEG and WebP sizes; reports hide consent paths", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(sniffImage(jpeg)).toMatchObject({ type: "jpeg", width: 640, height: 480 });
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(sniffImage(webp)).toMatchObject({ type: "webp", width: 800, height: 600 });
    expect(
      hideConsentPaths(
        '{"p":"consent/persons/abc/photos/x.png","q":"C:\\\\st\\\\consent\\\\persons\\\\abc\\\\v.wav"}',
      ),
    ).not.toMatch(/persons/);
  });

  it("error reports never carry storage/consent/ (files or paths)", async () => {
    const { mkdirSync, writeFileSync, readdirSync: ls } = await import("node:fs");
    const rel = "consent/persons/pX/photos/f1.png";
    mkdirSync(path.join(storage, "consent/persons/pX/photos"), { recursive: true });
    writeFileSync(path.join(storage, rel), pngHeader(10, 10));
    app.ctx.repos.media.insert({
      id: "leak1",
      kind: "image",
      name: "foto",
      path: rel,
      sizeBytes: 64,
      createdAt: new Date().toISOString(),
    });
    const proj = (
      await app.inject({ method: "POST", url: "/api/projects", payload: { name: "R" } })
    ).json();
    const V = proj.tracks.find((t: { kind: string }) => t.kind === "video");
    V.clips = [
      {
        id: "c1",
        trackId: V.id,
        assetId: "leak1",
        start: 0,
        in: 0,
        out: 1,
        speed: 1,
        volume: 1,
        opacity: 1,
        voiceEffects: [],
      },
    ];
    await app.inject({ method: "PUT", url: `/api/projects/${proj.id}`, payload: proj });
    const job = app.ctx.jobs.create({ type: "face.swap", payload: { personId: "pX" } });
    app.ctx.jobs.update(job.id, { status: "failed", error: `no se pudo leer ${rel}` });
    const res = await app.inject({
      method: "POST",
      url: "/api/reports",
      payload: { title: "Cara", projectId: proj.id, includeMedia: true, jobIds: [job.id] },
    });
    expect(res.statusCode).toBe(201);
    const dir = path.join(storage, "reports", res.json().id);
    const files: string[] = [];
    const walk = (d: string, pre = ""): void => {
      for (const e of ls(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
        else files.push(`${pre}${e.name}`);
      }
    };
    walk(dir);
    expect(files.some((f) => f.includes("consent"))).toBe(false);
    for (const f of files.filter((x) => /\.(json|md)$/.test(x)))
      expect(readFileSync(path.join(dir, f), "utf8")).not.toMatch(/consent\/persons/);
  });
});
