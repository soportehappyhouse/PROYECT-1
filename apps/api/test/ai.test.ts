import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  ProjectSchema,
  type ApplyCutsResult,
  type Job,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { packRequiredFromBody } from "../src/services/workers-client.js";
import { applyCuts } from "../src/services/timeline-edit.js";
import { makeApp, waitFor } from "./helpers.js";

/** Sprint 1 /api/ai/* routes and jobs against a fake workers service (contract of sprint1-contratos.md). */

interface Seen {
  silences?: Record<string, unknown>;
  denoise?: Record<string, unknown>;
}

describe("AI routes and jobs (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const seen: Seen = {};
  const state = { scenesInstalled: false, scenesWorkerPackError: false, polls: 0 };
  const PACKS = () => [
    {
      id: "core",
      name_es: "Núcleo",
      description_es: "",
      size_bytes: 3e8,
      installed: true,
      partial: false,
      files: [],
      required_by: ["transcribir"],
      license: "MIT",
      group: "base",
    },
    {
      id: "whisper-turbo",
      name_es: "Whisper turbo",
      description_es: "",
      size_bytes: 1.6e9,
      installed: false,
      partial: false,
      files: [],
      required_by: ["transcribir"],
      license: "MIT",
      group: "voz",
    },
    {
      id: "scenes",
      name_es: "Escenas",
      description_es: "",
      size_bytes: 5e7,
      installed: state.scenesInstalled,
      partial: false,
      files: [],
      required_by: ["escenas"],
      license: null,
      group: null,
    },
    {
      id: "voz-limpia",
      name_es: "Voz limpia",
      description_es: "",
      size_bytes: 2e8,
      installed: true,
      partial: false,
      files: [],
      required_by: ["denoise"],
      license: "MIT",
      group: "voz",
    },
  ];

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
        switch (`${req.method} ${req.url}`) {
          case "GET /gpu/status":
            return send(200, {
              cuda: true,
              gpu_name: "RTX 4050",
              vram_total_mb: 6144,
              vram_free_mb: 5000,
              resident_model: "whisper",
              mode: "gpu",
              sysmem_fallback: false,
            });
          case "POST /gpu/release":
            return send(200, { released: "whisper" });
          case "GET /packs":
            return send(200, PACKS());
          case "POST /packs/whisper-turbo/download":
            return send(200, { task_id: "t1" });
          case "GET /packs/tasks/t1": {
            state.polls++;
            return send(
              200,
              state.polls < 2
                ? {
                    status: "running",
                    progress: 0.5,
                    bytes_done: 8e8,
                    bytes_total: 1.6e9,
                    current_file: "model.bin",
                    error: null,
                  }
                : {
                    status: "done",
                    progress: 1,
                    bytes_done: 1.6e9,
                    bytes_total: 1.6e9,
                    current_file: null,
                    error: null,
                  },
            );
          }
          case "POST /analyze/scenes":
            if (state.scenesWorkerPackError)
              return send(409, {
                detail: {
                  error: "PACK_REQUIRED",
                  packId: "scenes",
                  name_es: "Escenas",
                  size_bytes: 5e7,
                },
              });
            return send(200, {
              scenes: [
                { start: 4, end: 8, score: 30 },
                { start: 0, end: 4, score: 0 },
              ],
            });
          case "POST /analyze/silences":
            seen.silences = json;
            return send(200, {
              cuts: [
                { start: 0.2, end: 0.9, kind: "silence" }, // before clip.in (1): dropped
                { start: 2, end: 2.6, kind: "filler", text: "eh" },
                { start: 4.5, end: 6, kind: "silence" }, // clamped to out (5)
              ],
              total_removed_s: 2.8,
            });
          case "POST /audio/denoise": {
            seen.denoise = json;
            const rel = `${String(json.output_base)}.wav`;
            writeFileSync(path.join(storage, rel), "RIFF");
            return send(200, { path: rel });
          }
          case "POST /perf/run":
            setTimeout(() => {
              mkdirSync(path.join(storage, "run"), { recursive: true });
              writeFileSync(
                path.join(storage, "run/perf.json"),
                JSON.stringify({
                  gpu: "RTX 4050",
                  whisper_turbo_s_per_min: 4.2,
                  piper_s_per_100chars: 0.3,
                  scenes_fps: 240,
                  cpu_fallback_ok: true,
                  ran_at: "2026-10-05T12:00:00Z",
                }),
              );
            }, 150);
            return send(200, { task_id: "p1" });
          default:
            return send(404, { detail: "Not Found" });
        }
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

  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      15_000,
    );
    return app.ctx.jobs.get(id)!;
  };
  const addAsset = (id: string, kind: "video" | "audio" = "video"): MediaAsset => {
    const rel = `media/${id}.mp4`;
    writeFileSync(path.join(storage, rel), "x");
    return app.ctx.repos.media.insert({
      id,
      kind,
      name: `Clip ${id}`,
      path: rel,
      sizeBytes: 1,
      durationSec: 10,
      hasAudio: true,
      hasVideo: kind === "video",
      createdAt: new Date().toISOString(),
    });
  };

  it("proxies GPU status and release", async () => {
    const gpu = await app.inject({ method: "GET", url: API_ROUTES.aiGpu });
    expect(gpu.statusCode).toBe(200);
    expect(gpu.json()).toMatchObject({ cuda: true, mode: "gpu", resident_model: "whisper" });
    const rel = await app.inject({ method: "POST", url: API_ROUTES.aiGpuRelease });
    expect(rel.statusCode).toBe(200);
    expect(rel.json()).toMatchObject({ mode: "gpu" });
  });

  it("lists packs and downloads one as a job with SSE progress", async () => {
    const list = await app.inject({ method: "GET", url: API_ROUTES.aiPacks });
    expect(list.json<{ id: string }[]>().map((p) => p.id)).toContain("whisper-turbo");
    const messages: string[] = [];
    app.ctx.queue.on("job", (e) => e.message && messages.push(e.message));
    const unknown = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.aiPackDownload, { id: "nope" }),
    });
    expect(unknown.statusCode).toBe(404);
    const res = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.aiPackDownload, { id: "whisper-turbo" }),
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    // a second click reuses the running download
    const again = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.aiPackDownload, { id: "whisper-turbo" }),
    });
    expect(again.json<{ jobId: string }>().jobId).toBe(jobId);
    const job = await jobEnd(jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(job.result).toEqual({ packId: "whisper-turbo", installed: true });
    expect(messages.some((m) => m.startsWith("Descargando «Whisper turbo» 50 %"))).toBe(true);
  });

  it("answers 409 PACK_REQUIRED before enqueueing and fails the job with the same body", async () => {
    const asset = addAsset("sc1");
    const pre = await app.inject({
      method: "POST",
      url: API_ROUTES.aiAnalyzeScenes,
      payload: { assetId: asset.id },
    });
    expect(pre.statusCode).toBe(409);
    expect(pre.json()).toMatchObject({
      error: "PACK_REQUIRED",
      packId: "scenes",
      name_es: "Escenas",
      size_bytes: 5e7,
    });

    // Pack listed as installed but the worker still reports it missing: the job fails with the body.
    state.scenesInstalled = true;
    state.scenesWorkerPackError = true;
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.aiAnalyzeScenes,
      payload: { assetId: asset.id },
    });
    expect(res.statusCode).toBe(202);
    const failed = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({
      error: "PACK_REQUIRED",
      packId: "scenes",
      size_bytes: 5e7,
    });
    expect(failed.error).toMatch(/Escenas/);

    state.scenesWorkerPackError = false;
    const ok = await app.inject({
      method: "POST",
      url: API_ROUTES.aiAnalyzeScenes,
      payload: { assetId: asset.id },
    });
    const job = await jobEnd(ok.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(job.result).toEqual({
      assetId: asset.id,
      scenes: [
        { start: 0, end: 4, score: 0 },
        { start: 4, end: 8, score: 30 },
      ],
    });
    expect(app.ctx.repos.media.get(asset.id)?.scenes).toHaveLength(2);
  });

  const makeProject = async (assetId: string): Promise<Project> => {
    const created = (
      await app.inject({ method: "POST", url: API_ROUTES.projects, payload: { name: "Cortes" } })
    ).json<Project>();
    const [video, text] = created.tracks;
    const body = {
      ...created,
      subtitles: [
        {
          start: 0,
          end: 4,
          text: "eh hola che",
          words: [
            { start: 1, end: 1.6, word: " eh" },
            { start: 1.7, end: 2.2, word: " hola" },
            { start: 3, end: 3.5, word: " che" },
          ],
        },
      ],
      tracks: [
        {
          ...video!,
          clips: [
            { id: "c1", trackId: video!.id, assetId, start: 0, in: 1, out: 5 },
            { id: "c2", trackId: video!.id, assetId, start: 4, in: 5, out: 7 },
          ],
        },
        {
          ...text!,
          clips: [{ id: "t1", trackId: text!.id, start: 5, in: 0, out: 1, text: "Después" }],
        },
        { id: "mo", kind: "motion", name: "Motion", clips: [] },
      ],
    };
    const saved = await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: created.id }),
      payload: body,
    });
    expect(saved.statusCode).toBe(200);
    return saved.json<Project>();
  };

  it("analyze.silences proposes cuts inside the clip (source time) with the subtitle words", async () => {
    const asset = addAsset("si1");
    const project = await makeProject(asset.id);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.aiAnalyzeSilences,
      payload: { projectId: project.id, clipId: "c1" },
    });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(job.result).toMatchObject({
      clipId: "c1",
      assetId: asset.id,
      timeBase: "source",
      cuts: [
        { start: 2, end: 2.6, kind: "filler", text: "eh" },
        { start: 4.5, end: 5, kind: "silence" },
      ],
      total_removed_s: 1.1,
    });
    expect(seen.silences).toMatchObject({
      path: asset.path,
      min_silence_ms: 500,
      noise_db: -35,
      padding_ms: 120,
      fillers: true,
    });
    // words of the clip in source seconds (timeline 1..1.6 -> source 2..2.6)
    expect((seen.silences!.transcript as { words: unknown[] }).words[0]).toEqual({
      w: "eh",
      s: 2,
      e: 2.6,
    });
    // the project is untouched
    expect(app.ctx.repos.projects.get(project.id)!.tracks[0]!.clips).toHaveLength(2);
  });

  it("timeline.apply-cuts splits, ripples and saves the project", async () => {
    const asset = addAsset("ap1");
    const project = await makeProject(asset.id);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.aiApplyCuts,
      payload: {
        projectId: project.id,
        clipId: "c1",
        cuts: [
          { start: 2, end: 2.6 },
          { start: 4.5, end: 5 },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const result = job.result as ApplyCutsResult;
    expect(result.removedSec).toBeCloseTo(1.1, 6);
    const v = result.project.tracks[0]!.clips;
    expect(v.map((c) => [c.start, c.in, c.out])).toEqual([
      [0, 1, 2],
      [1, 2.6, 4.5],
      [2.9, 5, 7],
    ]);
    expect(v[0]!.id).toBe("c1");
    expect(result.project.tracks[1]!.clips[0]!.start).toBeCloseTo(3.9, 6);
    expect(app.ctx.repos.projects.get(project.id)!.tracks[0]!.clips).toHaveLength(3);
    // words in a removed range disappear; later words ripple
    expect(result.project.subtitles[0]!.words!.map((w) => w.word)).toEqual([" hola", " che"]);
  });

  it("audio.denoise creates a new audio asset (+ probe)", async () => {
    const asset = addAsset("dn1", "audio");
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.aiDenoise,
      payload: { assetId: asset.id },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    const job = await jobEnd(jobId);
    expect(job.status, job.error).toBe("succeeded");
    const out = job.result as { assetId: string; path: string };
    expect(seen.denoise).toEqual({ path: asset.path, output_base: `renders/${jobId}` });
    expect(app.ctx.repos.media.get(out.assetId)).toMatchObject({
      kind: "audio",
      path: `renders/${jobId}.wav`,
      name: "Clip dn1 (voz limpia)",
    });
    expect(
      app.ctx.jobs
        .list({ type: "media.probe" })
        .some((j) => (j.payload as { assetId: string }).assetId === out.assetId),
    ).toBe(true);
  });

  it("perf.run waits for storage/run/perf.json; GET /api/ai/perf returns it", async () => {
    expect((await app.inject({ method: "GET", url: API_ROUTES.aiPerf })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: API_ROUTES.aiPerfRun });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(job.result).toMatchObject({ gpu: "RTX 4050", whisper_turbo_s_per_min: 4.2 });
    const last = await app.inject({ method: "GET", url: API_ROUTES.aiPerf });
    expect(last.json()).toMatchObject({ scenes_fps: 240, ran_at: "2026-10-05T12:00:00Z" });
  });

  it("persists project.publish", async () => {
    const created = (
      await app.inject({ method: "POST", url: API_ROUTES.projects, payload: { name: "Redes" } })
    ).json<Project>();
    const publish = {
      forSocial: true,
      flags: { aiFace: false, aiVoice: true, aiOther: false, music: true, thirdParty: false },
      aiLabel: true,
      aiLabelText: "Voz generada con IA",
    };
    const saved = await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: created.id }),
      payload: { ...created, publish },
    });
    expect(saved.json<Project>().publish).toEqual(publish);
    const got = await app.inject({
      method: "GET",
      url: buildRoute(API_ROUTES.project, { id: created.id }),
    });
    expect(got.json<Project>().publish).toEqual(publish);
  });
});

describe("workers PACK_REQUIRED parsing", () => {
  it("finds the payload at the top level, in FastAPI detail or in error.details", () => {
    const body = { packId: "voz-limpia", name_es: "Voz limpia", size_bytes: 2e8 };
    const expected = { error: "PACK_REQUIRED", ...body };
    expect(packRequiredFromBody({ error: "PACK_REQUIRED", ...body })).toEqual(expected);
    expect(packRequiredFromBody({ detail: { code: "PACK_REQUIRED", ...body } })).toEqual(expected);
    expect(
      packRequiredFromBody({ error: { code: "PACK_REQUIRED", message: "x", details: body } }),
    ).toEqual(expected);
    expect(packRequiredFromBody({ detail: { error: "PACK_REQUIRED", pack_id: "scenes" } })).toEqual(
      { error: "PACK_REQUIRED", packId: "scenes", name_es: "scenes", size_bytes: 0 },
    );
    expect(packRequiredFromBody({ detail: "nope" })).toBeUndefined();
  });
});

describe("applyCuts (pure)", () => {
  const now = "2026-10-05T00:00:00.000Z";
  const base = ProjectSchema.parse({
    id: "p",
    name: "p",
    settings: {},
    createdAt: now,
    updatedAt: now,
    subtitles: [
      { start: 1.2, end: 1.8, text: "solo silencio" },
      { start: 6, end: 7, text: "después" },
    ],
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "V",
        clips: [
          {
            id: "a",
            trackId: "v",
            assetId: "x",
            start: 0,
            in: 10,
            out: 15,
            speed: 2,
            transitionIn: { type: "fade", durationSec: 0.3 },
            transitionOut: { type: "fade", durationSec: 0.3 },
          },
          { id: "b", trackId: "v", assetId: "x", start: 3, in: 0, out: 2 },
        ],
      },
      {
        id: "m",
        kind: "motion",
        name: "M",
        clips: [
          {
            id: "cap",
            trackId: "m",
            start: 0,
            in: 0,
            out: 2.5,
            renderedAssetId: "r1",
            motion: {
              template: "animated-captions",
              durationSec: 2.5,
              props: {
                transcript: {
                  durationSec: 2.5,
                  segments: [
                    {
                      start: 0.1,
                      end: 2.4,
                      text: "uno dos",
                      words: [
                        { start: 0.1, end: 0.9, word: "uno" },
                        { start: 2.1, end: 2.4, word: "dos" },
                      ],
                    },
                  ],
                },
              },
            },
          },
          {
            id: "title",
            trackId: "m",
            start: 1.2,
            in: 0,
            out: 1,
            renderedAssetId: "r2",
            motion: { template: "title-card", durationSec: 1 },
          },
        ],
      },
      {
        id: "au",
        kind: "audio",
        name: "A",
        clips: [{ id: "mus", trackId: "au", assetId: "m", start: 4, in: 0, out: 3 }],
      },
    ],
  });
  let n = 0;
  const id = () => `n${++n}`;

  it("cuts a sped-up clip, keeps edge transitions, re-times linked captions and ripples", () => {
    // source 12..14 = timeline 1..2 at speed 2
    const out = applyCuts(base, "a", [{ start: 12, end: 14 }], id);
    expect(out.removedSec).toBeCloseTo(1, 6);
    const [a1, a2, b] = out.project.tracks[0]!.clips;
    expect(a1).toMatchObject({
      id: "a",
      start: 0,
      in: 10,
      out: 12,
      transitionIn: { durationSec: 0.3 },
    });
    expect(a1!.transitionOut).toBeUndefined();
    expect(a2).toMatchObject({ start: 1, in: 14, out: 15, transitionOut: { durationSec: 0.3 } });
    expect(a2!.transitionIn).toBeUndefined();
    expect(b).toMatchObject({ id: "b", start: 2 });
    const [cap, title] = out.project.tracks[1]!.clips;
    // animated captions: "dos" moved 1 s earlier, clip shortened, render dropped (must re-render)
    expect(cap!.renderedAssetId).toBeUndefined();
    expect(cap!.motion!.durationSec).toBeCloseTo(1.5, 6);
    const words = (
      cap!.motion!.props.transcript as { segments: { words: { start: number; word: string }[] }[] }
    ).segments[0]!.words;
    expect(words.map((w) => [w.word, w.start])).toEqual([
      ["uno", 0.1],
      ["dos", 1.1],
    ]);
    // other overlays snap to the next kept instant and keep their render
    expect(title).toMatchObject({ start: 1, renderedAssetId: "r2" });
    // audio tracks are left alone
    expect(out.project.tracks[2]!.clips[0]!.start).toBe(4);
    // subtitles: the one inside the cut disappears, the later one ripples
    expect(out.project.subtitles).toEqual([{ start: 5, end: 6, text: "después" }]);
  });

  it("rejects locked tracks and cuts outside the clip", () => {
    const locked = { ...base, tracks: base.tracks.map((t) => ({ ...t, locked: t.id === "v" })) };
    expect(() => applyCuts(locked, "a", [{ start: 12, end: 13 }], id)).toThrow(/bloqueada/);
    expect(() => applyCuts(base, "a", [{ start: 20, end: 21 }], id)).toThrow(/dentro del clip/);
    expect(() => applyCuts(base, "zz", [{ start: 1, end: 2 }], id)).toThrow(/no encontrado/);
  });
});
