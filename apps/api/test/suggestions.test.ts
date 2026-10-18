import http from "node:http";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AgentPlanRecordSchema,
  API_ROUTES,
  ImportSuggestionSchema,
  SuggestionsResponseSchema,
  type MediaAsset,
  type Project,
  type SuggestionsResponse,
} from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { suggestionsService } from "../src/services/suggestions/service.js";
import { makeApp, waitFor } from "./helpers.js";

/** Fake workers: /analyze/suggest → task that finishes after `delayMs` with `result`. */
interface FakeState {
  result: Record<string, unknown>;
  delayMs: number;
  submitted: Record<string, unknown>[];
  canceled: string[];
  tasks: Map<string, { started: number }>;
}

function analysisResult(over: Record<string, unknown> = {}) {
  return {
    duration_s: 12,
    noise_floor_db: -90,
    silence_threshold_db: -50,
    silences: [
      [2, 3.5],
      [5.5, 6.5],
      [8.5, 9.5],
    ],
    lufs_i: -30,
    lra: 2,
    true_peak_db: -12,
    ...over,
  };
}

describe("sprint 6 M3 suggestions api", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage: string;
  const fake: FakeState = {
    result: analysisResult(),
    delayMs: 50,
    submitted: [],
    canceled: [],
    tasks: new Map(),
  };

  beforeAll(async () => {
    let n = 0;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const url = req.url ?? "";
        if (url === "/analyze/suggest" && req.method === "POST") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          fake.submitted.push(body);
          const id = `t${++n}`;
          fake.tasks.set(id, { started: Date.now() });
          return send(200, { task_id: id, status: "queued" });
        }
        const m = /^\/analyze\/tasks\/(\w+)(\/cancel)?$/.exec(url);
        if (m) {
          const [, id, cancel] = m;
          const t = fake.tasks.get(id!);
          if (!t) return send(404, { detail: "no", code: "TASK_NOT_FOUND" });
          if (cancel) {
            fake.canceled.push(id!);
            return send(200, { task_id: id, canceled: true, was: "running" });
          }
          const canceled = fake.canceled.includes(id!);
          const done = Date.now() - t.started >= fake.delayMs;
          return send(200, {
            task_id: id,
            kind: "suggest.analyze",
            target: "x",
            status: canceled ? "canceled" : done ? "done" : "running",
            progress: done ? 1 : 0.4,
            done: done ? 12 : 5,
            total: 12,
            stage_es: "Midiendo silencios y volumen",
            ...(done && !canceled && { result: fake.result }),
          });
        }
        return send(404, { detail: "no" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    ({ app, storage } = await makeApp({ WORKERS_URL: `http://127.0.0.1:${port}` }));
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    fake.result = analysisResult();
    fake.delayMs = 50;
    fake.submitted.length = 0;
    fake.canceled.length = 0;
  });
  afterEach(async () => {
    await app.ctx.queue.onIdle();
  });

  let seq = 0;
  function setup(opts: { durationSec?: number; volume?: number } = {}): {
    asset: MediaAsset;
    project: Project;
  } {
    const id = `a${++seq}`;
    const rel = `media/${id}.wav`;
    mkdirSync(path.join(storage, "media"), { recursive: true });
    writeFileSync(path.join(storage, rel), Buffer.alloc(1000 + seq));
    const asset = app.ctx.repos.media.insert({
      id,
      kind: "video",
      name: `clip-${id}.mp4`,
      path: rel,
      sizeBytes: 1000 + seq,
      durationSec: opts.durationSec ?? 12,
      hasAudio: true,
      hasVideo: true,
      createdAt: new Date().toISOString(),
    });
    const created = app.ctx.repos.projects.create({ name: `P${seq}` });
    const video = created.tracks.find((t) => t.kind === "video")!;
    video.clips.push({
      id: `c${seq}`,
      trackId: video.id,
      assetId: id,
      start: 0,
      in: 0,
      out: 12,
      speed: 1,
      volume: opts.volume ?? 1,
      opacity: 1,
      voiceEffects: [],
    } as never);
    const project = app.ctx.repos.projects.save(created.id, created)!;
    return { asset, project };
  }

  const getSuggestions = async (projectId: string): Promise<SuggestionsResponse> => {
    const res = await app.inject({
      method: "GET",
      url: API_ROUTES.suggestions.replace(":id", projectId),
    });
    expect(res.statusCode).toBe(200);
    return SuggestionsResponseSchema.parse(res.json());
  };

  const analyze = async (assetId: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.mediaAnalyze.replace(":id", assetId),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    await waitFor(() => {
      const s = app.ctx.jobs.get(jobId)?.status;
      return s === "succeeded" || s === "failed" || s === "canceled";
    });
    return app.ctx.jobs.get(jobId)!;
  };

  it("a succeeded media.probe queues suggest.analyze in the background lane with priority -10", async () => {
    const { asset } = setup();
    // Simulate the end of the probe: the hook listens to the job events.
    const probe = app.ctx.jobs.create({ type: "media.probe", payload: { assetId: asset.id } });
    app.ctx.jobs.update(probe.id, { status: "running" });
    app.ctx.jobs.update(probe.id, { status: "succeeded", progress: 1 });
    app.ctx.queue.emit("job", { jobId: probe.id, status: "succeeded", progress: 1 });
    const job = app.ctx.queue.activeJob("suggest.analyze", (p) => p.assetId === asset.id);
    expect(job).toBeDefined();
    const row = app.ctx.db.prepare(`SELECT priority FROM jobs WHERE id = ?`).get(job!.id) as {
      priority: number;
    };
    expect(row.priority).toBe(-10);
    expect(app.ctx.queue.laneOf("suggest.analyze")).toBe("background");
    await waitFor(() => app.ctx.jobs.get(job!.id)?.status === "succeeded");
    expect(fake.submitted.at(-1)).toMatchObject({ input_path: asset.path, priority: 5 });
  });

  it("digital silence (lufs_i / lra / true_peak_db null from the worker) still saves the analysis (audit S6 E5)", async () => {
    // Through the real workers client (stripNulls drops the nulls of the JSON).
    fake.result = analysisResult({ lufs_i: null, lra: null, true_peak_db: null });
    const { asset, project } = setup();
    const job = await analyze(asset.id);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("succeeded");
    const saved = (job.result as { analysis: { lufs_i: unknown; true_peak_db: unknown } }).analysis;
    expect(saved.lufs_i).toBeNull();
    expect(saved.true_peak_db).toBeNull();
    const body = await getSuggestions(project.id);
    expect(body.suggestions.map((s) => s.kind)).not.toContain("low_voice");
  });

  it("analysis → 2 cards (silencios, voz baja) with valid plans; progress has stage_es", async () => {
    const { asset, project } = setup();
    const job = await analyze(asset.id);
    expect(job.status).toBe("succeeded");
    expect(job.detail?.stage_es).toBe("Midiendo silencios y volumen");
    expect(job.detail?.unit).toBe("seconds");
    const body = await getSuggestions(project.id);
    expect(body.analyzing).toEqual([]);
    expect(body.suggestions.map((s) => s.kind).sort()).toEqual(["low_voice", "silences"]);
    for (const s of body.suggestions) expect(() => ImportSuggestionSchema.parse(s)).not.toThrow();
    const sil = body.suggestions.find((s) => s.kind === "silences")!;
    expect(sil.title_es).toBe("3 silencios largos = 3,5 s de 12 s");
    const low = body.suggestions.find((s) => s.kind === "low_voice")!;
    // −30 LUFS wants +16 dB; the true peak (−12 dBTP) limits it to +11 dB.
    expect(low.plan.ops).toEqual([{ op: "set_volume", clip: { id: `c${seq}` }, volume_db: 11 }]);

    const planRes = await app.inject({
      method: "POST",
      url: API_ROUTES.suggestionPlan.replace(":id", project.id).replace(":sid", sil.id),
    });
    expect(planRes.statusCode).toBe(201);
    const record = AgentPlanRecordSchema.parse(planRes.json());
    expect(record.ok).toBe(true);
    expect(record.status).toBe("proposed");
    expect(record.route).toBe("deterministic");
    expect(record.preview_es[0]).toMatch(/Cortar silencios/);
    expect(app.ctx.repos.agentPlans.get(record.id)?.warnings).toContain(`suggestion:${sil.id}`);
  });

  it("does not repeat an analysis with the same file_sig; force or a changed file does", async () => {
    const { asset } = setup();
    await analyze(asset.id);
    expect(fake.submitted).toHaveLength(1);
    const again = await analyze(asset.id);
    expect(again.result).toMatchObject({ cached: true });
    expect(fake.submitted).toHaveLength(1);
    expect(suggestionsService(app.ctx).autoAnalyze(asset.id)).toBeUndefined();
    await analyze(asset.id, { force: true });
    expect(fake.submitted).toHaveLength(2);
  });

  it("applying the low_voice plan marks it applied; undo opens it again", async () => {
    const { asset, project } = setup();
    await analyze(asset.id);
    const low = (await getSuggestions(project.id)).suggestions.find((s) => s.kind === "low_voice")!;
    const record = AgentPlanRecordSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: API_ROUTES.suggestionPlan.replace(":id", project.id).replace(":sid", low.id),
        })
      ).json(),
    );
    const apply = await app.inject({
      method: "POST",
      url: API_ROUTES.agentApply,
      payload: { planId: record.id },
    });
    expect(apply.statusCode).toBe(202);
    const { jobId } = apply.json() as { jobId: string };
    await waitFor(() => app.ctx.jobs.get(jobId)?.status === "succeeded");
    const clip = app.ctx.repos.projects.get(project.id)!.tracks.flatMap((t) => t.clips)[0]!;
    expect(20 * Math.log10(clip.volume)).toBeCloseTo(11, 1);
    let after = (await getSuggestions(project.id)).suggestions.find((s) => s.id === low.id)!;
    expect(after.status).toBe("applied");

    const undo = await app.inject({
      method: "POST",
      url: API_ROUTES.agentPlanUndo.replace(":id", record.id),
      payload: {},
    });
    expect(undo.statusCode).toBe(200);
    after = (await getSuggestions(project.id)).suggestions.find((s) => s.id === low.id)!;
    expect(after.status).toBe("open");
  });

  it("dismiss hides the card; muteKind silences the kind everywhere (settings)", async () => {
    const { asset, project } = setup();
    await analyze(asset.id);
    const list = (await getSuggestions(project.id)).suggestions;
    const sil = list.find((s) => s.kind === "silences")!;
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.suggestionDismiss.replace(":id", project.id).replace(":sid", sil.id),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(ImportSuggestionSchema.parse(res.json()).status).toBe("dismissed");
    expect(
      (await getSuggestions(project.id)).suggestions.find((s) => s.id === sil.id)?.status,
    ).toBe("dismissed");
    const low = list.find((s) => s.kind === "low_voice")!;
    await app.inject({
      method: "POST",
      url: API_ROUTES.suggestionDismiss.replace(":id", project.id).replace(":sid", low.id),
      payload: { muteKind: true },
    });
    const settings = await app.inject({ method: "GET", url: API_ROUTES.suggestionSettings });
    expect(settings.json()).toEqual({ enabled: true, mutedKinds: ["low_voice"] });
    // another project with the same kind of audio gets no low_voice card
    const other = setup();
    await analyze(other.asset.id);
    const kinds = (await getSuggestions(other.project.id)).suggestions.map((s) => s.kind);
    expect(kinds).toEqual(["silences"]);
    await app.inject({
      method: "PUT",
      url: API_ROUTES.suggestionSettings,
      payload: { enabled: true, mutedKinds: [] },
    });
  });

  it("SUGGESTION_NOT_FOUND and SUGGESTION_STALE (clip changed or file changed)", async () => {
    const { asset, project } = setup();
    await analyze(asset.id);
    const nf = await app.inject({
      method: "POST",
      url: API_ROUTES.suggestionPlan.replace(":id", project.id).replace(":sid", "nope"),
    });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe("SUGGESTION_NOT_FOUND");
    const sil = (await getSuggestions(project.id)).suggestions.find((s) => s.kind === "silences")!;
    // trim the clip so the silences no longer fit: the card becomes stale
    const p = app.ctx.repos.projects.get(project.id)!;
    const clip = p.tracks.flatMap((t) => t.clips)[0]!;
    clip.out = 1.9;
    app.ctx.repos.projects.save(p.id, p);
    const stale = await app.inject({
      method: "POST",
      url: API_ROUTES.suggestionPlan.replace(":id", project.id).replace(":sid", sil.id),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("SUGGESTION_STALE");
    // changing the file (size/mtime) makes the remaining open card stale too
    const abs = path.join(storage, asset.path);
    writeFileSync(abs, Buffer.alloc(5));
    utimesSync(abs, new Date(), new Date(Date.now() + 5000));
    const list = (await getSuggestions(project.id)).suggestions;
    expect(list.every((s) => s.status === "stale")).toBe(true);
  });

  it("without workers the background job fails with WORKERS_UNAVAILABLE", async () => {
    const { app: offline } = await makeApp();
    try {
      const asset = offline.ctx.repos.media.insert({
        id: "x1",
        kind: "audio",
        name: "a.wav",
        path: "media/x1.wav",
        sizeBytes: 1,
        createdAt: new Date().toISOString(),
      });
      const dir = path.join(offline.ctx.config.storageDir, "media");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "x1.wav"), "x");
      const job = suggestionsService(offline.ctx).enqueueAnalysis(asset.id);
      await waitFor(() => offline.ctx.jobs.get(job.id)?.status === "failed");
      expect(offline.ctx.jobs.get(job.id)?.errorCode).toBe("WORKERS_UNAVAILABLE");
    } finally {
      await offline.close();
    }
  });

  it("canceling the job cancels the worker task", async () => {
    const { asset } = setup();
    fake.delayMs = 60_000;
    const job = suggestionsService(app.ctx).enqueueAnalysis(asset.id);
    await waitFor(
      () => fake.submitted.length > 0 && app.ctx.jobs.get(job.id)?.status === "running",
    );
    await waitFor(() => (app.ctx.jobs.get(job.id)?.detail?.done ?? 0) > 0);
    app.ctx.queue.cancel(job.id);
    await waitFor(() => app.ctx.jobs.get(job.id)?.status === "canceled");
    await waitFor(() => fake.canceled.length > 0);
  });

  it("automatic analysis: at most 3 active, the rest wait; long videos (> 30 min) only on request", async () => {
    fake.delayMs = 400;
    const svc = suggestionsService(app.ctx);
    const assets = [setup(), setup(), setup(), setup()].map((s) => s.asset);
    const jobs = assets.map((a) => svc.autoAnalyze(a.id));
    expect(jobs.filter(Boolean)).toHaveLength(3);
    expect(svc.analyzingAssets().has(assets[3]!.id)).toBe(true);
    await waitFor(() => fake.submitted.length === 4, 20_000);
    const long = setup({ durationSec: 3600 }).asset;
    expect(svc.autoAnalyze(long.id)).toBeUndefined();
    await app.ctx.queue.onIdle();
  });
});
