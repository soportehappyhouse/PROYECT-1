import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  DEFAULT_EXPORT_PRESETS,
  ProjectSchema,
  TrackFileSchema,
  type Job,
  type MediaAsset,
  type Project,
  type SamPointsResponse,
  type SamSessionResponse,
  type TrackFile,
  type TrackToKeyframesResult,
  type VisionMaskResult,
  type VisionMatteResult,
  type VisionReframeResult,
  type VisionTrackResult,
} from "@studio/shared";
import { trackPropsFor } from "../src/jobs/handlers/motion-render.js";
import { segmentHash } from "../src/services/ffmpeg/segments.js";
import { compileExport } from "../src/services/ffmpeg/timeline.js";
import { requireMaskAsset } from "../src/voice-ai/media-bridge.js";
import { makeApp, multipart, waitFor } from "./helpers.js";

/** Sprint 2 vision routes and jobs against a fake workers service (sprint2-contratos.md). */

const pack = (id: string, installed: boolean) => ({
  id,
  name_es: `Pack ${id}`,
  description_es: "",
  size_bytes: 2e8,
  installed,
  partial: false,
  files: [],
  required_by: [],
  license: "MIT",
  group: "vision",
});

/** Synthetic track: 0.1×0.2 box moving right 0.1 per second (source seconds 0..4, 10 fps). */
const TRACK = (assetId = ""): TrackFile => ({
  version: 1,
  fps: 10,
  smoothed: true,
  source: { assetId, method: "csrt" },
  frames: Array.from({ length: 41 }, (_, i) => ({
    t: i / 10,
    x: 0.1 + 0.01 * i,
    y: 0.4 + (i % 2) * 0.001, // jitter that RDP must drop
    w: 0.1,
    h: 0.2,
    conf: 0.9,
  })),
});

describe("vision routes and jobs (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const state = {
    mattingInstalled: false,
    mattingHqInstalled: false,
    samWorkerMissing: false,
    samInstalled: true,
  };
  const seen: Record<string, Record<string, unknown>> = {};

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
        const write = (rel: string, content = "x") => {
          mkdirSync(path.dirname(path.join(storage, rel)), { recursive: true });
          writeFileSync(path.join(storage, rel), content);
          return rel;
        };
        const done = (result: unknown) =>
          send(200, { status: "done", progress: 1, message: "listo", result, warnings: ["cpu"] });
        const key = `${req.method} ${req.url}`;
        if (req.method === "POST") seen[req.url!] = json;
        switch (key) {
          case "GET /packs":
            return send(200, [
              pack("matting", state.mattingInstalled),
              pack("matting-hq", state.mattingHqInstalled),
              pack("matting-image", true),
              pack("sam2", state.samInstalled),
              pack("reframe", true),
            ]);
          case "POST /vision/matte":
            write(`${String(json.output_base)}.alpha.webm`);
            return send(200, { task_id: "m1" });
          case "GET /vision/tasks/m1": {
            const base = String(seen["/vision/matte"]!.output_base);
            const high = seen["/vision/matte"]!.quality === "high";
            return done({
              alpha_path: `${base}.alpha.webm`,
              preview_path: null,
              fps: 25,
              ...(high && {
                quality: "high",
                rvm_model: "resnet50",
                refine: { erode: 1, feather: 2, despill: true },
                halo: { before: 21.5, after: 7.25, frames: 3, reduction: 0.66 },
                preview_compare_path: write(`${base}.compare.png`, "PNG"),
              }),
            });
          }
          case "POST /vision/matte-image":
            return send(200, { path: write(`${String(json.output_base)}.png`) });
          case "POST /vision/sam/session":
            return send(200, { session_id: "s1", frames: 100, fps: 25 });
          case "POST /vision/sam/session/s1/points":
            return send(200, {
              mask_png_path: write("tmp/sam/s1/mask.png", "PNG"),
              bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
            });
          case "POST /vision/sam/session/s1/propagate":
            write("tmp/sam/s1/masks/00000.png", "PNG");
            write("tmp/sam/s1/masks/00001.png", "PNG");
            write("renders/s1.alpha.webm");
            return send(200, { task_id: "pr1" });
          case "GET /vision/tasks/pr1":
            return done({
              masks_dir: "tmp/sam/s1/masks",
              track: { ...TRACK(), source: undefined },
              alpha_path: "renders/s1.alpha.webm",
            });
          case "DELETE /vision/sam/session/s1":
            return send(200, { deleted: true });
          case "POST /vision/track":
            if (state.samWorkerMissing && json.method === "sam2")
              return send(409, {
                detail: {
                  error: "PACK_REQUIRED",
                  packId: "sam2",
                  name_es: "SAM 2",
                  size_bytes: 2e8,
                },
              });
            write("renders/trk.json", JSON.stringify(TRACK("ignored")));
            return send(200, { task_id: "tr1" });
          case "GET /vision/tasks/tr1":
            return done({ track_path: "renders/trk.json", smoothed: true });
          case "POST /vision/reframe":
            return send(200, { task_id: "rf1" });
          case "GET /vision/tasks/rf1":
            // percent ("% del fuente"), source seconds
            return done({
              keyframes: [
                { t: 1, v: { x: 10, y: 0, w: 31.64, h: 100 }, ease: "linear" },
                { t: 3, v: { x: 50, y: 0, w: 31.64, h: 100 } },
                { t: 9, v: { x: 60, y: 0, w: 31.64, h: 100 } }, // outside the clip
              ],
              per_scene: [],
            });
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
  const addAsset = (id: string, kind: "video" | "image" = "video"): MediaAsset => {
    const rel = `media/${id}.${kind === "video" ? "mp4" : "png"}`;
    writeFileSync(path.join(storage, rel), "x");
    return app.ctx.repos.media.insert({
      id,
      kind,
      name: `Clip ${id}`,
      path: rel,
      sizeBytes: 1,
      durationSec: 10,
      width: 1920,
      height: 1080,
      hasAudio: false,
      hasVideo: kind === "video",
      createdAt: new Date().toISOString(),
    });
  };
  const makeProject = async (assetId: string, extraClip: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      payload: { name: "Visión" },
    });
    const p = res.json<Project>();
    const body = ProjectSchema.parse({
      ...p,
      tracks: [
        {
          id: "v",
          kind: "video",
          name: "Video",
          clips: [{ id: "vc", trackId: "v", assetId, start: 2, in: 0, out: 4 }],
        },
        {
          id: "t",
          kind: "text",
          name: "Texto",
          clips: [{ id: "tc", trackId: "t", start: 2, out: 4, text: "Hola", ...extraClip }],
        },
      ],
    });
    await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: p.id }),
      payload: body,
    });
    return p.id;
  };
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload });

  it("vision.matte: 409 PACK_REQUIRED before enqueueing, then alpha asset + clip.matte", async () => {
    addAsset("person");
    const projectId = await makeProject("person");
    const pre = await post(API_ROUTES.aiVisionMatte, { assetId: "person" });
    expect(pre.statusCode).toBe(409);
    expect(pre.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "matting" });

    state.mattingInstalled = true;
    const res = await post(API_ROUTES.aiVisionMatte, {
      assetId: "person",
      background: { type: "color", value: "#00ff00" },
      target: { projectId, clipId: "vc" },
      downsample: 0.5,
    });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const r = job.result as VisionMatteResult;
    expect(seen["/vision/matte"]).toMatchObject({
      model: "rvm",
      downsample: 0.5,
      path: "media/person.mp4",
    });
    const alpha = app.ctx.repos.media.get(r.assetId)!;
    expect(alpha).toMatchObject({ kind: "video", hasAlpha: true, videoCodec: "vp9", width: 1920 });
    expect(r.linkedClip).toEqual({ projectId, clipId: "vc" });
    const clip = app.ctx.repos.projects.get(projectId)!.tracks[0]!.clips[0]!;
    expect(clip.matte).toEqual({
      assetId: r.assetId,
      background: { type: "color", value: "#00ff00" },
    });

    addAsset("photo", "image");
    const img = await post(API_ROUTES.aiVisionMatte, { assetId: "photo" });
    const imgJob = await jobEnd(img.json<{ jobId: string }>().jobId);
    expect(imgJob.status, imgJob.error).toBe("succeeded");
    expect(app.ctx.repos.media.get((imgJob.result as VisionMatteResult).assetId)).toMatchObject({
      kind: "image",
      hasAlpha: true,
    });
  });

  it("vision.matte quality high: 409 matting-hq, then quality/refine/mask pass through", async () => {
    addAsset("hq");
    state.mattingInstalled = true;
    const pre = await post(API_ROUTES.aiVisionMatte, { assetId: "hq", quality: "high" });
    expect(pre.statusCode).toBe(409);
    expect(pre.json()).toMatchObject({ error: "PACK_REQUIRED", packId: "matting-hq" });

    state.mattingHqInstalled = true;
    const maskAsset = app.ctx.repos.media.insert({
      id: "hqmask",
      kind: "mask",
      name: "Máscara · hq",
      path: "masks/job1",
      sizeBytes: 0,
      createdAt: new Date().toISOString(),
    });
    // a video (or any non-mask asset) as the guide → 400 INVALID_MASK_ASSET
    addAsset("notmask");
    const bad = await post(API_ROUTES.aiVisionMatte, {
      assetId: "hq",
      quality: "high",
      maskAssetId: "notmask",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "INVALID_MASK_ASSET", message: expect.stringMatching(/no es una máscara/) },
    });
    const png = app.ctx.repos.media.insert({
      id: "pngmask",
      kind: "image",
      name: "mascara.png",
      path: "media/mascara.png",
      mimeType: "image/png",
      sizeBytes: 10,
      createdAt: new Date().toISOString(),
    });
    expect(requireMaskAsset(app.ctx, png.id).id).toBe("pngmask"); // a PNG image is accepted
    const res = await post(API_ROUTES.aiVisionMatte, {
      assetId: "hq",
      quality: "high",
      refine: { feather: 2, erode: 0, despill: true, maskDilate: 8 },
      maskAssetId: maskAsset.id,
    });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect(seen["/vision/matte"]).toMatchObject({
      quality: "high",
      refine: { feather: 2, erode: 0, despill: true, mask_dilate: 8 },
      mask_path: "masks/job1",
    });
    const r = job.result as VisionMatteResult;
    expect(r.quality).toBe("high");
    expect(r.previewComparePath).toMatch(/\.compare\.png$/);
    expect(r.halo).toMatchObject({ before: 21.5, after: 7.25 });
    // fast (default) sends none of the new fields: the sprint 2 request is unchanged
    const fast = await post(API_ROUTES.aiVisionMatte, { assetId: "hq" });
    await jobEnd(fast.json<{ jobId: string }>().jobId);
    expect(Object.keys(seen["/vision/matte"]!).sort()).toEqual(["model", "output_base", "path"]);
  });

  it("SAM session: points mask copied under storage/masks and served; propagate -> assets; delete", async () => {
    addAsset("sam");
    const s = await post(API_ROUTES.aiVisionSamSession, { assetId: "sam", frameRange: [0, 99] });
    expect(s.statusCode).toBe(201);
    expect(s.json<SamSessionResponse>()).toEqual({
      sessionId: "s1",
      assetId: "sam",
      frames: 100,
      fps: 25,
    });
    expect(seen["/vision/sam/session"]).toEqual({ path: "media/sam.mp4", frame_range: [0, 99] });

    const p = await post(buildRoute(API_ROUTES.aiVisionSamPoints, { id: "s1" }), {
      frame: 3,
      points: [
        { x: 0.5, y: 0.5, label: 1 },
        { x: 0.1, y: 0.1, label: 0 },
      ],
    });
    expect(p.statusCode).toBe(200);
    const mask = p.json<SamPointsResponse>();
    expect(seen["/vision/sam/session/s1/points"]).toMatchObject({ frame: 3, obj_id: 1 });
    expect(mask.maskPath).toBe("masks/s1/f3-o1-1.png");
    expect(mask.bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    const file = await app.inject({ method: "GET", url: mask.maskUrl });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe("PNG");

    const prop = await post(buildRoute(API_ROUTES.aiVisionSamPropagate, { id: "s1" }), {
      chunkFrames: 50,
    });
    expect(prop.statusCode).toBe(202);
    const job = await jobEnd(prop.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const r = job.result as VisionMaskResult;
    expect(seen["/vision/sam/session/s1/propagate"]).toEqual({ chunk_frames: 50 });
    const trk = app.ctx.repos.media.get(r.trackAssetId!)!;
    expect(trk.kind).toBe("track");
    const tf = TrackFileSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: `/files/${trk.path}` })).body),
    );
    expect(tf.source).toEqual({ assetId: "sam", method: "sam2" });
    expect(app.ctx.repos.media.get(r.maskAssetId!)).toMatchObject({ kind: "mask" });
    const copied = await app.inject({
      method: "GET",
      url: `/files/${app.ctx.repos.media.get(r.maskAssetId!)!.path}/00001.png`,
    });
    expect(copied.statusCode).toBe(200);
    expect(app.ctx.repos.media.get(r.alphaAssetId!)).toMatchObject({
      kind: "video",
      hasAlpha: true,
    });

    const del = await app.inject({
      method: "DELETE",
      url: buildRoute(API_ROUTES.aiVisionSamSessionItem, { id: "s1" }),
    });
    expect(del.json()).toEqual({ deleted: true });
    // click previews removed with the session; propagate outputs (assets) stay
    expect((await app.inject({ method: "GET", url: mask.maskUrl })).statusCode).toBe(404);
    const kept = await app.inject({
      method: "GET",
      url: `/files/${app.ctx.repos.media.get(r.maskAssetId!)!.path}/00001.png`,
    });
    expect(kept.statusCode).toBe(200);
    const again = await app.inject({
      method: "DELETE",
      url: buildRoute(API_ROUTES.aiVisionSamSessionItem, { id: "expired" }),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ deleted: false });
  });

  it("vision.track: track asset (source rewritten) + trackRef; PACK_REQUIRED from the workers fails the job", async () => {
    addAsset("mov");
    const projectId = await makeProject("mov");
    const res = await post(API_ROUTES.aiVisionTrack, {
      assetId: "mov",
      bbox: { x: 0.1, y: 0.4, w: 0.1, h: 0.2 },
      target: { projectId, clipId: "tc", anchor: "top", offset: { x: 0, y: -0.05 } },
    });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const r = job.result as VisionTrackResult;
    expect(seen["/vision/track"]).toEqual({
      path: "media/mov.mp4",
      method: "csrt",
      bbox: { x: 0.1, y: 0.4, w: 0.1, h: 0.2 },
    });
    expect(r.frames).toBe(41);
    expect(r.method).toBe("csrt"); // TrackFile.source.method ("template" on headless OpenCV)
    const tf = TrackFileSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: `/files/${r.path}` })).body),
    );
    expect(tf.source.assetId).toBe("mov");
    const text = app.ctx.repos.projects.get(projectId)!.tracks[1]!.clips[0]!;
    expect(text.trackRef).toEqual({
      assetId: r.assetId,
      anchor: "top",
      offset: { x: 0, y: -0.05 },
    });

    // timeline.track-to-keyframes: ≤ 2 keyframes per second, trackRef removed.
    const bad = await post(API_ROUTES.aiTrackToKeyframes, { projectId, clipId: "vc" });
    expect(bad.statusCode).toBe(400);
    const conv = await post(API_ROUTES.aiTrackToKeyframes, { projectId, clipId: "tc" });
    const cj = await jobEnd(conv.json<{ jobId: string }>().jobId);
    expect(cj.status, cj.error).toBe("succeeded");
    const out = cj.result as TrackToKeyframesResult;
    const clip = out.project.tracks[1]!.clips[0]!;
    expect(clip.trackRef).toBeUndefined();
    const kfs = clip.keyframes!.position!;
    expect(kfs.length).toBeLessThanOrEqual(2 * 2 + 1);
    expect(kfs.length).toBe(out.keyframes);
    // text clip starts at 2 = video clip start (source 0): x center 0.15, top 0.4 - 0.05
    expect(kfs[0]).toMatchObject({ t: 0, ease: "linear" });
    expect((kfs[0]!.v as { x: number }).x).toBeCloseTo(0.15, 3);
    expect((kfs[0]!.v as { y: number }).y).toBeCloseTo(0.35, 2);
    expect(kfs.at(-1)!.t).toBeCloseTo(4, 6);
    expect((kfs.at(-1)!.v as { x: number }).x).toBeCloseTo(0.55, 3);

    state.samWorkerMissing = true;
    const fail = await post(API_ROUTES.aiVisionTrack, {
      assetId: "mov",
      bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
      method: "sam2",
    });
    const fj = await jobEnd(fail.json<{ jobId: string }>().jobId);
    expect(fj.status).toBe("failed");
    expect(fj.result).toMatchObject({ error: "PACK_REQUIRED", packId: "sam2" });
    state.samWorkerMissing = false;

    const invalid = await post(API_ROUTES.aiVisionTrack, { assetId: "mov" });
    expect(invalid.statusCode).toBe(400);
  });

  it('vision.track method "auto": SAM 2 when the workers list the sam2 pack, else CSRT', async () => {
    addAsset("auto");
    const bbox = { x: 0.1, y: 0.4, w: 0.1, h: 0.2 };
    for (const [installed, expected] of [
      [true, "sam2"],
      [false, "csrt"],
    ] as const) {
      state.samInstalled = installed;
      const res = await post(API_ROUTES.aiVisionTrack, { assetId: "auto", bbox, method: "auto" });
      expect(res.statusCode).toBe(202);
      const job = await jobEnd(res.json<{ jobId: string }>().jobId);
      expect(job.status, job.error).toBe("succeeded");
      expect(seen["/vision/track"]!.method).toBe(expected); // result.method = TrackFile source
    }
    state.samInstalled = true;
  });

  it("imports an uploaded track.json as an asset of kind track (a Lottie JSON stays lottie)", async () => {
    const up = await multipart(
      "seguimiento.json",
      JSON.stringify(TRACK("mov")),
      "application/json",
    );
    const res = await app.inject({ method: "POST", url: API_ROUTES.media, ...up });
    expect(res.statusCode).toBe(201);
    expect(res.json<MediaAsset>().kind).toBe("track");
    const lottie = await multipart(
      "anim.json",
      JSON.stringify({ v: "5.7", layers: [] }),
      "application/json",
    );
    const l = await app.inject({ method: "POST", url: API_ROUTES.media, ...lottie });
    expect(l.json<MediaAsset>().kind).toBe("lottie");
  });

  it("vision.reframe: percent source keyframes -> project.reframe in timeline seconds / canvas fractions", async () => {
    addAsset("wide");
    const projectId = await makeProject("wide");
    const res = await post(API_ROUTES.aiVisionReframe, { projectId, target: "9:16" });
    expect(res.statusCode).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const r = job.result as VisionReframeResult;
    expect(seen["/vision/reframe"]).toEqual({
      path: "media/wide.mp4",
      target: "9:16",
      subject: "face",
    });
    const saved = app.ctx.repos.projects.get(projectId)!;
    expect(saved.reframe).toEqual(r.reframe);
    expect(r.reframe.keyframes.map((k) => k.t)).toEqual([3, 5]);
    const v = r.reframe.keyframes[0]!.v as { x: number; w: number; h: number };
    expect(v.x).toBeCloseTo(0.1, 9);
    expect(v.w).toBeCloseTo(0.3164, 9);
    expect(v.h).toBe(1);
    const noTrack = await post(API_ROUTES.aiVisionReframe, { projectId, subject: "track" });
    expect(noTrack.statusCode).toBe(400);
  });
});

describe("sprint 2 compile + hash + motion props (no ffmpeg)", () => {
  const now = "2026-10-05T00:00:00Z";
  const project = (clip: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ProjectSchema.parse({
      id: "p",
      name: "p",
      settings: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v",
          kind: "video",
          name: "V",
          clips: [{ id: "a", trackId: "v", assetId: "src", start: 0, in: 0, out: 12, ...clip }],
        },
      ],
      ...extra,
      createdAt: now,
      updatedAt: now,
    });
  const assets = new Map([
    [
      "src",
      {
        id: "src",
        absPath: "/m/src.mp4",
        kind: "video" as const,
        hasVideo: true,
        hasAudio: true,
        width: 1920,
        height: 1080,
      },
    ],
    [
      "alpha",
      {
        id: "alpha",
        absPath: "/m/a.webm",
        kind: "video" as const,
        hasVideo: true,
        hasAudio: false,
        hasAlpha: true,
        videoCodec: "vp9",
        width: 1920,
        height: 1080,
      },
    ],
  ]);
  const preset = DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!;
  const reels = DEFAULT_EXPORT_PRESETS.find((p) => p.id === "reels-tiktok")!;
  const hash = (p: Project, pr = preset, start = 10) =>
    segmentHash({
      project: p,
      preset: pr,
      encoder: "libx264",
      window: { start, end: 12, frames: 60 },
      gopFrames: 60,
      assets,
      stamps: new Map(),
    });

  it("compiles position/scale/opacity keyframes, matte and reframe into expressions", () => {
    const kf = {
      position: [
        { t: 0, v: { x: 0.25, y: 0.5 }, ease: "easeIn" },
        { t: 2, v: { x: 0.75, y: 0.5 }, ease: "linear" },
      ],
      scale: [
        { t: 0, v: 0.5, ease: "linear" },
        { t: 2, v: 1, ease: "linear" },
      ],
      opacity: [
        { t: 0, v: 0, ease: "hold" },
        { t: 1, v: 1, ease: "linear" },
      ],
    };
    const p = project(
      {
        keyframes: kf,
        matte: { assetId: "alpha", background: { type: "blur", value: "30" } },
      },
      {
        reframe: {
          target: "9:16",
          keyframes: [
            { t: 0, v: { x: 0.1, y: 0, w: 0.3164, h: 1 } },
            { t: 12, v: { x: 0.6, y: 0, w: 0.3164, h: 1 } },
          ],
        },
      },
    );
    const c = compileExport({ project: p, preset: reels, assets, output: "o.mp4" });
    expect(c.graph).toMatch(/overlay=x='if\(lt\(\(t-0\),0\)/);
    expect(c.graph).toMatch(/scale=w='max\(2,2\*trunc\(1920\*max\(0\.001,/);
    expect(c.graph).toMatch(/pad=w=1920:h=1080:x=\(ow-iw\)\/2:y=\(oh-ih\)\/2:eval=frame/);
    expect(c.graph).toMatch(/geq=lum='lum\(X,Y\)'.*a='alpha\(X,Y\)\*clip\(/);
    expect(c.graph).toMatch(/gblur=sigma=30/);
    expect(c.graph).toMatch(/overlay=0:0:shortest=1/);
    expect(c.graph).toMatch(/crop=w=608:h=1080:x='clip\(/);
    expect(c.graph).not.toMatch(/gblur=sigma=30\[rfbgb\]|split=2\[rfbg\]/);
    // eased segment pre-sampled at ≤ 30 keypoints/s: 2 s -> ≤ 60 leaves per axis
    const leaves = (c.graph.match(/overlay=x='([^']*)'/)![1]!.match(/\(t-0\)-/g) ?? []).length;
    expect(leaves).toBeGreaterThan(10);
    expect(leaves).toBeLessThanOrEqual(61);
  });

  it("segment hash changes with keyframes, matte, trackRef and reframe (only when it applies)", () => {
    const base = project({});
    const h0 = hash(base);
    expect(hash(project({ keyframes: { opacity: [{ t: 0, v: 0.5 }] } }))).not.toBe(h0);
    expect(hash(project({ matte: { assetId: "alpha" } }))).not.toBe(h0);
    expect(hash(project({ trackRef: { assetId: "t1" } }))).not.toBe(h0);
    const rf = project(
      {},
      { reframe: { target: "9:16", keyframes: [{ t: 0, v: { x: 0, y: 0, w: 0.3, h: 1 } }] } },
    );
    expect(hash(rf)).toBe(h0); // 16:9 preset: the reframe does not apply
    expect(hash(rf, reels)).not.toBe(hash(base, reels));
    expect(hash(rf, reels, 10)).not.toBe(hash(rf, reels, 9.5)); // evaluated from the window start
  });

  it("motion-render passes the track mapped to composition time and canvas", () => {
    const p = ProjectSchema.parse({
      id: "p",
      name: "p",
      settings: { width: 1920, height: 1080 },
      tracks: [
        {
          id: "v",
          kind: "video",
          name: "V",
          clips: [{ id: "vc", trackId: "v", assetId: "mov", start: 2, in: 1, out: 5 }],
        },
        {
          id: "m",
          kind: "motion",
          name: "M",
          clips: [
            {
              id: "mc",
              trackId: "m",
              start: 3,
              in: 0,
              out: 2,
              trackRef: { assetId: "trk", anchor: "bottom" },
            },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    const clip = p.tracks[1]!.clips[0]!;
    const props = trackPropsFor(p, clip, TRACK("mov"), () => ({ width: 1920, height: 1080 })) as {
      track: TrackFile;
      trackAnchor: string;
      trackOffset: { x: number; y: number };
    };
    expect(props.trackAnchor).toBe("bottom");
    expect(props.trackOffset).toEqual({ x: 0, y: 0 });
    // timeline 3 = video local 1 = source 2 -> composition t 0
    const f0 = props.track.frames.find((f) => Math.abs(f.t) < 1e-9)!;
    expect(f0.x).toBeCloseTo(0.1 + 0.01 * 20, 9);
  });
});
