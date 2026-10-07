import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  type AgentApplyResult,
  type AgentPlanRecord,
  type AgentProjectSummary,
  type AgentStatus,
  type EditPlanInput,
  type ExportJobResult,
  type Job,
  type JobEvent,
  type Project,
} from "@studio/shared";
import { agentPackName, ollamaHint } from "../src/routes/agent.js";
import { makeApp, waitFor } from "./helpers.js";

/** Sprint 3 agent routes + agent.apply against a fake workers service (sprint3-contratos.md). */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const PLAN_4: EditPlanInput = {
  version: 1,
  summary_es: "Divido el video, agrego un título, paso a vertical y exporto para Reels.",
  ops: [
    { op: "split", clip: { index: 1, track: "video" }, t: 2 },
    { op: "add_text", text: "Hola", t: 0.5, duration_s: 1.5, position: "top" },
    { op: "set_canvas", preset: "9:16" },
    { op: "export", preset: "reels-tiktok", name: "agente" },
  ],
};

describe("agent routes and agent.apply (mocked workers)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const state: {
    plan: unknown;
    planStatus?: number;
    planBody?: unknown;
    bugFail: boolean;
    seen: Record<string, Record<string, unknown>>;
  } = { plan: PLAN_4, bugFail: false, seen: {} };

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
        switch (req.url) {
          case "/packs":
            return send(200, [
              {
                id: "agent-llm",
                name_es: "Asistente local (qwen3:8b)",
                size_bytes: 5.2e9,
                installed: false,
                files: [],
              },
            ]);
          case "/agent/status":
            return send(200, {
              ollama: true,
              model: "qwen3:8b",
              models_installed: ["qwen3:8b"],
              ready: true,
              gpu_mode: "cpu",
              loaded: true,
            });
          case "/agent/plan":
            if (state.planStatus) return send(state.planStatus, state.planBody);
            return send(200, {
              plan: state.plan,
              model: null,
              latency_ms: 12,
              attempts: 1,
              warnings: [],
              route: "deterministic",
            });
          case "/agent/bugreport":
            if (state.bugFail) return send(500, { detail: "boom" });
            return send(200, {
              markdown_es: `## ${String(json.title)}\n\n1. ${String(json.steps_text)}`,
              // the workers' own template when the requested model is not installed
              ...(json.model === "no-existe:1b" && { source: "template" }),
            });
          default:
            return send(404, { detail: "Not Found" });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app, storage } = await makeApp({
      WORKERS_URL: url,
      ...(hasFfmpeg && { FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }),
    }));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    state.plan = PLAN_4;
    state.planStatus = undefined;
    state.bugFail = false;
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload });
  const jobEnd = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      60_000,
    );
    return app.ctx.jobs.get(id)!;
  };

  /** 4 s lavfi clip (testsrc2 + sine) registered as a media asset, in a fresh project. */
  // The 4 s test clip is encoded once per file and copied for every project: a synchronous ffmpeg
  // encode per test blocked the event loop and pushed short tests past their 5 s budget on slow
  // Windows runners.
  let baseClip: string | undefined;
  async function makeProject(): Promise<string> {
    const id = `v${Math.random().toString(36).slice(2, 8)}`;
    const rel = `media/${id}.mp4`;
    mkdirSync(path.join(storage, "media"), { recursive: true });
    if (hasFfmpeg && baseClip) copyFileSync(baseClip, path.join(storage, rel));
    else if (hasFfmpeg) {
      baseClip = path.join(storage, rel);
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=25:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path.join(storage, rel),
      ]);
    }
    app.ctx.repos.media.insert({
      id,
      kind: "video",
      name: "prueba lavfi.mp4",
      path: rel,
      sizeBytes: 1,
      durationSec: 4,
      width: 320,
      height: 240,
      fps: 25,
      hasVideo: true,
      hasAudio: true,
      createdAt: new Date().toISOString(),
    });
    const created = app.ctx.repos.projects.create({ name: "Agente" });
    const video = created.tracks.find((t) => t.kind === "video")!;
    video.clips.push({
      id: "c1",
      trackId: video.id,
      assetId: id,
      start: 0,
      in: 0,
      out: 4,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    });
    app.ctx.repos.projects.save(created.id, created);
    return created.id;
  }

  const propose = async (projectId: string, command = "dividí, título, vertical y exportá") => {
    const res = await post(API_ROUTES.agentPlan, { command, projectId, cursor: 1 });
    return { res, record: res.json<AgentPlanRecord>() };
  };

  it.skipIf(!hasFfmpeg)(
    "plan -> resolve -> apply a 4-op plan end to end (split + add_text + set_canvas + export), then undo",
    async () => {
      const projectId = await makeProject();
      const { res, record } = await propose(projectId);
      expect(res.statusCode, res.body).toBe(201);
      expect(record.ok).toBe(true);
      expect(record.route).toBe("deterministic");
      expect(record.preview_es).toEqual([
        "Dividir «prueba lavfi.mp4» en 2 s",
        "Agregar texto «Hola» en 0,5 s durante 1,5 s (arriba)",
        "Lienzo 1080×1920",
        "Exportar con «Reels / TikTok (9:16)» (1080×1920, mp4) como «agente»",
      ]);
      expect(record.resolved[0]).toEqual({ op: "split", clip: { id: "c1" }, t: 2 });
      expect(record.resolved[3]).toMatchObject({ confirm: true });
      expect(record.risks.join(" ")).toMatch(/nunca sobrescribe/);
      const sent = state.seen["/agent/plan"]!;
      expect(sent.command).toBe("dividí, título, vertical y exportá");
      // JSON summary (dataset shape) + defaults from .env (AGENT_MODEL / AGENT_TEMPERATURE).
      const summary = sent.project_summary as AgentProjectSummary;
      expect(summary.cursor_s).toBe(1);
      expect(summary.tracks.find((t) => t.kind === "video")!.clips).toEqual([
        { id: "c1", name: "prueba lavfi.mp4", start: 0, end: 4 },
      ]);
      expect(sent.settings).toEqual({ model: "qwen3:8b", temperature: 0.2 });

      const list = await app.inject({ url: `${API_ROUTES.agentPlans}?projectId=${projectId}` });
      expect(list.json<AgentPlanRecord[]>().map((p) => p.id)).toEqual([record.id]);

      const messages: string[] = [];
      const onJob = (e: JobEvent) => e.message && messages.push(e.message);
      app.ctx.queue.on("job", onJob);
      // export (index 3) is destructive: it needs the separate confirmation click.
      const unconfirmed = await post(API_ROUTES.agentApply, { planId: record.id });
      expect(unconfirmed.statusCode, unconfirmed.body).toBe(409);
      expect(unconfirmed.json().error).toMatchObject({
        code: "CONFIRM_REQUIRED",
        details: { indexes: [3] },
      });
      const apply = await post(API_ROUTES.agentApply, { planId: record.id, confirmedIndexes: [3] });
      expect(apply.statusCode, apply.body).toBe(202);
      const job = await jobEnd(apply.json<{ jobId: string }>().jobId);
      app.ctx.queue.off("job", onJob);
      expect(job.status, job.error).toBe("succeeded");
      const result = job.result as AgentApplyResult;
      expect(result.failed).toBeUndefined();
      expect(result.applied).toBe(4);
      expect(result.undoSnapshotId).toBeTruthy();
      expect(messages).toContain("op 1/4: Dividir «prueba lavfi.mp4» en 2 s");
      expect(messages.some((m) => m.startsWith("op 4/4: Exportar con «Reels / TikTok"))).toBe(true);

      const project = app.ctx.repos.projects.get(projectId)!;
      const video = project.tracks.find((t) => t.kind === "video")!;
      expect(video.clips.map((c) => [c.start, c.in, c.out])).toEqual([
        [0, 0, 2],
        [2, 2, 4],
      ]);
      const text = project.tracks.find((t) => t.kind === "text")!.clips[0]!;
      expect(text).toMatchObject({ text: "Hola", start: 0.5, out: 1.5 });
      expect(text.textStyle?.position).toBe("top");
      expect(project.settings).toMatchObject({ width: 1080, height: 1920 });

      const exported = result.steps[3]!.result as ExportJobResult;
      expect(exported.path).toMatch(/^exports\/agente-.*\.mp4$/);
      expect(result.steps[3]!.jobIds).toHaveLength(1);
      const file = path.join(storage, exported.path);
      expect(existsSync(file)).toBe(true);
      const probe = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ]).toString(),
      ) as {
        streams: { codec_type: string; width?: number; height?: number }[];
        format: { duration: string };
      };
      const v = probe.streams.find((s) => s.codec_type === "video")!;
      expect([v.width, v.height]).toEqual([1080, 1920]);
      expect(Number(probe.format.duration)).toBeCloseTo(4, 0);

      const stored = app.ctx.repos.agentPlans.get(record.id)!;
      expect(stored.status).toBe("applied");
      expect(stored.applyResult?.applied).toBe(4);
      expect(stored.applyJobId).toBe(job.id);

      // Undo all: the project goes back to the snapshot taken before agent.apply.
      const undo = await post(buildRoute(API_ROUTES.agentPlanUndo, { id: record.id }));
      expect(undo.statusCode, undo.body).toBe(200);
      const back = undo.json<{ project: Project; plan: AgentPlanRecord }>();
      expect(back.project.settings).toMatchObject({ width: 1920, height: 1080 });
      expect(back.project.tracks.find((t) => t.kind === "video")!.clips).toHaveLength(1);
      expect(back.project.tracks.find((t) => t.kind === "text")!.clips).toHaveLength(0);
      expect(back.plan.status).toBe("proposed");
      expect(back.plan.undoneAt).toBeTruthy();
    },
    90_000,
  );

  it("delete/export need confirmedIndexes; undo refuses (409 PROJECT_CHANGED) after later edits unless force", async () => {
    state.plan = {
      version: 1,
      summary_es: "Borro el clip y pongo un texto.",
      ops: [
        { op: "add_text", text: "A", t: 1 },
        { op: "delete_clip", clip: { id: "c1" } },
      ],
    };
    const projectId = await makeProject();
    const { record } = await propose(projectId);
    expect(record.ok).toBe(true);
    // Only the text: no confirmation needed.
    const sub = await post(API_ROUTES.agentApply, { planId: record.id, ops: [0, 1] });
    expect(sub.statusCode).toBe(409);
    expect(sub.json().error.code).toBe("CONFIRM_REQUIRED");
    expect(sub.json().error.message).toMatch(/operación 2 \(borrar clip\)/);
    // confirming another index does not count
    const wrong = await post(API_ROUTES.agentApply, {
      planId: record.id,
      ops: [0, 1],
      confirmedIndexes: [0],
    });
    expect(wrong.statusCode).toBe(409);
    const ok = await post(API_ROUTES.agentApply, {
      planId: record.id,
      ops: [0, 1],
      confirmedIndexes: [1],
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const job = await jobEnd(ok.json<{ jobId: string }>().jobId);
    expect((job.result as AgentApplyResult).applied).toBe(2);
    const applied = app.ctx.repos.agentPlans.get(record.id)!;
    expect(applied.postApplyHash).toMatch(/^[0-9a-f]{32}$/);
    expect(applied.postApplyUpdatedAt).toBe(app.ctx.repos.projects.get(projectId)!.updatedAt);

    // Saving the same content again (the web adopting the api copy) is not a change.
    const same = app.ctx.repos.projects.get(projectId)!;
    app.ctx.repos.projects.save(projectId, structuredClone(same));
    // A real edit after the apply: the undo asks first.
    const edited = app.ctx.repos.projects.get(projectId)!;
    app.ctx.repos.projects.save(projectId, { ...edited, name: "Renombrado después" });
    const undoRoute = buildRoute(API_ROUTES.agentPlanUndo, { id: record.id });
    const refused = await post(undoRoute, {});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe("PROJECT_CHANGED");
    expect(refused.json().error.message).toMatch(/no borra los archivos exportados/);
    expect(app.ctx.repos.projects.get(projectId)!.name).toBe("Renombrado después");
    const forced = await post(undoRoute, { force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    const back = forced.json<{ project: Project }>().project;
    expect(back.tracks.find((t) => t.kind === "video")!.clips).toHaveLength(1);
    expect(back.tracks.find((t) => t.kind === "text")!.clips).toHaveLength(0);
  });

  it("undo without later edits needs no force", async () => {
    state.plan = { version: 1, summary_es: "x", ops: [{ op: "add_text", text: "B", t: 1 }] };
    const projectId = await makeProject();
    const { record } = await propose(projectId);
    const res = await post(API_ROUTES.agentApply, { planId: record.id });
    expect(res.statusCode, res.body).toBe(202);
    await jobEnd(res.json<{ jobId: string }>().jobId);
    const undo = await post(buildRoute(API_ROUTES.agentPlanUndo, { id: record.id }), {});
    expect(undo.statusCode, undo.body).toBe(200);
  });

  it("stops at the first failing op with {index, error} and keeps the applied ones", async () => {
    state.plan = {
      version: 1,
      summary_es: "x",
      ops: [
        { op: "set_canvas", preset: "1:1" },
        { op: "split", clip: { id: "c1" }, t: 1 },
        { op: "add_text", text: "nunca", t: 0 },
      ],
    };
    const projectId = await makeProject();
    const { record } = await propose(projectId);
    expect(record.ok).toBe(true);
    // The clip disappears between the proposal and the apply.
    const p = app.ctx.repos.projects.get(projectId)!;
    p.tracks.find((t) => t.kind === "video")!.clips = [];
    app.ctx.repos.projects.save(projectId, p);
    const job = await jobEnd(
      (await post(API_ROUTES.agentApply, { planId: record.id })).json<{ jobId: string }>().jobId,
    );
    expect(job.status).toBe("succeeded");
    const r = job.result as AgentApplyResult;
    expect(r.applied).toBe(1);
    expect(r.failed).toEqual({ index: 1, error: "No encontré el clip con id «c1» para dividir." });
    const after = app.ctx.repos.projects.get(projectId)!;
    expect(after.settings).toMatchObject({ width: 1080, height: 1080 });
    expect(after.tracks.find((t) => t.kind === "text")!.clips).toHaveLength(0);
  });

  it("applies only the confirmed subset; unresolved ops must be unchecked", async () => {
    state.plan = {
      version: 1,
      summary_es: "x",
      ops: [
        { op: "add_text", text: "A", t: 1 },
        { op: "split", clip: { name: "no existe" }, t: 1 },
      ],
    };
    const projectId = await makeProject();
    const { record } = await propose(projectId);
    expect(record.ok).toBe(false);
    expect(record.unresolved).toEqual([
      "Operación 2: No encontré un clip llamado «no existe» para dividir. ¿Cuál es?",
    ]);
    expect(record.resolved[1]).toBeNull();
    const bad = await post(API_ROUTES.agentApply, { planId: record.id });
    expect(bad.statusCode).toBe(409);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("PLAN_UNRESOLVED");
    const ok = await post(API_ROUTES.agentApply, { planId: record.id, ops: [0] });
    expect(ok.statusCode).toBe(202);
    const job = await jobEnd(ok.json<{ jobId: string }>().jobId);
    expect((job.result as AgentApplyResult).applied).toBe(1);
  });

  it("edited_ops: validated, re-resolved (preview/risks) and stored before agent.apply; set_volume + move_clip", async () => {
    state.plan = {
      version: 1,
      summary_es: "x",
      ops: [
        { op: "add_text", text: "Hola", t: 0.5 },
        { op: "set_volume", clip: { name: "prueba" }, volume_db: -6 },
        { op: "move_clip", clip: { index: 1, track: "video" }, t: 1 },
      ],
    };
    const projectId = await makeProject();
    const { record } = await propose(projectId);
    expect(record.ok, JSON.stringify(record)).toBe(true);
    expect(record.preview_es).toEqual([
      "Agregar texto «Hola» en 0,5 s durante 3 s (abajo)",
      "Volumen de «prueba lavfi.mp4»: -6 dB",
      "Mover «prueba lavfi.mp4» a 1 s",
    ]);
    const edited = structuredClone(record.plan!.ops) as Record<string, unknown>[];

    // invalid edit -> 400 with the Spanish path; wrong length -> 400
    const bad = await post(API_ROUTES.agentApply, {
      planId: record.id,
      edited_ops: edited.map((o, i) => (i === 1 ? { ...o, volume_db: 99 } : o)),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { message: string } }>().error.message).toMatch(
      /ops\[1\]\.volume_db: Demasiado grande/,
    );
    const short = await post(API_ROUTES.agentApply, {
      planId: record.id,
      edited_ops: edited.slice(1),
    });
    expect(short.statusCode).toBe(400);

    edited[0] = { ...edited[0], text: "Chau", t: "cursor" };
    const res = await post(API_ROUTES.agentApply, {
      planId: record.id,
      edited_ops: edited,
      cursor: 2,
    });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId, plan } = res.json<{ jobId: string; plan: AgentPlanRecord }>();
    expect(plan.edited).toBe(true);
    expect(plan.plan!.ops[0]).toMatchObject({ text: "Chau", t: "cursor" });
    expect(plan.resolved[0]).toMatchObject({ text: "Chau", t: 2 });
    expect(plan.preview_es[0]).toBe("Agregar texto «Chau» en 2 s durante 3 s (abajo)");
    expect(app.ctx.repos.agentPlans.get(record.id)!.preview_es[0]).toBe(plan.preview_es[0]);
    const job = await jobEnd(jobId);
    expect(job.status, job.error).toBe("succeeded");
    expect((job.result as AgentApplyResult).applied).toBe(3);
    const after = app.ctx.repos.projects.get(projectId)!;
    expect(after.tracks.find((t) => t.kind === "text")!.clips[0]).toMatchObject({
      text: "Chau",
      start: 2,
    });
    const c1 = after.tracks.find((t) => t.kind === "video")!.clips[0]!;
    expect(c1.start).toBe(1);
    expect(c1.volume).toBeCloseTo(0.501, 3);
  });

  it("invalid plans come back with Spanish errors and cannot be applied; reject works", async () => {
    state.plan = {
      version: 1,
      summary_es: "x",
      ops: [{ op: "set_speed", clip: { index: 1 }, speed: 99 }],
    };
    const projectId = await makeProject();
    const { res, record } = await propose(projectId);
    expect(res.statusCode).toBe(201);
    expect(record.ok).toBe(false);
    expect(record.plan).toBeNull();
    expect(record.errors).toEqual([
      "ops[0].speed: Demasiado grande: se esperaba que número fuera <=16",
    ]);
    expect((await post(API_ROUTES.agentApply, { planId: record.id })).statusCode).toBe(409);
    const rej = await post(buildRoute(API_ROUTES.agentPlanReject, { id: record.id }));
    expect(rej.json<AgentPlanRecord>().status).toBe("rejected");
    expect((await post(buildRoute(API_ROUTES.agentPlanReject, { id: "nope" }))).statusCode).toBe(
      404,
    );
  });

  it("PACK_REQUIRED agent-llm with Ollama instructions when the model is missing", async () => {
    const projectId = await makeProject();
    for (const body of [
      { detail: { error: "PACK_REQUIRED", pack_id: "agent-llm", name_es: "x", size_bytes: 1 } },
      { detail: "Ollama no responde en http://127.0.0.1:11434", code: "OLLAMA_UNAVAILABLE" },
    ]) {
      state.planStatus = 503;
      state.planBody = body;
      const { res } = await propose(projectId);
      expect(res.statusCode).toBe(409);
      const b = res.json<{ error: string; packId: string; message: string; size_bytes: number }>();
      expect(b.error).toBe("PACK_REQUIRED");
      expect(b.packId).toBe("agent-llm");
      expect(b.size_bytes).toBe(5.2e9);
      expect(b.message).toMatch(/instalá Ollama \(winget install Ollama\.Ollama/);
    }
    // The workers' own text (they probe /api/version) reaches the user as is.
    const workersText =
      "Ollama 0.35.1 está corriendo, pero falta el modelo qwen3:8b. Descargalo en Ajustes → " +
      "Paquetes («Asistente local») o en una terminal: `ollama pull qwen3:8b`. Para revisar la " +
      "instalación ejecutá scripts\\windows\\doctor.cmd.";
    state.planStatus = 409;
    state.planBody = {
      error: "PACK_REQUIRED",
      code: "PACK_REQUIRED",
      packId: "agent-llm",
      name_es: "Asistente local (Ollama + Qwen3 8B)",
      size_bytes: 5_225_000_000,
      detail: workersText,
    };
    const flat = (await propose(projectId)).res.json<{ message: string; name_es: string }>();
    expect(flat.message).toBe(workersText);
    expect(flat.name_es).toBe("Asistente local (qwen3:8b)"); // GET /packs (workers) wins
    // A non-loopback OLLAMA_URL refused by the workers is not a missing pack.
    state.planStatus = 403;
    state.planBody = {
      detail: "OLLAMA_URL=http://10.0.0.5:11434 no es local: …",
      code: "OLLAMA_REMOTE_REFUSED",
    };
    const refused = (await propose(projectId)).res;
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("OLLAMA_REMOTE_REFUSED");
    state.planStatus = 500;
    state.planBody = { detail: "otra cosa" };
    expect((await propose(projectId)).res.statusCode).toBe(500);
  }, 30_000); // five sequential round trips: slow Windows runners need more than 5 s

  it("agentPackName / ollamaHint name the model and the manual commands", () => {
    expect(agentPackName("qwen3:8b")).toBe("Asistente local (Ollama + Qwen3 8B)");
    expect(agentPackName("hermes3:8b")).toBe("Asistente local (Ollama + Hermes 3 8B)");
    expect(agentPackName("studio-tiny")).toBe("Asistente local (Ollama + studio-tiny)");
    const hint = ollamaHint("hermes3:8b");
    expect(hint).toContain("`ollama pull hermes3:8b`");
    expect(hint).toContain("scripts\\windows\\doctor.cmd");
    expect(hint).toMatch(/bandeja del sistema/);
  });

  it("GET /api/agent/status proxies the workers and the pack", async () => {
    const st = (await app.inject({ url: API_ROUTES.agentStatus })).json<AgentStatus>();
    expect(st).toMatchObject({
      workers: true,
      ollama: true,
      ready: true,
      model: "qwen3:8b",
      pack: { id: "agent-llm", installed: false },
      hint_es: null,
      loaded: true,
    });
  });

  it("POST /api/agent/bugreport: workers markdown appended to reporte.md, template fallback", async () => {
    const report = await post(API_ROUTES.reports, { title: "Se colgó el export", steps: "x" });
    expect(report.statusCode).toBe(201);
    const reportId = report.json<{ id: string }>().id;
    const res = await post(API_ROUTES.agentBugreport, {
      title: "Export colgado",
      steps_text: "exporté a 4K",
      breadcrumbs: [{ message: "abrí Exportar" }],
      reportId,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      markdown_es: "## Export colgado\n\n1. exporté a 4K",
      source: "llm",
      reportId,
    });
    expect(state.seen["/agent/bugreport"]).toMatchObject({
      title: "Export colgado",
      steps_text: "exporté a 4K",
      breadcrumbs: [{ message: "abrí Exportar" }],
      errors: [],
    });
    const md = readFileSync(path.join(storage, "reports", reportId, "reporte.md"), "utf8");
    expect(md).toContain("## Redactado por el asistente local\n\n## Export colgado");

    const tpl = await post(API_ROUTES.agentBugreport, {
      title: "X",
      steps_text: "y",
      model: "no-existe:1b",
    });
    expect(tpl.json<{ source: string }>().source).toBe("template");
    expect(state.seen["/agent/bugreport"]).toMatchObject({ model: "no-existe:1b" });

    state.bugFail = true;
    const fb = await post(API_ROUTES.agentBugreport, {
      title: "Falla",
      steps_text: "1. abrí\n2. exporté",
      errors: [{ message: "ENOSPC" }],
    });
    const t = fb.json<{ markdown_es: string; source: string }>();
    expect(t.source).toBe("template");
    expect(t.markdown_es).toContain("### Pasos para reproducir\n1. abrí\n2. exporté");
    expect(t.markdown_es).toContain("- ENOSPC");
  });
});
