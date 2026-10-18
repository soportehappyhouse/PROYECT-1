import { API_ROUTES, ApiErrorSchema, SPRINT6_MODULES } from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/** Sprint 6 Paso 0: every new route answers 501 NOT_IMPLEMENTED naming its module. */
const ROUTES: [string, string, string][] = [
  ["GET", API_ROUTES.script, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptTranscribe, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptCuts, SPRINT6_MODULES.M1],
  ["POST", API_ROUTES.scriptFit, SPRINT6_MODULES.M1],
  ["GET", API_ROUTES.brandKit, SPRINT6_MODULES.M2],
  ["PUT", API_ROUTES.brandKit, SPRINT6_MODULES.M2],
  ["POST", API_ROUTES.brandKitLogo, SPRINT6_MODULES.M2],
  ["GET", API_ROUTES.designTokens, SPRINT6_MODULES.M2],
  ["POST", API_ROUTES.designCheck, SPRINT6_MODULES.M2],
  ["POST", API_ROUTES.motionStill, SPRINT6_MODULES.M2],
  ["GET", "/fonts/Inter/OFL.txt", SPRINT6_MODULES.M2],
  ["GET", API_ROUTES.suggestions, SPRINT6_MODULES.M3],
  ["POST", API_ROUTES.suggestionPlan, SPRINT6_MODULES.M3],
  ["POST", API_ROUTES.suggestionDismiss, SPRINT6_MODULES.M3],
  ["POST", API_ROUTES.mediaAnalyze, SPRINT6_MODULES.M3],
  ["GET", API_ROUTES.suggestionSettings, SPRINT6_MODULES.M3],
  ["PUT", API_ROUTES.suggestionSettings, SPRINT6_MODULES.M3],
];

describe("sprint 6 Paso 0 stubs", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  it.each(ROUTES)("%s %s -> 501 NOT_IMPLEMENTED (%s)", async (method, route, module) => {
    const url = route.replace(":id", "p1").replace(":sid", "s1");
    const res = await app.inject({
      method: method as "GET" | "POST" | "PUT",
      url,
      ...(method === "GET" ? {} : { payload: {} }),
    });
    expect(res.statusCode).toBe(501);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    expect(body.error.message).toBe(`Todavía no está disponible (${module}).`);
    expect(body.error.details).toEqual({ module });
  });

  it("the background lane exists with one slot", () => {
    expect(app.ctx.queue.lanes().background).toEqual({ active: 0, limit: 1 });
    expect(app.ctx.queue.laneOf("suggest.analyze")).toBe("background");
    expect(app.ctx.queue.laneOf("script.transcribe")).toBe("workers");
  });
});
