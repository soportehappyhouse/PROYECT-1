import { API_ROUTES, ApiErrorSchema, SPRINT6_MODULES } from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/** Sprint 6 Paso 0: every new route answers 501 NOT_IMPLEMENTED naming its module. */
// The modules replaced their stubs during the sprint (M1 Guion: script.test.ts); the routes are
// checked to be live (no 501 left).
const ROUTES: [string, string, string][] = [
  ["GET", API_ROUTES.script, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptTranscribe, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptCuts, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptFit, SPRINT6_MODULES.M1],
];

describe("sprint 6 Paso 0 stubs", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  it.each(ROUTES)("%s %s is live, no 501 (%s)", async (method, route) => {
    const url = route.replace(":id", "p1").replace(":sid", "s1");
    const res = await app.inject({
      method: method as "GET" | "POST" | "PUT",
      url,
      ...(method === "GET" ? {} : { payload: {} }),
    });
    expect(res.statusCode).not.toBe(501);
    expect(ApiErrorSchema.parse(res.json()).error.code).not.toBe("NOT_IMPLEMENTED");
  });

  it("the background lane exists with one slot", () => {
    expect(app.ctx.queue.lanes().background).toEqual({ active: 0, limit: 1 });
    expect(app.ctx.queue.laneOf("suggest.analyze")).toBe("background");
    expect(app.ctx.queue.laneOf("script.transcribe")).toBe("workers");
  });
});
