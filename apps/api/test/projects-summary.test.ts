import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  buildRoute,
  ProjectSummarySchema,
  type Project,
  type ProjectSummary,
} from "@studio/shared";
import { makeApp } from "./helpers.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function create(name: string): Promise<Project> {
  const res = await app!.inject({ method: "POST", url: API_ROUTES.projects, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json<Project>();
}

/** Put one video clip (unknown asset: no thumbnail) and one text clip on the project. */
async function fill(p: Project): Promise<Project> {
  const video = p.tracks.find((t) => t.kind === "video")!;
  const text = p.tracks.find((t) => t.kind === "text")!;
  video.clips = [
    {
      id: "c1",
      trackId: video.id,
      start: 0,
      in: 0,
      out: 4,
      speed: 2,
    } as Project["tracks"][0]["clips"][0],
  ];
  text.clips = [
    {
      id: "c2",
      trackId: text.id,
      start: 1,
      in: 0,
      out: 5,
      text: "Hola",
    } as Project["tracks"][0]["clips"][0],
  ];
  const res = await app!.inject({
    method: "PUT",
    url: buildRoute(API_ROUTES.project, { id: p.id }),
    payload: p,
  });
  expect(res.statusCode).toBe(200);
  return res.json<Project>();
}

describe("Sprint 5: project list / rename / duplicate / delete", () => {
  it("GET ?view=summary lists summaries newest first; without view stays Project[]", async () => {
    ({ app } = await makeApp());
    const a = await fill(await create("Primero"));
    await new Promise((r) => setTimeout(r, 5));
    const b = await create("Segundo");
    const res = await app.inject({ method: "GET", url: `${API_ROUTES.projects}?view=summary` });
    expect(res.statusCode).toBe(200);
    const list = res.json<ProjectSummary[]>();
    for (const s of list) ProjectSummarySchema.parse(s);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[1]).toMatchObject({ name: "Primero", clips: 2, durationS: 6, width: 1920 });
    expect(list[1]).not.toHaveProperty("tracks");
    const full = await app.inject({ method: "GET", url: API_ROUTES.projects });
    expect(full.json<Project[]>()[0]).toHaveProperty("tracks");
  });

  it("PATCH renames (400 on invalid names, 404 on unknown ids)", async () => {
    ({ app } = await makeApp());
    const p = await create("Viejo");
    const url = buildRoute(API_ROUTES.project, { id: p.id });
    const ok = await app.inject({ method: "PATCH", url, payload: { name: "  Nuevo nombre " } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ProjectSummary>()).toMatchObject({ id: p.id, name: "Nuevo nombre" });
    const got = await app.inject({ method: "GET", url });
    expect(got.json<Project>().name).toBe("Nuevo nombre");
    for (const payload of [{ name: "" }, { name: "x".repeat(121) }, { name: "a", extra: 1 }, {}]) {
      const bad = await app.inject({ method: "PATCH", url, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const missing = await app.inject({
      method: "PATCH",
      url: buildRoute(API_ROUTES.project, { id: "nope" }),
      payload: { name: "X" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("POST duplicate copies with new ids and the same assets", async () => {
    ({ app } = await makeApp());
    const src = await fill(await create("Original"));
    const res = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.projectDuplicate, { id: src.id }),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const dup = res.json<Project>();
    expect(dup.name).toBe("Original (copia)");
    expect(dup.id).not.toBe(src.id);
    const srcIds = new Set(src.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]));
    for (const t of dup.tracks) {
      expect(srcIds.has(t.id)).toBe(false);
      for (const c of t.clips) {
        expect(srcIds.has(c.id)).toBe(false);
        expect(c.trackId).toBe(t.id);
      }
    }
    expect(dup.tracks.flatMap((t) => t.clips).length).toBe(2);
    expect(dup.tracks.map((t) => t.kind)).toEqual(src.tracks.map((t) => t.kind));
    const named = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.projectDuplicate, { id: src.id }),
      payload: { name: "Versión 2" },
    });
    expect(named.json<Project>().name).toBe("Versión 2");
    const missing = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.projectDuplicate, { id: "nope" }),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    // the original is untouched
    const again = await app.inject({
      method: "GET",
      url: buildRoute(API_ROUTES.project, { id: src.id }),
    });
    expect(again.json<Project>().tracks).toEqual(src.tracks);
  });

  it("DELETE removes the project from the summary", async () => {
    ({ app } = await makeApp());
    const p = await create("Borrar");
    const del = await app.inject({
      method: "DELETE",
      url: buildRoute(API_ROUTES.project, { id: p.id }),
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: `${API_ROUTES.projects}?view=summary` });
    expect(list.json<ProjectSummary[]>().some((s) => s.id === p.id)).toBe(false);
    const again = await app.inject({
      method: "DELETE",
      url: buildRoute(API_ROUTES.project, { id: p.id }),
    });
    expect(again.statusCode).toBe(404);
  });
});
