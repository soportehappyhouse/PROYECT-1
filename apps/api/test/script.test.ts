import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  FitDurationPreviewSchema,
  ScriptCutsResponseSchema,
  ScriptSchema,
  timelineDuration,
  validateEditPlan,
  type AgentPlanRecord,
  type Job,
  type Project,
} from "@studio/shared";
import { makeApp, waitFor } from "./helpers.js";
import { scriptSegments } from "./script-fixtures.js";

/** Sprint 6 M1: routes /api/projects/:id/script* and job script.transcribe (fake workers). */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const DURATION = 60;
const WINDOW = 0.005;

describe.skipIf(!hasFfmpeg)("Guion (script) api", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  let projectId = "";
  const seen: Record<string, unknown>[] = [];

  /** Envelope: −40 dB everywhere, a quiet −90 dB dip at 1.03 s (inside the gap before the 1st «eh»). */
  function writeArtifacts(base: string): void {
    const dir = path.join(storage, base);
    mkdirSync(dir, { recursive: true });
    const rms = new Float32Array(Math.ceil(DURATION / WINDOW)).fill(-40);
    rms[205] = -90;
    rms[206] = -90;
    writeFileSync(path.join(dir, "script-rms.f32"), Buffer.from(rms.buffer));
    const audio = {
      noise_floor_db: -60,
      window_ms: 5,
      rms_db_path: `${base}/script-rms.f32`,
      // A voiced «eh» Whisper did not write, inside the pause after sentence 0 (3.8–5.3 s).
      gaps: [{ start: 3.8, end: 5.3, rms_db: -30, voiced: true }],
    };
    writeFileSync(path.join(dir, "script-audio.json"), JSON.stringify(audio));
    (globalThis as { __scriptAudio?: unknown }).__scriptAudio = audio;
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const url = req.url ?? "";
        if (req.method === "POST" && url === "/transcribe/words") {
          const json = JSON.parse(body) as Record<string, unknown>;
          seen.push(json);
          writeArtifacts(String(json.output_base));
          return send(200, { task_id: "t1", status: "queued" });
        }
        if (req.method === "GET" && url === "/transcribe/tasks/t1")
          return send(200, {
            task_id: "t1",
            kind: "stt.words",
            target: "x",
            status: "done",
            progress: 1,
            done: DURATION,
            total: DURATION,
            stage_es: "Transcribiendo palabras · 1:00 de 1:00",
            result: {
              transcript: { language: "es", durationSec: DURATION, segments: scriptSegments() },
              audio: (globalThis as { __scriptAudio?: unknown }).__scriptAudio,
            },
          });
        send(404, { detail: "no", code: "NOT_FOUND" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    ({ app, storage } = await makeApp({
      WORKERS_URL: `http://127.0.0.1:${port}`,
      FFMPEG_PATH: "ffmpeg",
    }));

    const rel = "media/guion.mp4";
    mkdirSync(path.join(storage, "media"), { recursive: true });
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=gray:s=64x64:r=5:d=${DURATION}`,
      "-f",
      "lavfi",
      "-i",
      `sine=f=220:d=${DURATION}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path.join(storage, rel),
    ]);
    app.ctx.repos.media.insert({
      id: "asset1",
      kind: "video",
      name: "guion.mp4",
      path: rel,
      sizeBytes: 1,
      durationSec: DURATION,
      width: 64,
      height: 64,
      fps: 5,
      hasVideo: true,
      hasAudio: true,
      createdAt: new Date().toISOString(),
    });
    const created = app.ctx.repos.projects.create({ name: "Guion" });
    const video = created.tracks.find((t) => t.kind === "video")!;
    video.clips.push({
      id: "c1",
      trackId: video.id,
      assetId: "asset1",
      start: 0,
      in: 0,
      out: DURATION,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    });
    app.ctx.repos.projects.save(created.id, created);
    projectId = created.id;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const url = (route: string) => buildRoute(route, { id: projectId });

  it("GET script without subtitles: empty script; cuts/fit answer 409 SCRIPT_EMPTY", async () => {
    const res = await app.inject({ url: url(API_ROUTES.script) });
    expect(res.statusCode).toBe(200);
    expect(ScriptSchema.parse(res.json()).words).toHaveLength(0);
    const cuts = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptCuts),
      payload: { fillers: "safe" },
    });
    expect(cuts.statusCode).toBe(409);
    expect(cuts.json().error.code).toBe("SCRIPT_EMPTY");
    const fit = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptFit),
      payload: { target_s: 45 },
    });
    expect(fit.json().error.code).toBe("SCRIPT_EMPTY");
  });

  it("script.transcribe with a fake worker -> subtitles with words + audio artifact", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptTranscribe),
      payload: { clipId: "c1" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    let job: Job | undefined;
    await waitFor(async () => {
      job = (await app.inject({ url: `/api/jobs/${jobId}` })).json() as Job;
      return ["succeeded", "failed", "canceled"].includes(job.status);
    }, 30_000);
    expect(job!.status, job!.error ?? "").toBe("succeeded");
    expect(seen[0]).toMatchObject({
      input_path: `tmp/${jobId}.wav`,
      clip_in_s: 0,
      clip_out_s: DURATION,
      output_base: `renders/${jobId}`,
      language: "es",
    });
    const project = app.ctx.repos.projects.get(projectId)!;
    expect(project.subtitles).toHaveLength(10);
    expect(project.subtitles[0]!.words).toHaveLength(3);
    const result = job!.result as { words: number; segments: unknown[]; voiced_gaps: number };
    expect(result.words).toBe(28);
    expect(result.voiced_gaps).toBe(1);

    const script = ScriptSchema.parse((await app.inject({ url: url(API_ROUTES.script) })).json());
    expect(script.audio).toEqual({ jobId, noise_floor_db: -60 });
    expect(script.stats.words).toBe(28);
    // 8 «eh» + 1 acoustic gap; 9 long pauses, one of them now holds the acoustic «eh».
    expect(script.stats.fillers.safe).toBe(9);
    expect(script.stats.long_pauses).toBe(8);
    expect(script.stale).toBe(false);
  });

  it("cuts: the edge moves to the energy minimum (synthetic .f32)", async () => {
    const script = ScriptSchema.parse((await app.inject({ url: url(API_ROUTES.script) })).json());
    const eh = script.words.find((w) => w.text === "eh")!;
    const res = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptCuts),
      payload: { wordIds: [eh.id] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = ScriptCutsResponseSchema.parse(res.json());
    expect(body.cuts).toHaveLength(1);
    // Without energy it would be 1.0 + 60 ms = 1.06; the dip is at 1.025–1.035.
    expect(body.cuts[0]!.start).toBeGreaterThanOrEqual(1.02);
    expect(body.cuts[0]!.start).toBeLessThanOrEqual(1.036);
    expect(body.cuts[0]!.end).toBeCloseTo(1.74, 3);
    expect(body.cuts[0]!.fade_ms).toBe(12);
  });

  it("cuts with nothing cuttable -> 422 SCRIPT_NOTHING_TO_CUT", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptCuts),
      payload: { wordIds: ["99:99"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SCRIPT_NOTHING_TO_CUT");
  });

  it("fit 60 -> 45 s: preview within the tolerance and a valid plan", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptFit),
      payload: { target_s: 45 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const fit = FitDurationPreviewSchema.parse(res.json());
    expect(fit.from_s).toBe(DURATION);
    expect(fit.reached).toBe(true);
    expect(fit.to_s).toBeGreaterThanOrEqual(44.5);
    expect(fit.to_s).toBeLessThanOrEqual(45.5);
    expect(fit.groups[0]!.level).toBe("pauses");
    const plan = validateEditPlan(fit.plan);
    expect(plan.ok).toBe(true);
  });

  it("fit: the preview duration is exactly what applying its plan gives (energy refined)", async () => {
    const fit = FitDurationPreviewSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: url(API_ROUTES.scriptFit),
          payload: { target_s: 45 },
        })
      ).json(),
    );
    const rec = (
      await app.inject({
        method: "POST",
        url: "/api/console/plans",
        payload: { projectId, plan: fit.plan },
      })
    ).json() as AgentPlanRecord;
    expect(rec.ok, JSON.stringify(rec.unresolved)).toBe(true);
    const confirmedIndexes = rec.resolved.map((_, i) => i);
    const apply = await app.inject({
      method: "POST",
      url: API_ROUTES.agentApply,
      payload: { planId: rec.id, confirmedIndexes },
    });
    expect(apply.statusCode, apply.body).toBe(202);
    const { jobId } = apply.json() as { jobId: string };
    let job: Job | undefined;
    await waitFor(async () => {
      job = (await app.inject({ url: `/api/jobs/${jobId}` })).json() as Job;
      return ["succeeded", "failed", "canceled"].includes(job.status);
    });
    expect(job!.status, job!.error ?? "").toBe("succeeded");
    const after = timelineDuration(app.ctx.repos.projects.get(projectId)!);
    expect(Math.abs(after - fit.to_s)).toBeLessThan(0.002);
    await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.agentPlanUndo, { id: rec.id }),
      payload: { force: true },
    });
    expect(timelineDuration(app.ctx.repos.projects.get(projectId)!)).toBeCloseTo(DURATION, 3);
  });

  it("SCRIPT_STALE when the timeline no longer matches the words", async () => {
    const project = app.ctx.repos.projects.get(projectId)!;
    const stale: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "c1" ? { ...c, out: 20 } : c)),
      })),
    };
    app.ctx.repos.projects.save(projectId, stale);
    const script = ScriptSchema.parse((await app.inject({ url: url(API_ROUTES.script) })).json());
    expect(script.stale).toBe(true);
    const res = await app.inject({
      method: "POST",
      url: url(API_ROUTES.scriptCuts),
      payload: { fillers: "safe" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SCRIPT_STALE");
    app.ctx.repos.projects.save(projectId, project);
  });
});
