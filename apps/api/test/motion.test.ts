import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { motionMediaBaseUrl } from "../src/jobs/handlers/motion-render.js";

describe("motion routes (module c)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const storage = mkdtempSync(path.join(tmpdir(), "studio-motion-"));
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
});
