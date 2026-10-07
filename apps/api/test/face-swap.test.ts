import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LICENCES,
  type FaceSwapResult,
  type Job,
  type MediaAsset,
  type Person,
  type Project,
} from "@studio/shared";
import { createConsentGate } from "../src/services/persons/gate.js";
import { restoreClip, swappedClip, taskError } from "../src/jobs/handlers/face.js";
import { makeApp, waitFor } from "./helpers.js";
import { addConsent, form, ORIGIN, pngHeader } from "./persons-helpers.js";

interface Fake {
  installed: boolean;
  extra: boolean;
  tool: string;
  licenceGate: boolean;
  /** Behaviour of the next tasks: ok | nsfw | fail | hold (running until released). */
  mode: "ok" | "nsfw" | "fail" | "hold";
  released: boolean;
  swaps: Record<string, unknown>[];
  canceled: string[];
  tasks: Map<string, { body: Record<string, unknown>; mode: Fake["mode"]; polls: number }>;
}

/** Sprint 4 M1: face.preview / face.swap / undo / agent op against a fake workers service. */
describe("face swap (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const fake: Fake = {
    installed: true,
    extra: false,
    tool: "ready",
    licenceGate: true,
    mode: "ok",
    released: false,
    swaps: [],
    canceled: [],
    tasks: new Map(),
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const url = req.url ?? "";
        const pack = (id: string, installed: boolean, extra = {}) => ({
          id,
          name_es: id === "faceswap" ? "Cambio de cara (FaceFusion 3.9.1)" : "Modelos extra",
          description_es: "",
          size_bytes: 1.8e9,
          installed,
          partial: false,
          files: [],
          required_by: ["face.swap"],
          license: "OpenRAIL-AS + no comerciales",
          group: "faceswap",
          licence_gate: fake.licenceGate ? "faceswap" : null,
          ...extra,
        });
        if (req.method === "GET" && url === "/packs")
          return send(200, [
            pack("faceswap", fake.installed, { tool: { id: "facefusion", state: fake.tool } }),
            pack("faceswap-extra", fake.extra),
          ]);
        if (req.method === "POST" && url === "/packs/faceswap/download")
          return send(200, { task_id: "pk1", status: "queued" });
        if (req.method === "GET" && url.startsWith("/packs/tasks/"))
          return send(200, {
            task_id: "pk1",
            kind: "pack",
            target: "faceswap",
            status: "done",
            progress: 1,
            bytes_done: 1,
            bytes_total: 1,
          });
        if (req.method === "POST" && url === "/face/detect")
          return send(200, {
            t: json.t,
            width: 640,
            height: 360,
            frame_path: "renders/face/detect/x.png",
            faces: [
              { index: 0, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 }, score: 0.9 },
              { index: 1, box: { x: 0.6, y: 0.2, w: 0.2, h: 0.3 }, score: 0.8 },
            ],
          });
        if (req.method === "POST" && url === "/face/swap") {
          fake.swaps.push(json);
          const id = `t${fake.tasks.size + 1}`;
          const base = String(json.output_base);
          const preview = json.preview_t !== undefined && json.preview_t !== null;
          mkdirSync(path.join(storage, base), { recursive: true });
          for (const f of preview ? ["before.png", "after.png"] : ["faceswap.mp4"])
            writeFileSync(path.join(storage, base, f), "x");
          fake.tasks.set(id, { body: json, mode: fake.mode, polls: 0 });
          return send(200, { task_id: id, status: "queued" });
        }
        const m = /^\/face\/tasks\/([^/]+)(\/cancel)?$/.exec(url);
        if (m) {
          const task = fake.tasks.get(m[1]!);
          if (!task) return send(404, { detail: "Tarea desconocida", code: "NOT_FOUND" });
          if (m[2]) {
            fake.canceled.push(m[1]!);
            task.mode = "fail";
            return send(200, { ok: true });
          }
          task.polls++;
          if (task.mode === "hold" && !fake.released)
            return send(200, { status: "running", progress: 0.3, message: "procesando" });
          if (task.polls < 2) return send(200, { status: "running", progress: 0.5 });
          if (task.mode === "nsfw")
            return send(200, {
              status: "error",
              progress: 0.1,
              error:
                "El analizador de contenido de FaceFusion bloqueó este video o imagen: no se procesa.",
              code: "CONTENT_BLOCKED",
            });
          if (task.mode === "fail")
            return send(200, {
              status: "error",
              progress: 0.4,
              error: "FaceFusion terminó con error: CUDAExecutionProvider no disponible.",
              code: "TOOL_FAILED",
              details: {
                logTail: ["[FACEFUSION.CORE] loading", "CUDAExecutionProvider no disponible"],
              },
            });
          const base = String(task.body.output_base);
          const preview = task.body.preview_t !== undefined && task.body.preview_t !== null;
          return send(200, {
            status: "done",
            progress: 1,
            result: preview
              ? {
                  output_path: `${base}after.png`,
                  before_path: `${base}before.png`,
                  frames: 1,
                  fps: 0,
                  proc_fps: 0,
                  device: "cpu",
                  model: task.body.model,
                  timings: {},
                  warnings: ["gpu_fallback_cpu"],
                }
              : {
                  output_path: `${base}faceswap.mp4`,
                  frames: 75,
                  fps: 25,
                  proc_fps: 12,
                  device: "cuda",
                  model: task.body.model,
                  timings: { total_s: 6 },
                  warnings: [],
                },
          });
        }
        return send(404, { detail: "Not Found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app, storage } = await makeApp({ WORKERS_URL: url }));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    Object.assign(fake, {
      installed: true,
      extra: false,
      tool: "ready",
      licenceGate: true,
      mode: "ok",
      released: false,
    });
  });

  const gate = () => createConsentGate(app.ctx.db, storage);
  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      15_000,
    );
    return app.ctx.jobs.get(id)!;
  };
  const addAsset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => {
    const rel = `media/${id}.mp4`;
    mkdirSync(path.join(storage, "media"), { recursive: true });
    writeFileSync(path.join(storage, rel), "x");
    return app.ctx.repos.media.insert({
      id,
      kind: "video",
      name: `Toma ${id}`,
      path: rel,
      sizeBytes: 1,
      durationSec: 10,
      width: 1920,
      height: 1080,
      fps: 25,
      hasAudio: true,
      hasVideo: true,
      createdAt: new Date().toISOString(),
      ...over,
    });
  };
  const makeProject = async (assetId: string): Promise<Project> => {
    const p = (
      await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Doble" } })
    ).json() as Project;
    const V = p.tracks.find((t) => t.kind === "video")!;
    V.clips = [
      {
        id: "clipA",
        trackId: V.id,
        assetId,
        start: 1,
        in: 2,
        out: 5,
        speed: 1,
        volume: 1,
        opacity: 1,
        voiceEffects: [],
        matte: { assetId: "matte1" },
        maskRef: { type: "asset", assetId: "mask1" },
      },
    ];
    return (
      await app.inject({ method: "PUT", url: `/api/projects/${p.id}`, payload: p })
    ).json() as Project;
  };
  const newPerson = async (name: string, withConsent = true): Promise<Person> => {
    const p = (
      await app.inject({ method: "POST", url: "/api/persons", payload: { name } })
    ).json() as Person;
    const body = await form(
      {},
      { photo: { data: pngHeader(512, 512), name: "a.png", type: "image/png" } },
    );
    const up = await app.inject({
      method: "POST",
      url: `/api/persons/${p.id}/photos`,
      payload: body.payload,
      headers: { ...body.headers, ...ORIGIN },
    });
    expect(up.statusCode).toBe(200);
    if (withConsent) expect((await addConsent(app, p.id)).statusCode).toBe(201);
    return (await app.inject({ method: "GET", url: `/api/persons/${p.id}` })).json() as Person;
  };
  const acceptLicence = () =>
    app.inject({
      method: "POST",
      url: "/api/ai/licences/faceswap/accept",
      payload: { text_version: LICENCES.faceswap.text_version, accept: true },
      headers: ORIGIN,
    });
  const revokeLicence = () =>
    app.inject({ method: "POST", url: "/api/ai/licences/faceswap/revoke" });
  const swap = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/face/swap", payload: { confirmed: true, ...body } });

  it("licences: list, HUMAN_ONLY accept, TEXT_OUTDATED, mirror file, revoke, pack download gate", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/ai/licences" })).json();
    expect(list).toEqual([
      expect.objectContaining({
        id: "faceswap",
        accepted: false,
        packs: ["faceswap", "faceswap-extra"],
      }),
    ]);
    const blocked = await app.inject({ method: "POST", url: "/api/ai/packs/faceswap/download" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      code: "LICENCE_REQUIRED",
      details: { licenceId: "faceswap", text_version: LICENCES.faceswap.text_version },
    });
    const human = await app.inject({
      method: "POST",
      url: "/api/ai/licences/faceswap/accept",
      payload: { text_version: LICENCES.faceswap.text_version, accept: true },
      headers: { ...ORIGIN, "x-studio-client": "mcp" },
    });
    expect(human.json().error.code).toBe("HUMAN_ONLY");
    const old = await app.inject({
      method: "POST",
      url: "/api/ai/licences/faceswap/accept",
      payload: { text_version: "2025-01-01", accept: true },
      headers: ORIGIN,
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe("TEXT_OUTDATED");
    const ok = await acceptLicence();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: "faceswap",
      text_version: LICENCES.faceswap.text_version,
    });
    const mirror = JSON.parse(readFileSync(path.join(storage, "consent", "licences.json"), "utf8"));
    expect(mirror.accepted.faceswap.text_version).toBe(LICENCES.faceswap.text_version);
    expect(
      (await app.inject({ method: "POST", url: "/api/ai/packs/faceswap/download" })).statusCode,
    ).toBe(202);
    await revokeLicence();
    const after = JSON.parse(readFileSync(path.join(storage, "consent", "licences.json"), "utf8"));
    expect(after.accepted).toEqual({});
    expect(gate().isLicenceAccepted("faceswap")).toBe(false);
    expect(gate().auditLog.list({ action: "licence.accept" })).toHaveLength(1);
  });

  it("preflight order: licence -> pack -> consent -> venv -> limits; confirmed required", async () => {
    addAsset("v1");
    const ana = await newPerson("Ana", false);
    const body = { personId: ana.id, assetId: "v1" };
    const none = await app.inject({ method: "POST", url: "/api/face/swap", payload: body });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("CONFIRM_REQUIRED");
    fake.installed = false;
    expect((await swap(body)).json().error.code).toBe("LICENCE_REQUIRED");
    await acceptLicence();
    const pack = await swap(body);
    expect(pack.statusCode).toBe(409);
    expect(pack.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "faceswap" });
    fake.installed = true;
    const extra = await swap({ ...body, options: { model: "ghost_1_256" } });
    expect(extra.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "faceswap-extra" });
    const consent = await swap(body);
    expect(consent.statusCode).toBe(403);
    expect(consent.json().error).toMatchObject({
      code: "CONSENT_REQUIRED",
      details: { personId: ana.id, scope: "face", reason: "none" },
    });
    expect(consent.json().error.message).toContain(
      "Ana no tiene un consentimiento vigente para usar su cara",
    );
    expect((await addConsent(app, ana.id)).statusCode).toBe(201);
    fake.tool = "python";
    const tool = await swap(body);
    expect(tool.statusCode).toBe(409);
    expect(tool.json().error).toMatchObject({
      code: "TOOL_MISSING",
      details: { tool: "facefusion", state: "python", packId: "faceswap" },
    });
    expect(tool.json().error.message).toContain("Python 3.12");
    fake.tool = "ready";
    addAsset("long", { durationSec: 700 });
    expect((await swap({ ...body, assetId: "long" })).json().error.code).toBe("CLIP_TOO_LONG");
    addAsset("8k", { width: 7680, height: 4320 });
    expect((await swap({ ...body, assetId: "8k" })).json().error.code).toBe("CLIP_TOO_LONG");
    const nf = await swap({ ...body, personId: "nadie" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe("PERSON_NOT_FOUND");
  });

  it("preview job: before/after PNGs, audit, workers request with consent/ photos", async () => {
    addAsset("v2");
    const bea = await newPerson("Bea");
    await acceptLicence();
    const r = await app.inject({
      method: "POST",
      url: "/api/face/preview",
      payload: {
        personId: bea.id,
        assetId: "v2",
        t: 3,
        selector: { mode: "reference", t: 3, faceIndex: 1 },
      },
    });
    expect(r.statusCode).toBe(202);
    const job = await jobEnd(r.json().jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({
      beforePath: expect.stringMatching(/^renders\/face\/.+\/before\.png$/),
      afterPath: expect.stringMatching(/after\.png$/),
      device: "cpu",
      warnings: ["gpu_fallback_cpu"],
    });
    const sent = fake.swaps.at(-1)!;
    expect(sent).toMatchObject({
      preview_t: 3,
      selector: { mode: "reference", t: 3, face_index: 1, distance: 0.3 },
      model: "hyperswap_1a_256",
      licence_ids: ["faceswap"],
      consent_id: bea.consents[0]!.id,
    });
    expect((sent.source_paths as string[])[0]).toMatch(/^consent\/persons\//);
    expect(gate().auditLog.list({ personId: bea.id, action: "face.preview" })).toHaveLength(1);
    // the job diagnostics never record the consent/ paths of the request
    expect(JSON.stringify(app.ctx.jobs.diagnostics(job.id) ?? {})).not.toContain("consent/");
  });

  it("swap with target: asset aiAltered + provenance, clip.faceSwap.prev, aiFace, undo", async () => {
    addAsset("v3");
    const caro = await newPerson("Caro");
    await acceptLicence();
    const project = await makeProject("v3");
    const r = await swap({
      personId: caro.id,
      assetId: "v3",
      target: { projectId: project.id, clipId: "clipA" },
      options: { strength: 0.8 },
    });
    expect(r.statusCode).toBe(202);
    const job = await jobEnd(r.json().jobId);
    expect(job.status).toBe("succeeded");
    const res = job.result as FaceSwapResult;
    expect(res).toMatchObject({
      frames: 75,
      device: "cuda",
      consentId: caro.consents[0]!.id,
      licences: ["faceswap"],
      clipId: "clipA",
      warnings: ["matte_removed"],
    });
    expect(fake.swaps.at(-1)).toMatchObject({
      range: [2, 5],
      strength: 0.8,
      selector: { mode: "one" },
    });
    const asset = app.ctx.repos.media.get(res.assetId)!;
    expect(asset).toMatchObject({
      kind: "video",
      aiAltered: true,
      durationSec: 3,
      aiProvenance: {
        kind: "face",
        tool: "facefusion 3.9.1 hyperswap_1a_256",
        personId: caro.id,
        consentId: caro.consents[0]!.id,
        licences: ["faceswap"],
        jobId: job.id,
        sourceAssetId: "v3",
      },
    });
    const saved = (
      await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json() as Project;
    const clip = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "clipA")!;
    expect(clip).toMatchObject({ assetId: res.assetId, in: 0, out: 3, start: 1 });
    expect(clip.matte).toBeUndefined();
    expect(clip.maskRef).toBeUndefined();
    expect(clip.faceSwap).toMatchObject({
      prev: { assetId: "v3", in: 2, out: 5, matte: { assetId: "matte1" } },
      personId: caro.id,
      jobId: job.id,
    });
    expect(saved.publish?.flags.aiFace).toBe(true);
    expect(
      gate()
        .auditLog.list({ personId: caro.id })
        .map((a) => a.action),
    ).toEqual(expect.arrayContaining(["face.swap", "face.swap.done"]));

    const undo = await app.inject({
      method: "POST",
      url: "/api/face/undo",
      payload: { projectId: project.id, clipId: "clipA" },
    });
    expect(undo.statusCode).toBe(200);
    const back = (undo.json() as Project).tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "clipA")!;
    expect(back).toMatchObject({ assetId: "v3", in: 2, out: 5, matte: { assetId: "matte1" } });
    expect(back.maskRef).toEqual({ type: "asset", assetId: "mask1" });
    expect(back.faceSwap).toBeUndefined();
    expect((undo.json() as Project).publish?.flags.aiFace).toBe(false);
    expect(app.ctx.repos.media.get(res.assetId)).toBeTruthy(); // stays in Medios
    const again = await app.inject({
      method: "POST",
      url: "/api/face/undo",
      payload: { projectId: project.id, clipId: "clipA" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("dedupe keys on clip + Person; undo restores the previous aiFace (fixes 18, 21)", async () => {
    addAsset("v9");
    const una = await newPerson("Una");
    const otra = await newPerson("Otra");
    await acceptLicence();
    const project = await makeProject("v9");
    // the user had already marked «cara IA» by hand
    const marked = {
      ...project,
      publish: {
        forSocial: true,
        aiLabel: false,
        flags: { aiFace: true, aiVoice: false, aiOther: false, music: false, thirdParty: false },
      },
    };
    await app.inject({ method: "PUT", url: `/api/projects/${project.id}`, payload: marked });
    fake.released = false;
    fake.mode = "hold";
    const target = { projectId: project.id, clipId: "clipA" };
    const a = await swap({ personId: una.id, assetId: "v9", target });
    await waitFor(() => app.ctx.jobs.get(a.json().jobId)!.status === "running");
    const same = await swap({ personId: una.id, assetId: "v9", target });
    const other = await swap({ personId: otra.id, assetId: "v9", target });
    expect(same.json().jobId).toBe(a.json().jobId);
    expect(other.json().jobId).not.toBe(a.json().jobId);
    await app.inject({ method: "POST", url: `/api/jobs/${other.json().jobId}/cancel` });
    fake.released = true;
    expect((await jobEnd(a.json().jobId)).status).toBe("succeeded");
    fake.mode = "ok";
    const undo = await app.inject({
      method: "POST",
      url: "/api/face/undo",
      payload: { projectId: project.id, clipId: "clipA" },
    });
    expect((undo.json() as Project).publish?.flags.aiFace).toBe(true);
  });

  it("revocation / licence withdrawn while the job is queued -> fails when it starts", async () => {
    addAsset("v4");
    addAsset("v5");
    const dani = await newPerson("Dani");
    await acceptLicence();
    fake.mode = "hold";
    const blocker = await app.inject({
      method: "POST",
      url: "/api/face/preview",
      payload: { personId: dani.id, assetId: "v4", t: 1 },
    });
    await waitFor(() => app.ctx.jobs.get(blocker.json().jobId)!.status === "running");
    fake.mode = "ok";
    const queued = await swap({ personId: dani.id, assetId: "v5" });
    expect(queued.statusCode).toBe(202);
    const queued2 = await swap({ personId: dani.id, assetId: "v4" });
    expect(app.ctx.jobs.get(queued.json().jobId)!.status).toBe("queued");
    await app.inject({
      method: "POST",
      url: `/api/persons/${dani.id}/consents/${dani.consents[0]!.id}/revoke`,
    });
    fake.released = true;
    const job = await jobEnd(queued.json().jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("revocado");
    expect(job.result).toMatchObject({
      error: { code: "CONSENT_REQUIRED", details: { reason: "revoked", personId: dani.id } },
    });
    await jobEnd(queued2.json().jobId);

    // licence withdrawn while queued
    expect((await addConsent(app, dani.id)).statusCode).toBe(201);
    fake.released = false;
    fake.mode = "hold";
    const b2 = await app.inject({
      method: "POST",
      url: "/api/face/preview",
      payload: { personId: dani.id, assetId: "v4", t: 1 },
    });
    await waitFor(() => app.ctx.jobs.get(b2.json().jobId)!.status === "running");
    fake.mode = "ok";
    const q3 = await swap({ personId: dani.id, assetId: "v5" });
    await revokeLicence();
    fake.released = true;
    const j3 = await jobEnd(q3.json().jobId);
    expect(j3.status).toBe("failed");
    expect(j3.result).toMatchObject({ error: { code: "LICENCE_REQUIRED" } });
  });

  it("NSFW rejection -> CONTENT_BLOCKED; other failure -> TOOL_FAILED with logTail", async () => {
    addAsset("v6");
    const eli = await newPerson("Eli");
    await acceptLicence();
    fake.mode = "nsfw";
    const a = await swap({ personId: eli.id, assetId: "v6" });
    const ja = await jobEnd(a.json().jobId);
    expect(ja.status).toBe("failed");
    expect(ja.result).toMatchObject({ error: { code: "CONTENT_BLOCKED" } });
    expect(ja.error).toContain("analizador de contenido");
    fake.mode = "fail";
    const b = await swap({ personId: eli.id, assetId: "v6" });
    const jb = await jobEnd(b.json().jobId);
    expect(jb.result).toMatchObject({
      error: {
        code: "TOOL_FAILED",
        details: { logTail: ["[FACEFUSION.CORE] loading", "CUDAExecutionProvider no disponible"] },
      },
    });
    const err = taskError({
      code: "PACK_REQUIRED",
      error: "x",
      details: { packId: "faceswap-extra" },
    });
    expect(err).toMatchObject({ packId: "faceswap-extra" });
  });

  it("face detect proxies the workers (faces left to right, fractions)", async () => {
    addAsset("v7");
    const r = await app.inject({
      method: "POST",
      url: "/api/face/detect",
      payload: { assetId: "v7", t: 99 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      width: 640,
      framePath: "renders/face/detect/x.png",
      faces: [{ index: 0 }, { index: 1 }],
    });
    expect(r.json().t).toBeLessThan(10);
  });

  it("EditPlan face_swap: person name resolved, consent checked, 409 without confirmedIndexes, runs face.swap", async () => {
    addAsset("v8");
    const fede = await newPerson("Federico Gómez");
    await newPerson("Sin Permiso", false);
    await acceptLicence();
    const project = await makeProject("v8");
    const plan = {
      version: 1,
      summary_es: "Cambio la cara del doble por la de Federico.",
      ops: [
        {
          op: "face_swap",
          clip: { id: "clipA" },
          person: { name: "federico" },
          t: 2,
          face_index: 1,
        },
      ],
    };
    const rec = await app.inject({
      method: "POST",
      url: "/api/console/plans",
      payload: { plan, projectId: project.id },
    });
    expect(rec.statusCode).toBe(201);
    const r = rec.json();
    expect(r.ok).toBe(true);
    expect(r.resolved[0]).toMatchObject({ person: { id: fede.id }, t: 2, confirm: true });
    expect(r.preview_es[0]).toContain("«Federico Gómez»");
    expect(r.risks.join(" ")).toContain("contenido alterado");
    const bad = await app.inject({
      method: "POST",
      url: "/api/console/plans",
      payload: {
        plan: {
          ...plan,
          ops: [{ op: "face_swap", clip: { id: "clipA" }, person: { name: "Sin Permiso" } }],
        },
        projectId: project.id,
      },
    });
    expect(bad.json().unresolved[0]).toContain("Registrá el consentimiento de Sin Permiso");
    const noConfirm = await app.inject({
      method: "POST",
      url: "/api/agent/apply",
      payload: { planId: r.id },
    });
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json().error.code).toBe("CONFIRM_REQUIRED");
    const apply = await app.inject({
      method: "POST",
      url: "/api/agent/apply",
      payload: { planId: r.id, confirmedIndexes: [0] },
    });
    expect(apply.statusCode).toBe(202);
    const job = await jobEnd(apply.json().jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ applied: 1 });
    // t = 2 s of the timeline = 3 s of the asset (clip start 1, in 2)
    expect(fake.swaps.at(-1)).toMatchObject({
      selector: { mode: "reference", t: 3, face_index: 1 },
      range: [2, 5],
    });
    const saved = (
      await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    ).json() as Project;
    expect(
      saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "clipA")!.faceSwap?.personId,
    ).toBe(fede.id);
  });

  it("clip helpers keep shape masks and restore asset masks", () => {
    const base = {
      id: "c",
      trackId: "t",
      assetId: "a",
      start: 0,
      in: 1,
      out: 4,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
      maskRef: {
        type: "shape" as const,
        shape: "ellipse" as const,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        feather: 0,
        invert: false,
      },
    };
    const { clip, droppedMatte } = swappedClip(base, {
      assetId: "b",
      length: 3,
      personId: "p",
      consentId: "c1",
      jobId: "j",
    });
    expect(droppedMatte).toBe(false);
    expect(clip.maskRef?.type).toBe("shape");
    expect(restoreClip(clip)).toMatchObject({
      assetId: "a",
      in: 1,
      out: 4,
      maskRef: { type: "shape" },
    });
  });
});
