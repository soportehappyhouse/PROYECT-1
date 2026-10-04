import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("api skeleton", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const storage = mkdtempSync(path.join(tmpdir(), "studio-test-"));
    const config = loadConfig({
      STORAGE_DIR: storage,
      WORKERS_URL: "http://127.0.0.1:1",
      FFMPEG_PATH: "ffmpeg-does-not-exist",
      FREESOUND_API_KEY: "x",
    });
    app = await buildApp({ config, inMemoryDb: true, logger: false });
    await app.ready();
  });
  afterAll(() => app.close());

  it("GET /api/health reports degraded without ffmpeg/workers", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.health });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "degraded", workers: { reachable: false } });
  });

  it("GET /api/config exposes only booleans", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.config });
    expect(res.json()).toMatchObject({ providers: { freesound: true, openai: false } });
  });

  it("lists motion engines and templates", async () => {
    const engines = await app.inject({ method: "GET", url: API_ROUTES.motionEngines });
    expect(engines.json()).toHaveLength(3);
    const templates = await app.inject({ method: "GET", url: API_ROUTES.motionTemplates });
    expect(templates.json().length).toBeGreaterThanOrEqual(4);
  });

  it("stubbed endpoints answer 501 with ApiError shape", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.projects });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: { code: "NOT_IMPLEMENTED" } });
  });
});
