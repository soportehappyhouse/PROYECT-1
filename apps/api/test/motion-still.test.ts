import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API_ROUTES, DEFAULT_DESIGN_TOKENS, MotionStillRequestSchema } from "@studio/shared";
import { resolveBrowserExecutable } from "@studio/remotion";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StillService, type StillRenderArgs } from "../src/services/design/still.js";
import { makeApp, tempStorage } from "./helpers.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

const req = (props: Record<string, unknown> = {}) =>
  MotionStillRequestSchema.parse({ template: "lower-third", props, width: 1080, height: 1920 });

describe("motion still (Sprint 6 M2)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  const browser = resolveBrowserExecutable(null);

  it.skipIf(Boolean(browser))(
    "without a browser: 503 STILL_UNAVAILABLE with the reason",
    async () => {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.motionStill,
        payload: { template: "title-card", props: { title: "Hola" }, width: 1080, height: 1920 },
      });
      expect(res.statusCode).toBe(503);
      const err = res.json().error;
      expect(err.code).toBe("STILL_UNAVAILABLE");
      expect(err.message).toMatch(/^No se pudo generar la vista previa \(.+\)\.$/);
      expect(err.details.reason).toMatch(/Chrome Headless Shell/);
    },
  );

  it.runIf(Boolean(browser))(
    "with Remotion: a real PNG 1080×1920 in < 5 s, 2nd request from cache",
    async () => {
      const payload = {
        template: "title-card",
        props: { title: "Hola" },
        width: 1080,
        height: 1920,
      };
      const t0 = Date.now();
      const res = await app.inject({ method: "POST", url: API_ROUTES.motionStill, payload });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
      const again = await app.inject({ method: "POST", url: API_ROUTES.motionStill, payload });
      expect(again.headers["x-still-cache"]).toBe("hit");
      expect(Date.now() - t0).toBeLessThan(60_000);
    },
    120_000,
  );

  it("invalid props -> 400 before rendering", async () => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.motionStill,
      payload: {
        template: "lower-third",
        props: { position: "middle" },
        width: 1080,
        height: 1920,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cache: the 2nd identical request does not render; another kit renders again", async () => {
    const storage = tempStorage();
    const calls: StillRenderArgs[] = [];
    const svc = new StillService({
      storageDir: storage,
      ffmpegPath: "ffmpeg",
      render: async (a) => {
        calls.push(a);
        mkdirSync(path.dirname(a.output), { recursive: true });
        writeFileSync(a.output, PNG_1PX);
      },
    });
    const first = await svc.get(req({ name: "Ana" }), DEFAULT_DESIGN_TOKENS);
    expect(first.cached).toBe(false);
    expect(existsSync(first.file)).toBe(true);
    expect(first.file).toContain(path.join("renders", "stills"));
    const second = await svc.get(req({ name: "Ana" }), DEFAULT_DESIGN_TOKENS);
    expect(second.cached).toBe(true);
    expect(svc.renders).toBe(1);
    const otherKit = {
      ...DEFAULT_DESIGN_TOKENS,
      color: { ...DEFAULT_DESIGN_TOKENS.color, accent: "#00AAFF" },
    };
    await svc.get(req({ name: "Ana" }), otherKit);
    expect(svc.renders).toBe(2);
    expect(calls[1]!.tokens!.color.accent).toBe("#00AAFF");
    // Concurrent identical requests share one render.
    await Promise.all([svc.get(req({ name: "Bea" }), null), svc.get(req({ name: "Bea" }), null)]);
    expect(svc.renders).toBe(3);
  });

  it("LRU: the folder stays under the budget, oldest first", async () => {
    const storage = tempStorage();
    const svc = new StillService({
      storageDir: storage,
      ffmpegPath: "ffmpeg",
      maxBytes: 2500,
      render: async (a) => {
        mkdirSync(path.dirname(a.output), { recursive: true });
        writeFileSync(a.output, Buffer.alloc(1000, 7));
      },
    });
    const files: string[] = [];
    for (const n of ["a", "b", "c", "d"]) {
      files.push((await svc.get(req({ name: n }), null)).file);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(existsSync(files[0]!)).toBe(false);
    expect(existsSync(files[3]!)).toBe(true);
    const total = files.filter(existsSync).reduce((n, f) => n + statSync(f).size, 0);
    expect(total).toBeLessThanOrEqual(2500);
  });
});
