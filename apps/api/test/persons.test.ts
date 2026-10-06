import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderConsentText, type Consent, type Person, type PersonSummary } from "@studio/shared";
import { sniffImage } from "../src/services/persons/files.js";
import { hideConsentPaths } from "../src/reports/builder.js";
import { assertHumanOrigin, createConsentGate } from "../src/services/persons/gate.js";
import { makeApp, tempStorage } from "./helpers.js";
import { addConsent, form, ORIGIN, pngHeader } from "./persons-helpers.js";

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
    const upload = async (data: Buffer, name = "foto.png", field = "photo") => {
      const body = await form({}, { [field]: { data, name, type: "image/png" } });
      return app.inject({
        method: "POST",
        url: `/api/persons/${person.id}/photos`,
        payload: body.payload,
        headers: body.headers,
      });
    };
    const ok = await upload(pngHeader(640, 480));
    expect(ok.statusCode).toBe(200);
    const p = ok.json() as Person;
    // workers unreachable in tests: the face count is unknown (UI warns), the photo is kept
    expect(p.photos[0]).toMatchObject({ width: 640, height: 480, faces: null });
    expect(p.photos[0]!.path).toMatch(/^consent\/persons\/[\w-]+\/photos\/[\w-]+\.png$/);
    expect(existsSync(path.join(storage, p.photos[0]!.path))).toBe(true);
    expect((await upload(Buffer.from("not an image"), "x.png")).statusCode).toBe(400);
    expect((await upload(pngHeader(9000, 100))).statusCode).toBe(400);

    const photo = await app.inject({
      method: "GET",
      url: `/api/persons/${person.id}/photos/${p.photos[0]!.id}`,
    });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toContain("image/png");
    const mcp = await app.inject({
      method: "GET",
      url: `/api/persons/${person.id}/photos/${p.photos[0]!.id}`,
      headers: { "x-studio-client": "mcp" },
    });
    expect(mcp.statusCode).toBe(403);
    expect(mcp.json().error.code).toBe("HUMAN_ONLY");
    for (const url of [
      `/files/${p.photos[0]!.path}`,
      "/files/consent/licences.json",
      `/files/CONSENT/persons/${person.id}/photos/${p.photos[0]!.id}.png`,
    ])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);

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
    const send = async (data: Buffer) => {
      const body = await form({}, { audio: { data, name: "muestra.wav", type: "audio/wav" } });
      return app.inject({
        method: "POST",
        url: `/api/persons/${person.id}/voice-samples`,
        payload: body.payload,
        headers: body.headers,
      });
    };
    const ok = await send(make(7));
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
    expect(createConsentGate(app.ctx.db, storage).voiceSamplePath(person.id)).toBe(s.path);
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
    const noSign = await addConsent(app, person.id, { method: "documento adjunto" });
    expect(noSign.statusCode).toBe(201); // a PNG is also a valid signed document
    const created = await addConsent(app, person.id, { scope: "both" });
    expect(created.statusCode).toBe(201);
    const c = created.json() as Consent;
    const { createHash } = await import("node:crypto");
    expect(c.text_sha256).toBe(
      createHash("sha256").update(renderConsentText("Ana Pérez", "both")).digest("hex"),
    );
    expect(c.evidence_path).toMatch(/^consent\/persons\/.+\/consents\/.+\/evidence\.png$/);
    const list = (
      await app.inject({ method: "GET", url: "/api/persons?scope=voice" })
    ).json() as PersonSummary[];
    expect(list.map((p) => p.id)).toEqual([person.id]);
    const evidence = await app.inject({
      method: "GET",
      url: `/api/persons/${person.id}/consents/${c.id}/evidence`,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.headers["content-type"]).toContain("image/png");
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

  it("assertHumanOrigin accepts the dashboard origins only", () => {
    const cfg = { webOrigin: "http://localhost:3000" };
    expect(() =>
      assertHumanOrigin({ headers: { origin: "http://127.0.0.1:3000" } }, cfg),
    ).not.toThrow();
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
});
