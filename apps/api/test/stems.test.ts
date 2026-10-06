import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  ProjectSchema,
  STEMS_API_ROUTES,
  tracksInZOrder,
  type Job,
  type MediaAsset,
  type Project,
  type StemsResult,
} from "@studio/shared";
import { placeStems } from "../src/jobs/handlers/audio-stems.js";
import { makeApp, waitFor } from "./helpers.js";

/** Sprint 3b §C: job audio.stems + «Deshacer separación» against a fake workers service. */
describe("audio.stems (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const state = { installed: false, polls: 0, seen: [] as Record<string, unknown>[] };

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
              id: "stems",
              name_es: "Separar audio (Demucs htdemucs)",
              description_es: "",
              size_bytes: 86e6,
              installed: state.installed,
              partial: false,
              files: [],
              required_by: ["audio.stems"],
              license: "MIT",
              group: "audio",
            },
          ]);
        if (req.method === "POST" && url === "/audio/stems") {
          state.seen.push(json);
          const names =
            json.mode === "four" ? ["vocals", "drums", "bass", "other"] : ["vocals", "no_vocals"];
          const stems: Record<string, string> = {};
          for (const n of names) {
            stems[n] = `${String(json.output_base)}-${n}.wav`;
            mkdirSync(path.dirname(path.join(storage, stems[n])), { recursive: true });
            writeFileSync(path.join(storage, stems[n]), "RIFF");
          }
          state.polls = 0;
          (globalThis as { __stems?: unknown }).__stems = stems;
          return send(200, { task_id: `t-${String(json.mode)}`, status: "queued" });
        }
        if (req.method === "GET" && url.startsWith("/audio/tasks/")) {
          state.polls++;
          if (state.polls < 2)
            return send(200, { status: "running", progress: 0.5, message: "Separando tramo 1/2" });
          return send(200, {
            status: "done",
            progress: 1,
            result: {
              stems: (globalThis as { __stems?: unknown }).__stems,
              sample_rate: 44100,
              device: "cpu",
              segment: 7,
              chunks: 2,
              duration_s: 10,
              warnings: ["gpu_fallback_cpu"],
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

  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      15_000,
    );
    return app.ctx.jobs.get(id)!;
  };
  const addAsset = (id: string): MediaAsset => {
    const rel = `media/${id}.mp4`;
    writeFileSync(path.join(storage, rel), "x");
    return app.ctx.repos.media.insert({
      id,
      kind: "video",
      name: `Clip ${id}`,
      path: rel,
      sizeBytes: 1,
      durationSec: 10,
      hasAudio: true,
      hasVideo: true,
      createdAt: new Date().toISOString(),
    });
  };
  const makeProject = async (assetId: string): Promise<Project> => {
    const created = (
      await app.inject({ method: "POST", url: API_ROUTES.projects, payload: { name: "Stems" } })
    ).json<Project>();
    const [video, text] = created.tracks;
    const saved = await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: created.id }),
      payload: {
        ...created,
        tracks: [
          {
            ...video!,
            clips: [
              {
                id: "c1",
                trackId: video!.id,
                assetId,
                start: 2,
                in: 1.5,
                out: 6,
                volume: 0.8,
                transitionIn: { type: "fade", durationSec: 0.5 },
              },
            ],
          },
          text!,
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    return saved.json<Project>();
  };
  const stems = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: STEMS_API_ROUTES.stems, payload });

  it("validates the request and answers 409 PACK_REQUIRED before enqueueing", async () => {
    const asset = addAsset("s0");
    expect((await stems({})).statusCode).toBe(400);
    expect((await stems({ clipId: "c1" })).statusCode).toBe(400); // clipId needs target
    expect((await stems({ assetId: "nope" })).statusCode).toBe(404);
    const pre = await stems({ assetId: asset.id });
    expect(pre.statusCode).toBe(409);
    expect(pre.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "stems" });
    expect(state.seen).toHaveLength(0);
  });

  it("separates a clip into «Voz» + «Música» tracks aligned to it and mutes it; undo restores", async () => {
    state.installed = true;
    const asset = addAsset("s1");
    const project = await makeProject(asset.id);
    const missing = await stems({ clipId: "zz", target: { projectId: project.id } });
    expect(missing.statusCode).toBe(404);
    const res = await stems({ clipId: "c1", mode: "two", target: { projectId: project.id } });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    const job = await jobEnd(jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(state.seen.at(-1)).toEqual({
      path: asset.path,
      mode: "two",
      output_base: `renders/stems-${jobId}`,
    });
    const result = job.result as StemsResult;
    expect(result.stems.map((s) => s.label)).toEqual(["Voz", "Música"]);
    expect(result.warnings).toEqual(["gpu_fallback_cpu"]);
    expect(result.previousVolume).toBe(0.8);
    expect(result.undoSnapshotId).toBeTruthy();
    for (const s of result.stems) {
      expect(existsSync(path.join(storage, s.path))).toBe(true);
      const a = app.ctx.repos.media.get(s.assetId)!;
      expect(a.kind).toBe("audio");
      expect(a.sampleRate).toBe(44100);
    }

    const saved = ProjectSchema.parse(app.ctx.repos.projects.get(project.id));
    expect(saved.tracks.map((t) => t.name)).toEqual(["Video 1", "Voz", "Música", "Texto 1"]);
    const src = saved.tracks[0]!.clips[0]!;
    expect(src.volume).toBe(0);
    for (const t of saved.tracks.slice(1, 3)) {
      expect(t.kind).toBe("audio");
      const c = t.clips[0]!;
      expect(c).toMatchObject({ start: 2, in: 1.5, out: 6, speed: 1, volume: 0.8 });
      expect(c.transitionIn).toEqual({ type: "fade", durationSec: 0.5 });
      expect(result.stems.some((s) => s.clipId === c.id && s.trackId === t.id)).toBe(true);
    }

    // Edited after the separation: the undo asks first, force restores anyway.
    const edited = await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: project.id }),
      payload: { ...saved, name: "Editado" },
    });
    expect(edited.statusCode).toBe(200);
    const undo = (body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: STEMS_API_ROUTES.undo, payload: body });
    const conflict = await undo({ undoSnapshotId: result.undoSnapshotId });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "PROJECT_CHANGED" } });
    const forced = await undo({ undoSnapshotId: result.undoSnapshotId, force: true });
    expect(forced.statusCode).toBe(200);
    const restored = forced.json<{ project: Project }>().project;
    expect(restored.tracks.map((t) => t.name)).toEqual(["Video 1", "Texto 1"]);
    expect(restored.tracks[0]!.clips[0]!.volume).toBe(0.8);
    expect((await undo({ undoSnapshotId: "nope" })).statusCode).toBe(404);
  });

  it("undo without later edits needs no force", async () => {
    const asset = addAsset("s2");
    const project = await makeProject(asset.id);
    const res = await stems({ clipId: "c1", target: { projectId: project.id } });
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    const { undoSnapshotId } = job.result as StemsResult;
    const ok = await app.inject({
      method: "POST",
      url: STEMS_API_ROUTES.undo,
      payload: { undoSnapshotId },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ project: Project }>().project.tracks).toHaveLength(2);
  });

  it("four stems from an asset only create media (no project edit)", async () => {
    const asset = addAsset("s3");
    const res = await stems({ assetId: asset.id, mode: "four" });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const result = job.result as StemsResult;
    expect(result.stems.map((s) => [s.name, s.label])).toEqual([
      ["vocals", "Voz"],
      ["drums", "Batería"],
      ["bass", "Bajo"],
      ["other", "Otros"],
    ]);
    expect(result.undoSnapshotId).toBeUndefined();
    expect(result.stems.every((s) => !s.trackId)).toBe(true);
    expect(app.ctx.repos.media.get(result.stems[0]!.assetId)?.name).toBe("Clip s3 (voz)");
  });

  it("placeStems without a clip appends tracks at 0 s with the stem length", () => {
    const now = new Date().toISOString();
    const p = ProjectSchema.parse({
      id: "p",
      name: "x",
      settings: {},
      tracks: [{ id: "v", kind: "video", name: "Video", clips: [] }],
      createdAt: now,
      updatedAt: now,
    });
    let n = 0;
    const out = placeStems(
      p,
      [{ name: "vocals", assetId: "a", durationSec: 12.5 }],
      undefined,
      () => String(++n),
    );
    expect(out.previousVolume).toBeUndefined();
    expect(out.project.tracks.map((t) => t.name)).toEqual(["Video", "Voz"]);
    expect(out.project.tracks[1]!.clips[0]).toMatchObject({ start: 0, in: 0, out: 12.5 });
  });

  it("placeStems keeps explicit z-order: stems right above the source track, renumbered", () => {
    const now = new Date().toISOString();
    const clip = { id: "c", trackId: "a", assetId: "x", start: 1, in: 0, out: 4 };
    // array order a, v, m but z-order (Track.order) v(0) < a(1) < m(2)
    const p = ProjectSchema.parse({
      id: "p",
      name: "x",
      settings: {},
      tracks: [
        { id: "a", kind: "audio", name: "Audio", order: 1, clips: [clip] },
        { id: "v", kind: "video", name: "Video", order: 0, clips: [] },
        { id: "m", kind: "motion", name: "Motion", order: 2, clips: [] },
      ],
      createdAt: now,
      updatedAt: now,
    });
    let n = 0;
    const out = placeStems(
      p,
      [
        { name: "vocals", assetId: "s1" },
        { name: "no_vocals", assetId: "s2" },
      ],
      "c",
      () => `n${++n}`,
    );
    const z = tracksInZOrder(out.project.tracks);
    expect(z.map((t) => `${t.name}:${t.order}`)).toEqual([
      "Video:0",
      "Audio:1",
      "Voz:2",
      "Música:3",
      "Motion:4",
    ]);
    expect(z[1]!.clips[0]!.volume).toBe(0); // source muted, reversible
    expect(z[2]!.clips[0]).toMatchObject({ start: 1, in: 0, out: 4 });
  });
});
