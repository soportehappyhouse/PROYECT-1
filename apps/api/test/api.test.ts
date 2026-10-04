import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  buildRoute,
  DEFAULT_DASHBOARD_SETTINGS,
  type ExportPreset,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { makeApp, multipart, waitFor } from "./helpers.js";

describe("api routes (no ffmpeg)", () => {
  let app: FastifyInstance;
  let storage: string;

  beforeAll(async () => {
    ({ app, storage } = await makeApp());
  });
  afterAll(() => app.close());

  it("projects: create, list, get, put, autosave, delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      payload: { name: "Demo" },
    });
    expect(created.statusCode).toBe(201);
    const p = created.json<Project>();
    expect(p.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(p.tracks.map((t) => t.kind)).toEqual(["video", "text", "audio"]);

    const list = await app.inject({ method: "GET", url: API_ROUTES.projects });
    expect(list.json<Project[]>().map((x) => x.id)).toContain(p.id);

    const url = buildRoute(API_ROUTES.project, { id: p.id });
    const track = p.tracks[0]!;
    const body = {
      ...p,
      name: "Renombrado",
      id: "ignored",
      tracks: [
        { ...track, clips: [{ id: "c1", trackId: track.id, assetId: "a", start: 0, out: 2 }] },
      ],
    };
    const put = await app.inject({ method: "PUT", url, payload: body });
    expect(put.statusCode).toBe(200);
    expect(put.json<Project>()).toMatchObject({
      id: p.id,
      name: "Renombrado",
      createdAt: p.createdAt,
    });
    expect(put.json<Project>().tracks[0]!.clips[0]).toMatchObject({ in: 0, speed: 1, volume: 1 });

    const bad = await app.inject({ method: "PUT", url, payload: { name: "" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const autoUrl = buildRoute(API_ROUTES.projectAutosave, { id: p.id });
    expect((await app.inject({ method: "GET", url: autoUrl })).statusCode).toBe(404);
    const auto = await app.inject({
      method: "PUT",
      url: autoUrl,
      payload: { ...p, name: "Borrador" },
    });
    expect(auto.json()).toMatchObject({ projectId: p.id, savedAt: expect.any(String) });
    const snap = await app.inject({ method: "GET", url: autoUrl });
    expect(snap.json()).toMatchObject({ project: { name: "Borrador" } });
    expect((await app.inject({ method: "GET", url })).json<Project>().name).toBe("Renombrado");

    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
  });

  it("settings: defaults, then persisted with ui prefs", async () => {
    const get = await app.inject({ method: "GET", url: API_ROUTES.settings });
    expect(get.json()).toEqual(DEFAULT_DASHBOARD_SETTINGS);
    const next = {
      ...DEFAULT_DASHBOARD_SETTINGS,
      theme: "dark",
      ui: {
        accent: "#7c3aed",
        density: "compact",
        layout: { grid: { root: 1 } },
        layoutPresets: [],
      },
    };
    const put = await app.inject({ method: "PUT", url: API_ROUTES.settings, payload: next });
    expect(put.statusCode).toBe(200);
    const again = await app.inject({ method: "GET", url: API_ROUTES.settings });
    expect(again.json()).toMatchObject({
      theme: "dark",
      ui: { density: "compact", layout: { grid: { root: 1 } } },
    });
    // Whole document round-trip: accent, nested opaque layout, named presets, updatedAt.
    const full = {
      ...DEFAULT_DASHBOARD_SETTINGS,
      ui: {
        accent: "#12a594",
        density: "spacious",
        layout: { grid: { root: { type: "branch", data: [1, 2] } }, panels: { media: {} } },
        layoutPresets: [
          {
            id: "lp1",
            name: "Edición",
            layout: { grid: { root: 2 } },
            createdAt: "2026-10-04T10:00:00.000Z",
          },
        ],
        updatedAt: "2026-10-04T10:00:01.000Z",
      },
    };
    await app.inject({ method: "PUT", url: API_ROUTES.settings, payload: full });
    const roundTrip = await app.inject({ method: "GET", url: API_ROUTES.settings });
    expect(roundTrip.json()).toEqual(full);
    const bad = await app.inject({
      method: "PUT",
      url: API_ROUTES.settings,
      payload: { theme: "pink" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("export presets: seeded built-ins, CRUD, built-ins not deletable", async () => {
    const list = (await app.inject({ method: "GET", url: API_ROUTES.exportPresets })).json<
      ExportPreset[]
    >();
    const ids = list.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "youtube-1080p",
        "reels-tiktok",
        "youtube-shorts",
        "gif-480",
        "webm-alpha",
      ]),
    );
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.exportPresets,
      payload: { name: "Mío", aspect: "1:1", width: 1080, height: 1080, fps: 30, crf: 22 },
    });
    expect(created.statusCode).toBe(201);
    const mine = created.json<ExportPreset>();
    expect(mine.builtIn).toBe(false);
    const url = buildRoute(API_ROUTES.exportPreset, { id: mine.id });
    const put = await app.inject({
      method: "PUT",
      url,
      payload: { ...mine, crf: 18, builtIn: true },
    });
    expect(put.json()).toMatchObject({ crf: 18, builtIn: false });
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    const yt = buildRoute(API_ROUTES.exportPreset, { id: "youtube-1080p" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: yt,
          payload: { ...list.find((p) => p.id === "youtube-1080p"), crf: 19 },
        })
      ).json(),
    ).toMatchObject({ crf: 19, builtIn: true });
    expect((await app.inject({ method: "DELETE", url: yt })).statusCode).toBe(409);
  });

  it("export endpoint validates and enqueues project.export", async () => {
    const p = (
      await app.inject({ method: "POST", url: API_ROUTES.projects, payload: { name: "E" } })
    ).json<Project>();
    const url = buildRoute(API_ROUTES.projectExport, { id: p.id });
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url, payload: { presetId: "nope" } })).statusCode,
    ).toBe(404);
    const res = await app.inject({ method: "POST", url, payload: { presetId: "youtube-1080p" } });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    await waitFor(() => app.ctx.jobs.get(jobId)!.status === "failed");
    expect(app.ctx.jobs.get(jobId)).toMatchObject({ type: "project.export", projectId: p.id });
    const log = await app.inject({
      method: "GET",
      url: buildRoute(API_ROUTES.jobLog, { id: jobId }),
    });
    expect(log.json<{ lines: string[] }>().lines.join("\n")).toContain("ERROR");
  });

  it("media: upload with safe file name, Range serving, delete", async () => {
    const content = Buffer.from("0123456789abcdefghij");
    const { payload, headers } = await multipart("../../evil name?.mp3", content, "audio/mpeg");
    const res = await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers });
    expect(res.statusCode).toBe(201);
    const asset = res.json<MediaAsset>();
    expect(asset).toMatchObject({
      kind: "audio",
      name: "evil name.mp3",
      sizeBytes: 20,
      mimeType: "audio/mpeg",
    });
    expect(asset.path).toBe(`media/${asset.id}.mp3`);
    expect(existsSync(path.join(storage, asset.path))).toBe(true);
    expect(
      app.ctx.jobs
        .list({ type: "media.probe" })
        .some((j) => (j.payload as { assetId: string }).assetId === asset.id),
    ).toBe(true);

    const fileUrl = buildRoute(API_ROUTES.mediaFile, { id: asset.id });
    const full = await app.inject({ method: "GET", url: fileUrl });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.body).toBe(content.toString());
    const part = await app.inject({ method: "GET", url: fileUrl, headers: { range: "bytes=5-9" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 5-9/20");
    expect(part.body).toBe("56789");
    expect(
      (await app.inject({ method: "GET", url: fileUrl, headers: { range: "bytes=50-" } }))
        .statusCode,
    ).toBe(416);

    // /files/* (static) also honours Range
    const stat = await app.inject({
      method: "GET",
      url: `/files/${asset.path}`,
      headers: { range: "bytes=0-3" },
    });
    expect(stat.statusCode).toBe(206);
    expect(stat.body).toBe("0123");

    expect(
      (await app.inject({ method: "GET", url: "/files/studio.db" })).statusCode,
    ).toBeGreaterThanOrEqual(400);

    const bad = await multipart("virus.exe", "x");
    expect((await app.inject({ method: "POST", url: API_ROUTES.media, ...bad })).statusCode).toBe(
      415,
    );

    const item = buildRoute(API_ROUTES.mediaItem, { id: asset.id });
    expect((await app.inject({ method: "DELETE", url: item })).statusCode).toBe(204);
    expect(existsSync(path.join(storage, asset.path))).toBe(false);
    expect((await app.inject({ method: "GET", url: item })).statusCode).toBe(404);
  });

  it("voice effects endpoint validates the extended effect list", async () => {
    const bad = await app.inject({
      method: "POST",
      url: API_ROUTES.voiceEffects,
      payload: { assetId: "x", effects: [{ type: "nope" }] },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: API_ROUTES.voiceEffects,
      payload: { assetId: "x", effects: [{ type: "chipmunk" }] },
    });
    expect(missing.statusCode).toBe(404);
    const presets = await app.inject({ method: "GET", url: API_ROUTES.voiceEffectPresets });
    expect(presets.json<unknown[]>().length).toBeGreaterThan(5);
  });

  it("CORS preflight allows PUT, PATCH and DELETE from the dashboard", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: buildRoute(API_ROUTES.project, { id: "x" }),
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": method,
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(String(res.headers["access-control-allow-methods"])).toContain(method);
    }
  });

  it("SSE streams job events with manual CORS headers", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ctrl = new AbortController();
    const res = await fetch(`${address}${API_ROUTES.jobEvents}`, {
      headers: { origin: "http://localhost:3000" },
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const reader = res.body!.getReader();
    // Unknown project: the export job goes queued -> running -> failed.
    const job = app.ctx.queue.enqueue({
      type: "project.export",
      payload: { projectId: "nope", presetId: "youtube-1080p" },
    });
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes(job.id)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("event: job");
    while (!text.includes('"status":"failed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain(`"jobId":"${job.id}","status":"queued"`);
    expect(text).toContain(`"jobId":"${job.id}","status":"running"`);
    expect(text).toContain('"status":"failed"');
    ctrl.abort();
  });
});
