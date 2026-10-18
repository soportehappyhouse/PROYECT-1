import { API_ROUTES, ApiErrorSchema } from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * Sprint 6 Paso 0 stubs, replaced by the modules (M1 Guion: script.test.ts). Audit S6 E22: «not
 * 501» could not fail; now each route answers what its contract says, for a missing project and
 * for a real one with an empty body.
 */
describe("sprint 6 script routes are live", () => {
  let app: FastifyInstance;
  let projectId = "";
  beforeAll(async () => {
    ({ app } = await makeApp());
    projectId = app.ctx.repos.projects.create({ name: "Vacío" }).id;
  });
  afterAll(() => app.close());

  // Bodies that pass validation, so the answer is about the project.
  const BODY: Record<string, unknown> = {
    [API_ROUTES.scriptTranscribe]: { clipId: "c1" },
    [API_ROUTES.scriptCuts]: { fillers: "safe" },
    [API_ROUTES.scriptFit]: { target_s: 30 },
  };
  const call = (method: "GET" | "POST", route: string, id: string, payload = BODY[route]) =>
    app.inject({
      method,
      url: route.replace(":id", id),
      ...(method === "GET" ? {} : { payload: payload as object }),
    });

  it.each([
    ["GET", API_ROUTES.script],
    ["POST", API_ROUTES.scriptTranscribe],
    ["POST", API_ROUTES.scriptCuts],
    ["POST", API_ROUTES.scriptFit],
  ] as const)("%s %s with a missing project -> 404 in Spanish", async (method, route) => {
    const res = await call(method, route, "no-existe");
    expect(res.statusCode).toBe(404);
    const err = ApiErrorSchema.parse(res.json()).error;
    expect(err.code).not.toBe("NOT_IMPLEMENTED");
    expect(err.message).toMatch(/[Pp]royecto/);
  });

  it("with an empty project: script 200, transcribe 404/400, cuts and fit 409 SCRIPT_EMPTY", async () => {
    const script = await call("GET", API_ROUTES.script, projectId);
    expect(script.statusCode).toBe(200);
    expect(script.json().words).toEqual([]);
    expect((await call("POST", API_ROUTES.scriptTranscribe, projectId)).statusCode).toBe(404);
    expect((await call("POST", API_ROUTES.scriptTranscribe, projectId, {})).statusCode).toBe(400);
    for (const route of [API_ROUTES.scriptCuts, API_ROUTES.scriptFit]) {
      const res = await call("POST", route, projectId);
      expect(res.statusCode, route).toBe(409);
      expect(res.json().error.code).toBe("SCRIPT_EMPTY");
    }
    expect((await call("POST", API_ROUTES.scriptFit, projectId, {})).statusCode).toBe(400);
  });

  it("the background lane exists with one slot", () => {
    expect(app.ctx.queue.lanes().background).toEqual({ active: 0, limit: 1 });
    expect(app.ctx.queue.laneOf("suggest.analyze")).toBe("background");
    expect(app.ctx.queue.laneOf("script.transcribe")).toBe("workers");
  });
});
