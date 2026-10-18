import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  STYLE_API_ROUTES,
  buildRoute,
  type AgentPlanRecord,
  type Job,
  type MediaAsset,
  type Project,
  type StyleAnalysisRecord,
  type StyleAnalyzeJobResult,
  type StyleApplyResponse,
  type StyleInferJobResult,
  type StylePreset,
  type StylePresetDraft,
} from "@studio/shared";
import { projectSceneStarts } from "../src/routes/style.js";
import { makeApp, waitFor } from "./helpers.js";

/** Sprint 3b «Perfil de estilo» routes + style.* jobs against a fake workers service. */

const PRESET: StylePresetDraft = {
  name: "Reels dinámico",
  canvas: "9:16",
  cut_rhythm: { target_shot_s: 2, remove_silences: true, min_silence_ms: 300 },
  captions: { style: "reels", animated: true, position: "center" },
  titles: { template: "title-card", params: { title: "Hola" } },
  lower_third: { params: { name: "Ana", role: "Chef" } },
  transitions: { type: "fade", every_n_cuts: 2 },
  music: { duck: true, volume_db: -16 },
  zoom_punch_in: { every_s: 4, scale: 1.2 },
  export_preset: "reels-tiktok",
  notes_es: "Cortes rápidos.",
};

const PACK_DETAIL =
  "Falta el modelo de visión local «qwen2.5vl:3b» (paquete vision-llm, ~3,2 GB). Descargalo en " +
  "Ajustes → Paquetes de IA o en una terminal: `ollama pull qwen2.5vl:3b`; o usá la Consola Claude.";

function analysisJson(outputDir: string) {
  return {
    version: 1,
    duration_s: 8,
    fps: 25,
    canvas: { w: 320, h: 180, aspect: "16:9" },
    scenes: [
      { start: 0, end: 2 },
      { start: 2, end: 8 },
    ],
    scenes_method: "ffmpeg",
    shot_stats: { count: 2, mean_s: 4, median_s: 4, cuts_per_min: 7.5, histogram: [] },
    motion: {
      zoom_events: [{ t: 2, kind: "punch_in", scale: 1.2 }],
      pan_estimate: { moving_ratio: 0, mean_speed: 0, level: "static" },
    },
    audio: {
      has_audio: true,
      loudness_lufs: -14,
      speech_ratio: 0.7,
      music_detected: true,
      silence_ratio: 0.05,
    },
    text_on_screen: [{ t: 0.5, text: "HOLA", bbox: [0.1, 0.1, 0.5, 0.1] }],
    contact_sheet_path: `${outputDir}/contact_sheet.png`,
    contact_sheet: { columns: 4, rows: 6, width: 1300, height: 1108, times: [0.17] },
    thumbnails: [`${outputDir}/thumbs/thumb_01.jpg`],
    warnings: [],
  };
}

describe("style routes and jobs (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const state: {
    visionInstalled: boolean;
    inferStatus?: number;
    inferBody?: unknown;
    seen: Record<string, Record<string, unknown>>;
  } = { visionInstalled: true, seen: {} };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        state.seen[req.url!] = json;
        if (req.url === "/packs")
          return send(200, [
            {
              id: "vision-llm",
              name_es: "Modelo de visión local (Ollama + Qwen2.5-VL 3B)",
              size_bytes: 3.2e9,
              installed: state.visionInstalled,
              files: [],
            },
          ]);
        if (req.url === "/style/analyze") {
          const out = String(json.output_dir);
          mkdirSync(path.join(storage, out, "thumbs"), { recursive: true });
          writeFileSync(
            path.join(storage, out, "analysis.json"),
            JSON.stringify(analysisJson(out)),
          );
          writeFileSync(path.join(storage, out, "contact_sheet.png"), "png");
          writeFileSync(path.join(storage, out, "thumbs", "thumb_01.jpg"), "jpg");
          return send(200, { task_id: "t-analyze", status: "queued" });
        }
        if (req.url === "/style/tasks/t-analyze") {
          const out = String(state.seen["/style/analyze"]?.output_dir);
          return send(200, {
            task_id: "t-analyze",
            status: "done",
            progress: 1,
            result: { analysis_path: `${out}/analysis.json`, analysis: {} },
          });
        }
        if (req.url === "/style/infer") {
          if (state.inferStatus) return send(state.inferStatus, state.inferBody);
          return send(200, { preset: PRESET, model: "qwen2.5vl:3b", latency_ms: 900, attempts: 1 });
        }
        return send(404, { detail: "Not Found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app, storage } = await makeApp({ WORKERS_URL: url }));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    state.visionInstalled = true;
    state.inferStatus = undefined;
    state.inferBody = undefined;
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload });
  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      30_000,
    );
    return app.ctx.jobs.get(id)!;
  };

  function video(name = "referencia.mp4", scenes?: MediaAsset["scenes"]): MediaAsset {
    const id = `v${Math.random().toString(36).slice(2, 8)}`;
    return app.ctx.repos.media.insert({
      id,
      kind: "video",
      name,
      path: `media/${id}.mp4`,
      sizeBytes: 1,
      durationSec: 8,
      width: 320,
      height: 180,
      fps: 25,
      hasVideo: true,
      hasAudio: true,
      ...(scenes && { scenes }),
      createdAt: new Date().toISOString(),
    });
  }

  async function analyze(asset: MediaAsset): Promise<StyleAnalyzeJobResult> {
    const res = await post(STYLE_API_ROUTES.analyze, { assetId: asset.id });
    expect(res.statusCode, res.body).toBe(202);
    const job = await jobEnd(res.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    return job.result as StyleAnalyzeJobResult;
  }

  it("analyze -> asset kind analysis + contact sheet under /files (+ transcript sent)", async () => {
    const ref = video();
    // a finished transcription of the reference is sent along (speech ratio + excerpt)
    const tj = app.ctx.jobs.create({ type: "subtitles.transcribe", payload: { assetId: ref.id } });
    app.ctx.jobs.update(tj.id, { status: "running" });
    app.ctx.jobs.update(tj.id, {
      status: "succeeded",
      result: { transcript: { segments: [{ start: 0, end: 1.5, text: "hola" }] } },
    });
    const result = await analyze(ref);
    const sent = state.seen["/style/analyze"]!;
    expect(sent).toMatchObject({ path: ref.path, max_frames: 24 });
    expect(sent.output_dir).toMatch(/^renders\/style\//);
    expect(sent.transcript).toEqual([{ start: 0, end: 1.5, text: "hola" }]);
    const asset = app.ctx.repos.media.get(result.analysisId)!;
    expect(asset.kind).toBe("analysis");
    expect(asset.name).toBe("Perfil de estilo · referencia.mp4");
    expect(asset.thumbnailPath).toBe(result.contactSheetPath);
    expect(result.analysis.source_asset_id).toBe(ref.id);
    const sheet = await app.inject({ method: "GET", url: `/files/${result.contactSheetPath}` });
    expect(sheet.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: `${STYLE_API_ROUTES.analyses}?assetId=${ref.id}`,
    });
    const records = list.json<StyleAnalysisRecord[]>();
    expect(records).toHaveLength(1);
    expect(records[0]!.analysis.shot_stats.count).toBe(2);
    const one = await app.inject({
      method: "GET",
      url: buildRoute(STYLE_API_ROUTES.analysis, { id: result.analysisId }),
    });
    expect(one.json<StyleAnalysisRecord>().sourceAssetId).toBe(ref.id);
  });

  it("analyze refuses non-videos and unknown assets", async () => {
    const img = app.ctx.repos.media.insert({
      id: "img1",
      kind: "image",
      name: "foto.png",
      path: "media/img1.png",
      sizeBytes: 1,
      createdAt: new Date().toISOString(),
    });
    expect((await post(STYLE_API_ROUTES.analyze, { assetId: img.id })).statusCode).toBe(400);
    expect((await post(STYLE_API_ROUTES.analyze, { assetId: "nope" })).statusCode).toBe(404);
    expect((await post(STYLE_API_ROUTES.analyze, {})).statusCode).toBe(400);
  });

  it("infer: 409 PACK_REQUIRED (console hint) when vision-llm is missing, else a validated draft", async () => {
    const { analysisId } = await analyze(video());
    state.visionInstalled = false;
    const missing = await post(STYLE_API_ROUTES.infer, { analysisId });
    expect(missing.statusCode).toBe(409);
    const body = missing.json<{ error: string; packId: string; message: string }>();
    expect(body).toMatchObject({ error: "PACK_REQUIRED", packId: "vision-llm" });
    expect(body.message).toMatch(/o usá la Consola Claude/);

    state.visionInstalled = true;
    const ok = await post(STYLE_API_ROUTES.infer, { analysisId });
    expect(ok.statusCode).toBe(202);
    const job = await jobEnd(ok.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const result = job.result as StyleInferJobResult;
    expect(result.preset.name).toBe("Reels dinámico");
    expect(result.model).toBe("qwen2.5vl:3b");
    expect(state.seen["/style/infer"]).toMatchObject({
      analysis_path: expect.stringMatching(/analysis\.json$/),
      contact_sheet_path: expect.stringMatching(/contact_sheet\.png$/),
    });

    // the workers answer PACK_REQUIRED inside the job: failed job with the body + console text
    state.inferStatus = 409;
    state.inferBody = {
      error: "PACK_REQUIRED",
      code: "PACK_REQUIRED",
      packId: "vision-llm",
      name_es: "Modelo de visión local",
      size_bytes: 3.2e9,
      detail: PACK_DETAIL,
    };
    const again = await post(STYLE_API_ROUTES.infer, { analysisId });
    const failed = await jobEnd(again.json<{ jobId: string }>().jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/o usá la Consola Claude/);
    expect(failed.result).toMatchObject({ error: "PACK_REQUIRED", packId: "vision-llm" });

    // an invalid draft never reaches the user as a preset
    state.inferStatus = undefined;
    state.inferBody = undefined;
    expect((await post(STYLE_API_ROUTES.infer, { analysisId: "nope" })).statusCode).toBe(404);
  });

  it("presets: create, list, overwrite, validate (Spanish) and delete", async () => {
    const bad = await post(STYLE_API_ROUTES.presets, { ...PRESET, canvas: "4:3" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string; message: string } }>().error.code).toBe(
      "PRESET_INVALID",
    );
    expect(bad.body).toMatch(/canvas/);
    const created = await post(STYLE_API_ROUTES.presets, {
      ...PRESET,
      source: { via: "claude", assetId: "v1" },
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json<StylePreset>();
    expect(preset.id).toBeTruthy();
    expect(preset.source).toEqual({ via: "claude", assetId: "v1" });
    const renamed = await post(STYLE_API_ROUTES.presets, {
      ...PRESET,
      id: preset.id,
      name: "Otro",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<StylePreset>().created_at).toBe(preset.created_at);
    const list = (await app.inject({ method: "GET", url: STYLE_API_ROUTES.presets })).json<
      StylePreset[]
    >();
    expect(list.find((p) => p.id === preset.id)?.name).toBe("Otro");
    const url = buildRoute(STYLE_API_ROUTES.preset, { id: preset.id });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
  });

  it("apply: compile -> Assistant plan (proposed) -> agent.apply runs the confirmed ops", async () => {
    const ref = video("entrevista.mp4", [
      { start: 0, end: 3 },
      { start: 3, end: 8 },
    ]);
    const music = app.ctx.repos.media.insert({
      id: `m${Math.random().toString(36).slice(2, 8)}`,
      kind: "audio",
      name: "musica.mp3",
      path: "media/musica.mp3",
      sizeBytes: 1,
      durationSec: 8,
      hasAudio: true,
      createdAt: new Date().toISOString(),
    });
    const project = app.ctx.repos.projects.create({ name: "Estilo" });
    const vt = project.tracks.find((t) => t.kind === "video")!;
    vt.clips.push({
      id: "c1",
      trackId: vt.id,
      assetId: ref.id,
      start: 0,
      in: 0,
      out: 8,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    });
    const at = project.tracks.find((t) => t.kind === "audio")!;
    at.clips.push({
      id: "a1",
      trackId: at.id,
      assetId: music.id,
      start: 0,
      in: 0,
      out: 8,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    });
    app.ctx.repos.projects.save(project.id, project);
    expect(
      projectSceneStarts(app.ctx.repos.projects.get(project.id)!, (id) =>
        app.ctx.repos.media.get(id),
      ),
    ).toEqual([0, 3]);

    const preset = (await post(STYLE_API_ROUTES.presets, PRESET)).json<StylePreset>();
    const res = await post(buildRoute(STYLE_API_ROUTES.apply, { id: preset.id }), {
      projectId: project.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json<StyleApplyResponse>();
    expect(out.planId).toBe(out.plan.id);
    expect(out.plan.status).toBe("proposed");
    expect(out.plan.command).toBe("Aplicar el perfil de estilo «Reels dinámico»");
    const ops = out.plan.plan!.ops.map((o) => o.op);
    expect(ops).toEqual([
      "set_canvas",
      "cut_silences",
      "detect_scenes",
      "add_captions",
      "add_motion",
      "add_motion",
      "set_volume",
      "export",
    ]);
    // lower third at the 2nd scene (3 s on the timeline)
    expect(out.plan.resolved[5]).toMatchObject({ template: "lower-third", t: 3 });
    expect(out.preview_es).toHaveLength(ops.length);
    expect(out.preview_es[0]).toBe("Lienzo 1080×1920");
    expect(out.risks.join(" ")).toMatch(/xport/);
    expect(out.notes_es.join(" ")).toMatch(/fundido/);
    expect(out.notes_es.join(" ")).toMatch(/×1\.2/);
    const plans = (
      await app.inject({ method: "GET", url: `${API_ROUTES.agentPlans}?projectId=${project.id}` })
    ).json<AgentPlanRecord[]>();
    expect(plans[0]?.id).toBe(out.planId);

    // export needs the separate confirmation; canvas + music volume apply right away
    const refused = await post(API_ROUTES.agentApply, { planId: out.planId, ops: [0, 6, 7] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("CONFIRM_REQUIRED");
    const applied = await post(API_ROUTES.agentApply, { planId: out.planId, ops: [0, 6] });
    expect(applied.statusCode, applied.body).toBe(202);
    const job = await jobEnd(applied.json<{ jobId: string }>().jobId);
    expect(job.status, job.error).toBe("succeeded");
    const after = app.ctx.repos.projects.get(project.id) as Project;
    expect(after.settings).toMatchObject({ width: 1080, height: 1920 });
    const vol = after.tracks.find((t) => t.kind === "audio")!.clips[0]!.volume;
    expect(vol).toBeCloseTo(10 ** (-16 / 20), 3);
    expect(app.ctx.repos.agentPlans.get(out.planId)?.status).toBe("applied");

    const missing = await post(buildRoute(STYLE_API_ROUTES.apply, { id: "nope" }), {
      projectId: project.id,
    });
    expect(missing.statusCode).toBe(404);
    const noProject = await post(buildRoute(STYLE_API_ROUTES.apply, { id: preset.id }), {
      projectId: "nope",
    });
    expect(noProject.statusCode).toBe(404);
  });
});
