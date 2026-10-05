import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { API_ROUTES, DEFAULT_EXPORT_PRESETS, type Project } from "@studio/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import {
  createMotionRenderHandler,
  motionMediaBaseUrl,
} from "../src/jobs/handlers/motion-render.js";
import type { JobContext } from "../src/jobs/types.js";
import { compileExport, type TimelineAsset } from "../src/services/ffmpeg/timeline.js";

describe("motion routes (module c)", () => {
  let app: FastifyInstance;
  let storage: string;

  beforeAll(async () => {
    storage = mkdtempSync(path.join(tmpdir(), "studio-motion-"));
    const config = loadConfig({
      STORAGE_DIR: storage,
      WORKERS_URL: "http://127.0.0.1:1",
      FFMPEG_PATH: "ffmpeg-does-not-exist",
    });
    app = await buildApp({ config, inMemoryDb: true, logger: false });
    await app.ready();
  });
  afterAll(() => app.close());

  it("templates expose engine, JSON schema and defaults for every engine", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.motionTemplates });
    const templates = res.json() as { engine: string; id: string; propsSchema?: unknown }[];
    expect(templates.filter((t) => t.engine === "remotion").length).toBeGreaterThanOrEqual(9);
    expect(templates.map((t) => `${t.engine}:${t.id}`)).toEqual(
      expect.arrayContaining(["remotion:animated-captions", "ffmpeg-lottie:ffmpeg-title"]),
    );
    for (const t of templates) expect(t.propsSchema).toMatchObject({ type: "object" });
  });

  it("engines report capabilities and availability reasons", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.motionEngines });
    const engines = res.json() as { id: string; ok: boolean; capabilities: { maxFps: number } }[];
    expect(engines.map((e) => e.id)).toEqual(["remotion", "motion-canvas", "ffmpeg-lottie"]);
    expect(engines.find((e) => e.id === "ffmpeg-lottie")).toMatchObject({ ok: false });
    for (const e of engines) expect(e.capabilities.maxFps).toBeGreaterThan(0);
  });

  it("POST render rejects invalid specs with 400 + Spanish errors", async () => {
    const bad = await app.inject({
      method: "POST",
      url: API_ROUTES.motionRender,
      payload: { template: "title-card", durationSec: 2, props: { style: "explode" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { engine: "remotion" } },
    });
    const noDuration = await app.inject({
      method: "POST",
      url: API_ROUTES.motionRender,
      payload: { template: "title-card" },
    });
    expect(noDuration.statusCode).toBe(400);
    const stub = await app.inject({
      method: "POST",
      url: API_ROUTES.motionRender,
      payload: {
        engine: "motion-canvas",
        template: "hello-circle",
        durationSec: 1,
        format: "webm-vp9-alpha",
      },
    });
    expect(stub.statusCode).toBe(400);
  });

  it("POST render enqueues a motion.render job (202 {jobId})", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.motionRender,
      payload: { template: "ffmpeg-title", durationSec: 1, props: { text: "Hola" } },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(app.ctx.jobs.get(jobId)).toMatchObject({ type: "motion.render" });
    expect(app.ctx.queue.hasHandler("motion.render")).toBe(true);
  });

  it("media base URL points headless browsers at the local /files/ server", () => {
    expect(motionMediaBaseUrl({ host: "0.0.0.0", port: 3001 })).toBe(
      "http://127.0.0.1:3001/files/",
    );
    expect(motionMediaBaseUrl({ host: "127.0.0.1", port: 4000 })).toBe(
      "http://127.0.0.1:4000/files/",
    );
  });

  it("POST render keeps the target clip in the job payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.motionRender,
      payload: {
        template: "ffmpeg-title",
        durationSec: 1,
        props: { text: "Hola" },
        target: { projectId: "p1", clipId: "c1" },
      },
    });
    expect(res.statusCode).toBe(202);
    const job = app.ctx.jobs.get((res.json() as { jobId: string }).jobId)!;
    expect(job.payload).toMatchObject({ target: { projectId: "p1", clipId: "c1" } });
    expect(job.projectId).toBe("p1");
  });

  it("motion.render registers a MediaAsset, links clip.renderedAssetId and export uses it", async () => {
    const { repos } = app.ctx;
    const created = repos.projects.create({ name: "Motion" });
    const motionTrack = { id: "tm", kind: "motion", name: "Motion 1", clips: [] as unknown[] };
    const clip = {
      id: "clip-m",
      trackId: "tm",
      start: 0,
      in: 0,
      out: 2,
      motion: { template: "ffmpeg-title", durationSec: 2, format: "webm-vp9-alpha" },
    };
    motionTrack.clips.push(clip);
    repos.projects.save(created.id, { ...created, tracks: [...created.tracks, motionTrack] });

    // Fake engine: writes the output file the real registry would produce.
    const fakeMotion = {
      render: async (_spec: unknown, rctx: { storageDir: string; outputPath: string }) => {
        const abs = path.join(rctx.storageDir, rctx.outputPath);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, "webm");
        return {
          path: rctx.outputPath,
          format: "webm-vp9-alpha" as const,
          hasAlpha: true,
          durationSec: 2,
          width: 1920,
          height: 1080,
          engine: "ffmpeg-lottie" as const,
          renderTimeMs: 1,
        };
      },
    };
    const handler = createMotionRenderHandler({
      ...app.ctx,
      motion: fakeMotion,
    } as unknown as AppContext);
    const payload = handler.parse({
      template: "ffmpeg-title",
      durationSec: 2,
      format: "webm-vp9-alpha",
      target: { projectId: created.id, clipId: "clip-m" },
    });
    const jobCtx = {
      jobId: "job-m",
      signal: new AbortController().signal,
      reportProgress: () => undefined,
      log: () => undefined,
      storageDir: storage,
    } as unknown as JobContext;
    const result = await handler.run(payload, jobCtx, { id: "job-m" } as never);

    expect(result.assetId).toBeDefined();
    expect(result.linkedClip).toEqual({ projectId: created.id, clipId: "clip-m" });
    const asset = repos.media.get(result.assetId!)!;
    expect(asset).toMatchObject({ kind: "video", hasAlpha: true, path: "renders/job-m.webm" });
    const project = repos.projects.get(created.id) as Project;
    const linked = project.tracks.flatMap((t) => t.clips).find((c) => c.id === "clip-m");
    expect(linked?.renderedAssetId).toBe(asset.id);

    // The export compiler picks the motion clip up through renderedAssetId.
    const assets = new Map<string, TimelineAsset>([
      [
        asset.id,
        {
          id: asset.id,
          absPath: path.join(storage, asset.path),
          kind: "video",
          hasVideo: true,
          hasAudio: false,
          hasAlpha: true,
          videoCodec: "vp9",
        },
      ],
    ]);
    const compiled = compileExport({
      project,
      preset: DEFAULT_EXPORT_PRESETS[0]!,
      assets,
      output: "out.mp4",
    });
    expect(compiled.args).toContain(path.join(storage, asset.path));
    expect(compiled.warnings.join(" ")).not.toContain("sin renderizar");

    // Feedback 1: a stale dashboard save (clip without renderedAssetId, same spec) keeps the link...
    const stale = structuredClone(project);
    for (const t of stale.tracks) for (const c of t.clips) delete c.renderedAssetId;
    const saved = repos.projects.save(created.id, stale)!;
    expect(
      saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "clip-m")?.renderedAssetId,
    ).toBe(asset.id);
    // ...while a changed spec ("Actualizar clip y renderizar") drops it.
    const edited = structuredClone(stale);
    edited.tracks.flatMap((t) => t.clips).find((c) => c.id === "clip-m")!.motion!.durationSec = 3;
    const again = repos.projects.save(created.id, edited)!;
    expect(
      again.tracks.flatMap((t) => t.clips).find((c) => c.id === "clip-m")?.renderedAssetId,
    ).toBeUndefined();
  });
});
