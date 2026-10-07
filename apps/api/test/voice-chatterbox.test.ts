import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  type AudioJobResult,
  type Job,
  type MediaAsset,
  type Person,
  type TtsProviderInfo,
  type TtsVoiceInfo,
} from "@studio/shared";
import { createConsentGate } from "../src/services/persons/gate.js";
import { createTtsHandler, type VoiceAiDeps } from "../src/voice-ai/handlers.js";
import { makeApp, waitFor } from "./helpers.js";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/** 16-bit mono PCM WAV: `seconds` of a tone (or silence with amp 0). */
function wav(seconds: number, { rate = 24_000, hz = 220, amp = 0.3 } = {}): Buffer {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return buf;
}

function form(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("audio", new Blob([file.data], { type: "audio/wav" }), file.name);
  return fd;
}

/** Multipart POST as the Studio web sends it (HUMAN_ONLY routes need its exact Origin). */
async function inject(
  app: FastifyInstance,
  url: string,
  fd: FormData,
  headers: Record<string, string> = { origin: "http://localhost:3000" },
) {
  const res = new Response(fd);
  return app.inject({
    method: "POST",
    url,
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")!, ...headers },
  });
}

const now = () => new Date().toISOString();

/** Sprint 4 M2: Chatterbox TTS + cloning against a fake workers service and M1's real gate. */
describe("Chatterbox TTS + clonación (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const state = {
    installed: true,
    gpu: "cpu" as "gpu" | "cpu",
    fail: undefined as undefined | { status: number; body: unknown },
    tts: [] as Record<string, unknown>[],
    rvc: [] as Record<string, unknown>[],
    /** POST /tts/cancel bodies; with `hold` the next /tts waits until a cancel arrives. */
    cancels: [] as Record<string, unknown>[],
    hold: false,
    release: undefined as undefined | (() => void),
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
        if (req.method === "GET" && url === "/packs")
          return send(200, [
            {
              id: "tts-chatterbox",
              name_es: "Voz avanzada (Chatterbox: español y clonación)",
              description_es: "",
              size_bytes: 6.2e9,
              installed: state.installed,
              partial: false,
              files: [],
              required_by: ["voice.tts.chatterbox"],
              license: "MIT",
              group: "voice",
              licence_gate: null,
              tool: { id: "chatterbox", state: state.installed ? "ready" : "missing" },
            },
          ]);
        if (req.method === "GET" && url === "/gpu/status")
          return send(200, {
            cuda: state.gpu === "gpu",
            gpu_name: null,
            vram_total_mb: null,
            vram_free_mb: null,
            resident_model: null,
            mode: state.gpu,
            sysmem_fallback: false,
          });
        if (req.method === "GET" && url === "/tts/providers")
          return send(200, [
            { id: "piper", name: "Piper (local)", enabled: true, status: "local" },
            {
              id: "chatterbox",
              name: "Chatterbox (local, GPU)",
              enabled: state.installed,
              status: state.installed ? "local" : "falta paquete",
              packId: "tts-chatterbox",
              installed: state.installed,
              supportsClone: true,
              models: state.installed ? ["mtl-v3"] : ["mtl-v3", "mtl-v2"],
              languages: ["es", "en"],
              gpu: true,
            },
          ]);
        if (req.method === "GET" && url === "/tts/voices")
          return send(200, [
            {
              provider: "piper",
              id: "es_AR-daniela-high",
              name: "Daniela",
              language: "es_AR",
              installed: true,
            },
          ]);
        if (req.method === "POST" && url === "/tts/cancel") {
          state.cancels.push(json);
          state.release?.();
          return send(200, { canceled: true, stopped: true, jobId: json.jobId });
        }
        if (req.method === "POST" && url === "/tts") {
          state.tts.push(json);
          if (state.hold) {
            state.release = () =>
              send(409, { detail: "Cancelado: la síntesis se detuvo.", code: "CANCELED" });
            return;
          }
          if (state.fail) return send(state.fail.status, state.fail.body);
          const out = String(json.outputPath);
          mkdirSync(path.dirname(path.join(storage, out)), { recursive: true });
          writeFileSync(path.join(storage, out), wav(1));
          const chatter = json.provider === "chatterbox";
          return send(200, {
            path: out,
            durationSec: 1,
            wavPath: out,
            sampleRate: chatter ? 24000 : 22050,
            provider: json.provider,
            ...(chatter && {
              device: "cpu",
              warnings: ["chatterbox_cpu_slow"],
              watermark: "perth",
              rtf: 1.7,
              model: "mtl-v3",
            }),
          });
        }
        if (req.method === "POST" && url === "/rvc/convert") {
          state.rvc.push(json);
          const out = String(json.outputPath);
          writeFileSync(path.join(storage, out), wav(1));
          return send(200, { path: out, durationSec: 1, sampleRate: 40000, device: "cuda" });
        }
        if (req.method === "GET" && url.startsWith("/jobs/"))
          return send(200, { jobId: url.slice(6), status: "running", progress: 0.5 });
        return send(404, { detail: "Not Found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app, storage } = await makeApp({
      WORKERS_URL: url,
      ...(hasFfmpeg && { FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }),
    }));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    state.installed = true;
    state.gpu = "cpu";
    state.fail = undefined;
    state.tts.length = 0;
    state.rvc.length = 0;
    state.cancels.length = 0;
    state.hold = false;
    state.release = undefined;
  });

  const gate = () => createConsentGate(app.ctx.db, storage);
  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      15_000,
    );
    return app.ctx.jobs.get(id)!;
  };
  const tts = (body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: API_ROUTES.tts,
      payload: { provider: "chatterbox", text: "Hola, che. ¿Cómo andás?", ...body },
    });

  let seq = 0;
  /** A Person (M1's repo) with a voice sample on disk and the given consents. */
  function addPerson(
    scope: "face" | "voice" | "both" | undefined,
    opts: { revoked?: boolean; samples?: boolean; expired?: boolean } = {},
  ): Person {
    const id = `p${++seq}`;
    const sampleRel = `consent/persons/${id}/voice/s1.wav`;
    if (opts.samples !== false) {
      mkdirSync(path.dirname(path.join(storage, sampleRel)), { recursive: true });
      writeFileSync(path.join(storage, sampleRel), wav(6));
    }
    const hash = "a".repeat(64);
    const person: Person = {
      id,
      name: `Persona ${id}`,
      photos: [],
      voiceSamples:
        opts.samples === false ? [] : [{ id: "s1", path: sampleRel, sha256: hash, durationSec: 6 }],
      consents: scope
        ? [
            {
              id: `c${id}`,
              personId: id,
              text_version: "2026-10-06",
              text_sha256: hash,
              accepted_at: now(),
              method: "firma en pantalla",
              signer_name: `Persona ${id}`,
              evidence_path: `consent/persons/${id}/consents/c${id}/evidence.png`,
              evidence_sha256: hash,
              scope,
              ...(opts.revoked && { revoked_at: now() }),
              ...(opts.expired && { expires_at: "2020-01-01T00:00:00.000Z" }),
            },
          ]
        : [],
      createdAt: now(),
      updatedAt: now(),
    };
    return gate().persons.insert(person);
  }

  function addSelfRef(id = `self${++seq}`): MediaAsset {
    const rel = `media/${id}.wav`;
    writeFileSync(path.join(storage, rel), wav(8));
    return app.ctx.repos.media.insert({
      id,
      kind: "voice-ref",
      name: "Voz propia (test)",
      path: rel,
      sizeBytes: 1,
      durationSec: 8,
      // in the past but increasing: «latest» is well defined and real uploads are newer
      createdAt: new Date(Date.now() - 3_600_000 + seq * 1000).toISOString(),
    });
  }

  // --------------------------------------------------------------------------- listing

  it("lists Chatterbox with its pack state; default per decision 10", async () => {
    state.installed = false;
    let rows = (await app.inject({ url: API_ROUTES.ttsProviders })).json<TtsProviderInfo[]>();
    let cb = rows.find((p) => p.id === "chatterbox")!;
    expect(cb).toMatchObject({
      enabled: false,
      status: "falta paquete",
      packId: "tts-chatterbox",
      installed: false,
      supportsClone: true,
      gpu: true,
      default: false,
    });
    expect(rows[0]).toMatchObject({ id: "piper", default: true });
    expect(rows.map((p) => p.id)).toEqual(["piper", "elevenlabs", "openai", "chatterbox"]);
    // pack installed but CPU mode: Piper stays the default
    state.installed = true;
    rows = (await app.inject({ url: API_ROUTES.ttsProviders })).json<TtsProviderInfo[]>();
    expect(rows.find((p) => p.id === "chatterbox")).toMatchObject({
      enabled: true,
      status: "local",
      models: ["mtl-v3"],
      default: false,
    });
    state.gpu = "gpu";
    rows = (await app.inject({ url: API_ROUTES.ttsProviders })).json<TtsProviderInfo[]>();
    cb = rows.find((p) => p.id === "chatterbox")!;
    expect(cb.default).toBe(true);
    expect(rows[0]!.default).toBe(false);
    const voices = (await app.inject({ url: API_ROUTES.ttsVoices })).json<TtsVoiceInfo[]>();
    expect(voices.find((v) => v.provider === "chatterbox")).toEqual({
      provider: "chatterbox",
      id: "chatterbox:multilingual",
      name: "Chatterbox multilingüe",
      language: "es",
      installed: true,
    });
  });

  // --------------------------------------------------------------------------- preflight

  it("409 PACK_REQUIRED without the pack", async () => {
    state.installed = false;
    const res = await tts({ voice: "chatterbox:multilingual" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "tts-chatterbox" });
    expect(state.tts).toHaveLength(0);
  });

  it("400 for long text, unknown voice or language", async () => {
    const long = await tts({ voice: "chatterbox:multilingual", text: "a".repeat(5001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe("TEXT_TOO_LONG");
    expect((await tts({ voice: "nope" })).json().error.code).toBe("BAD_VOICE");
    const lang = await tts({ voice: "chatterbox:multilingual", language: "xx" });
    expect(lang.json().error.code).toBe("BAD_LANGUAGE");
  });

  it("consent gate: 403 without voice consent / revoked / expired, 404, 409 without sample", async () => {
    const faceOnly = addPerson("face");
    let res = await tts({ voice: `chatterbox:person:${faceOnly.id}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: "CONSENT_REQUIRED",
      details: { personId: faceOnly.id, scope: "voice", reason: "scope" },
    });
    expect(res.json().error.message).toContain("voz");
    const revoked = addPerson("voice", { revoked: true });
    res = await tts({ voiceRef: { personId: revoked.id }, voice: "chatterbox:multilingual" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe("revoked");
    const expired = addPerson("both", { expired: true });
    res = await tts({ voice: `chatterbox:person:${expired.id}` });
    expect(res.json().error.details.reason).toBe("expired");
    const none = addPerson(undefined);
    res = await tts({ voice: `chatterbox:person:${none.id}` });
    expect(res.json().error.details.reason).toBe("none");
    res = await tts({ voice: "chatterbox:person:nadie" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("PERSON_NOT_FOUND");
    const noSample = addPerson("voice", { samples: false });
    res = await tts({ voice: `chatterbox:person:${noSample.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("VOICE_SAMPLE_MISSING");
    expect(state.tts).toHaveLength(0);
  });

  it("«Voz propia»: asset must be a voice-ref; chatterbox:self needs one", async () => {
    const audio = app.ctx.repos.media.insert({
      id: `aud${++seq}`,
      kind: "audio",
      name: "Música",
      path: "media/x.wav",
      sizeBytes: 1,
      createdAt: now(),
    });
    let res = await tts({ voice: "chatterbox:self", voiceRef: { assetId: audio.id, self: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_VOICE_REF");
    res = await tts({ voice: "x", voiceRef: { assetId: "missing", self: true } });
    expect(res.statusCode).toBe(404);
    // no «Voz propia» yet (other tests add some later: this one runs first in the file order)
    if (app.ctx.repos.media.list({ kind: "voice-ref" }).length === 0) {
      res = await tts({ voice: "chatterbox:self" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("VOICE_SAMPLE_MISSING");
    }
  });

  // --------------------------------------------------------------------------- jobs

  it("synthetic voice: defaults to the workers, asset voice-synthetic, result fields", async () => {
    const res = await tts({ voice: "chatterbox:multilingual" });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(state.tts[0]).toMatchObject({
      provider: "chatterbox",
      language: "es",
      exaggeration: 0.5,
      cfg: 0.5,
      temperature: 0.8,
      outputPath: `renders/${job.id}.wav`,
      jobId: job.id,
    });
    expect(state.tts[0]).not.toHaveProperty("voiceRef");
    const result = job.result as AudioJobResult;
    expect(result).toMatchObject({
      provider: "chatterbox",
      device: "cpu",
      aiVoice: "synthetic",
      watermark: "perth",
      rtf: 1.7,
      warnings: ["chatterbox_cpu_slow"],
    });
    const asset = app.ctx.repos.media.get(result.assetId!)!;
    expect(asset.aiAltered).toBe(true);
    expect(asset.aiProvenance).toMatchObject({
      kind: "voice-synthetic",
      tool: "chatterbox mtl-v3",
      jobId: job.id,
    });
    expect(asset.aiProvenance).not.toHaveProperty("personId");
  });

  it("clone of a Person: consented sample to the workers, voice-cloned + audit", async () => {
    const p = addPerson("both");
    const res = await tts({ voice: `chatterbox:person:${p.id}`, cfg: 0.3, exaggeration: 0.7 });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(state.tts[0]).toMatchObject({
      voiceRef: { path: `consent/persons/${p.id}/voice/s1.wav`, consent: `c${p.id}` },
      cfg: 0.3,
      exaggeration: 0.7,
    });
    const result = job.result as AudioJobResult;
    expect(result.aiVoice).toBe("cloned");
    const asset = app.ctx.repos.media.get(result.assetId!)!;
    expect(asset.aiProvenance).toMatchObject({
      kind: "voice-cloned",
      personId: p.id,
      consentId: `c${p.id}`,
      jobId: job.id,
    });
    // audit fix 22: never the Persona's name in the asset name, nor consent/ paths in the logs
    expect(asset.name).toContain("Voz clonada (Persona)");
    expect(asset.name).not.toContain(p.name);
    const logs = JSON.stringify(app.ctx.jobs.get(job.id));
    expect(logs).not.toContain("consent/persons");
    const audit = gate().auditLog.list({ action: "voice.clone", personId: p.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ jobId: job.id, assetId: asset.id, consentId: `c${p.id}` });
  });

  it("canceling the job stops Chatterbox in the workers (POST /tts/cancel, audit fix 8)", async () => {
    state.hold = true;
    const res = await tts({ voice: "chatterbox:multilingual", text: "Un texto largo." });
    expect(res.statusCode).toBe(202);
    const id = res.json().jobId as string;
    await waitFor(() => state.tts.length === 1, 10_000);
    const cancel = await app.inject({ method: "POST", url: `/api/jobs/${id}/cancel` });
    expect(cancel.statusCode).toBeLessThan(300);
    const job = await jobEnd(id);
    expect(job.status).toBe("canceled");
    await waitFor(() => state.cancels.length === 1, 5_000);
    expect(state.cancels[0]).toEqual({ jobId: id });
  });

  it("a coded workers error keeps its code and details (shared client, open point C)", async () => {
    state.fail = {
      status: 502,
      body: {
        detail: "Chatterbox terminó con error: CUDA.",
        code: "TOOL_FAILED",
        details: { logTail: ["x", "consent/persons/p1/voice/s1.wav"], tool: "chatterbox" },
      },
    };
    const res = await tts({ voice: "chatterbox:multilingual" });
    const job = await jobEnd(res.json().jobId);
    expect(job.status).toBe("failed");
    expect(job.result).toMatchObject({
      error: { code: "TOOL_FAILED", details: { tool: "chatterbox" } },
    });
  });

  it("clone of «Voz propia» (latest voice-ref, as the Assistant's tts op sends it)", async () => {
    addSelfRef();
    const latest = addSelfRef();
    // the Assistant's op tts with voice chatterbox:self (agent.ts sets provider chatterbox)
    const res = await tts({ voice: "chatterbox:self", text: "Hola desde el asistente" });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(state.tts[0]).toMatchObject({ voiceRef: { path: latest.path, consent: "self" } });
    const asset = app.ctx.repos.media.get((job.result as AudioJobResult).assetId!)!;
    expect(asset.aiProvenance).toMatchObject({
      kind: "voice-cloned",
      self: true,
      sourceAssetId: latest.id,
    });
    expect(asset.aiProvenance).not.toHaveProperty("personId");
  });

  it("a consent revoked after enqueueing blocks the job when it starts", async () => {
    const p = addPerson("voice");
    const deps = { ...app.ctx } as unknown as VoiceAiDeps;
    const handler = createTtsHandler(deps);
    const payload = handler.parse({
      provider: "chatterbox",
      text: "Hola",
      voice: `chatterbox:person:${p.id}`,
    });
    const stored = gate().persons.get(p.id)!;
    gate().persons.save({
      ...stored,
      consents: stored.consents.map((c) => ({ ...c, revoked_at: now() })),
    });
    const err = (await handler
      .run(
        payload,
        {
          jobId: "jr1",
          signal: new AbortController().signal,
          reportProgress: () => undefined,
          log: () => undefined,
          storageDir: storage,
        },
        { id: "jr1" } as Job,
      )
      .catch((e: unknown) => e)) as { code?: string; jobResult?: unknown };
    expect(err.code).toBe("CONSENT_REQUIRED");
    expect(err.jobResult).toMatchObject({
      error: { code: "CONSENT_REQUIRED", details: { reason: "revoked" } },
    });
    expect(state.tts).toHaveLength(0);
  });

  it("TOOL_FAILED from the workers fails the job with the code and log tail", async () => {
    state.fail = {
      status: 502,
      body: {
        detail: "Chatterbox terminó con error: CUDA error.",
        code: "TOOL_FAILED",
        details: { logTail: ["linea 1", "CUDA error"], tool: "chatterbox" },
      },
    };
    const res = await tts({ voice: "chatterbox:multilingual" });
    const job = await jobEnd(res.json().jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("Chatterbox terminó con error");
    expect(job.result).toMatchObject({
      error: { code: "TOOL_FAILED", details: { logTail: ["linea 1", "CUDA error"] } },
    });
  });

  it("Piper and the cloud voices are voice-synthetic too", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.tts,
      payload: { text: "Hola", voice: "es_AR-daniela-high" },
    });
    const job = await jobEnd(res.json().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const result = job.result as AudioJobResult;
    expect(result).toMatchObject({ provider: "piper", aiVoice: "synthetic" });
    expect(state.tts[0]).not.toHaveProperty("language");
    expect(app.ctx.repos.media.get(result.assetId!)?.aiProvenance).toMatchObject({
      kind: "voice-synthetic",
      tool: "piper es_AR-daniela-high",
    });
  });

  it("RVC returns the device; inherits a voice provenance; a real voice becomes cloned", async () => {
    const src = app.ctx.repos.media.insert({
      id: `clon${++seq}`,
      kind: "audio",
      name: "Voz clonada",
      path: `renders/clon${seq}.wav`,
      sizeBytes: 1,
      aiAltered: true,
      aiProvenance: {
        kind: "voice-cloned",
        tool: "chatterbox mtl-v3",
        personId: "p9",
        consentId: "c9",
        jobId: "j9",
        createdAt: now(),
      },
      createdAt: now(),
    });
    writeFileSync(path.join(storage, src.path), wav(1));
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.rvc,
      payload: { assetId: src.id, modelId: "mi_voz" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = await jobEnd(res.json().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const result = job.result as AudioJobResult;
    expect(result.device).toBe("cuda");
    const out = app.ctx.repos.media.get(result.assetId!)!;
    expect(out.aiAltered).toBe(true);
    expect(out.aiProvenance).toMatchObject({
      kind: "voice-cloned",
      personId: "p9",
      sourceAssetId: src.id,
    });
    // a plain recording stays unmarked
    const plain = app.ctx.repos.media.insert({
      id: `rec${++seq}`,
      kind: "audio",
      name: "Grabación",
      path: `renders/rec${seq}.wav`,
      sizeBytes: 1,
      createdAt: now(),
    });
    writeFileSync(path.join(storage, plain.path), wav(1));
    const r2 = await app.inject({
      method: "POST",
      url: API_ROUTES.rvc,
      payload: { assetId: plain.id, modelId: "mi_voz" },
    });
    const j2 = await jobEnd(r2.json().jobId);
    const out2 = app.ctx.repos.media.get((j2.result as AudioJobResult).assetId!)!;
    // open point B: a real recording converted to another voice is a cloned voice
    expect(out2.aiAltered).toBe(true);
    expect(out2.aiProvenance).toMatchObject({
      kind: "voice-cloned",
      tool: "rvc:mi_voz",
      jobId: j2.id,
      sourceAssetId: plain.id,
    });
    // a synthetic (TTS) source keeps «voice-synthetic»
    const tts = app.ctx.repos.media.insert({
      id: `tts${++seq}`,
      kind: "audio",
      name: "Voz Piper",
      path: `renders/tts${seq}.wav`,
      sizeBytes: 1,
      aiAltered: true,
      aiProvenance: { kind: "voice-synthetic", tool: "piper es_AR", createdAt: now() },
      createdAt: now(),
    });
    writeFileSync(path.join(storage, tts.path), wav(1));
    const r3 = await app.inject({
      method: "POST",
      url: API_ROUTES.rvc,
      payload: { assetId: tts.id, modelId: "mi_voz" },
    });
    const j3 = await jobEnd(r3.json().jobId);
    const out3 = app.ctx.repos.media.get((j3.result as AudioJobResult).assetId!)!;
    expect(out3.aiProvenance).toMatchObject({ kind: "voice-synthetic", sourceAssetId: tts.id });
  });

  // --------------------------------------------------------------------------- self-refs

  it("self-refs: HUMAN_ONLY (fix 1): no web Origin or studio-mcp -> 403", async () => {
    const cases: Record<string, string>[] = [
      {},
      { origin: "http://localhost:3000", "x-studio-client": "mcp" },
    ];
    for (const headers of cases) {
      const res = await inject(
        app,
        API_ROUTES.voiceSelfRefs,
        form({ attestSelf: "true" }, { name: "voz.wav", data: wav(8) }),
        headers,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("HUMAN_ONLY");
    }
  });

  it("self-refs: attestSelf is mandatory", async () => {
    const res = await inject(
      app,
      API_ROUTES.voiceSelfRefs,
      form({}, { name: "voz.wav", data: wav(8) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ATTEST_SELF_REQUIRED");
    const noFile = await inject(app, API_ROUTES.voiceSelfRefs, form({ attestSelf: "true" }));
    expect(noFile.statusCode).toBe(400);
  });

  it("self-refs: > 25 MB is 413", async () => {
    const res = await inject(
      app,
      API_ROUTES.voiceSelfRefs,
      form({ attestSelf: "true" }, { name: "big.wav", data: Buffer.alloc(26 * 1024 * 1024) }),
    );
    expect(res.statusCode).toBe(413);
  });

  it.skipIf(!hasFfmpeg)(
    "self-refs: 5–60 s with voice → voice-ref WAV 24 kHz mono ≤ 30 s; listed; deletable",
    async () => {
      const ok = await inject(
        app,
        API_ROUTES.voiceSelfRefs,
        form({ attestSelf: "true" }, { name: "mi voz.wav", data: wav(10, { rate: 44_100 }) }),
      );
      expect(ok.statusCode, ok.body).toBe(201);
      const asset = ok.json<MediaAsset>();
      expect(asset).toMatchObject({ kind: "voice-ref", sampleRate: 24000, channels: 1 });
      expect(asset.name).toMatch(/^Voz propia \(\d\d\/\d\d\/\d{4} \d\d:\d\d\)$/);
      expect(asset.path).toMatch(/^media\/.+\.wav$/);
      expect(asset.durationSec!).toBeGreaterThan(9);
      expect(asset.durationSec!).toBeLessThanOrEqual(10.1);
      expect(asset.aiAltered).toBeUndefined();
      expect(asset).not.toHaveProperty("sha256");
      // fix 1: the «Soy yo» declaration is audited with the sha256 of the stored sample
      const { createHash } = await import("node:crypto");
      const { readFileSync } = await import("node:fs");
      const attest = createConsentGate(app.ctx.db, storage).auditLog.list({
        action: "voice.self.attest",
      });
      expect(attest[0]).toMatchObject({
        assetId: asset.id,
        data: {
          sha256: createHash("sha256")
            .update(readFileSync(path.join(storage, asset.path)))
            .digest("hex"),
        },
      });
      const probe = spawnSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=sample_rate,channels",
        "-of",
        "csv=p=0",
        path.join(storage, asset.path),
      ]);
      expect(probe.stdout.toString().trim()).toBe("24000,1");
      // longer than 30 s: kept 30 s
      const long = await inject(
        app,
        API_ROUTES.voiceSelfRefs,
        form({ attestSelf: "true" }, { name: "larga.wav", data: wav(40) }),
      );
      expect(long.statusCode, long.body).toBe(201);
      expect(long.json<MediaAsset>().durationSec!).toBeLessThanOrEqual(30.05);
      const list = (await app.inject({ url: API_ROUTES.voiceSelfRefs })).json<MediaAsset[]>();
      expect(list[0]!.id).toBe(long.json<MediaAsset>().id);
      expect(list.every((a) => a.kind === "voice-ref")).toBe(true);
      // never probed (media.probe would turn it into "audio")
      await new Promise((r) => setTimeout(r, 300));
      expect(app.ctx.repos.media.get(asset.id)?.kind).toBe("voice-ref");
      const del = await app.inject({ method: "DELETE", url: `/api/media/${asset.id}` });
      expect(del.statusCode).toBeLessThan(300);
      expect(app.ctx.repos.media.get(asset.id)).toBeUndefined();
    },
    30_000,
  );

  it.skipIf(!hasFfmpeg)(
    "self-refs: < 5 s, > 60 s, silence or not audio → 400 VOICE_SAMPLE_INVALID",
    async () => {
      for (const data of [wav(3), wav(65), wav(10, { amp: 0 }), Buffer.from("no soy audio")]) {
        const res = await inject(
          app,
          API_ROUTES.voiceSelfRefs,
          form({ attestSelf: "true" }, { name: "x.wav", data }),
        );
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error.code).toBe("VOICE_SAMPLE_INVALID");
      }
    },
    60_000,
  );
});
