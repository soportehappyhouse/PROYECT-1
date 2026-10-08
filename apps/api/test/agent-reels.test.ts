import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PLAN_CHOOSE_ROUTE,
  API_ROUTES,
  STYLE_API_ROUTES,
  buildRoute,
  type AgentPlanRecord,
  type EditPlan,
  type StyleApplyResponse,
  type StylePreset,
} from "@studio/shared";
import { CONSOLE_ROUTES } from "../src/routes/console.js";
import {
  ADDED_REFRAME_REASON_ES,
  ADDED_SUFFIX_ES,
  expandPlanForAspect,
} from "../src/services/agent/aspect.js";
import { makeApp } from "./helpers.js";

/**
 * Sprint 5 (M3, H6): «Exportá para Reels» on a horizontal video never exports with blurred bars
 * by default. With the «reframe» pack the plan gets a reframe (face) before the export; without
 * it, a PlanChoice (seguir la cara / al centro / franjas) and the export stays unresolved. Checked
 * on the 4 paths: Asistente, plan editado, Consola Claude and Perfil de estilo.
 */

const REELS_PLAN: EditPlan = {
  version: 1,
  summary_es: "Exportar para Reels",
  ops: [{ op: "export", preset: "reels-tiktok" }],
};

describe("plan expansion for 9:16 (reframe or choice)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  const state = { reframeInstalled: true, plan: REELS_PLAN as unknown };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        if (req.url === "/packs")
          return send(200, [
            {
              id: "reframe",
              name_es: "Reencuadre",
              size_bytes: 120e6,
              installed: state.reframeInstalled,
              files: [],
            },
          ]);
        if (req.url === "/agent/plan")
          return send(200, {
            plan: state.plan,
            model: null,
            latency_ms: 3,
            attempts: 1,
            warnings: [],
            route: "deterministic",
          });
        return send(404, { detail: "Not Found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ app } = await makeApp({ WORKERS_URL: url }));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    state.reframeInstalled = true;
    state.plan = REELS_PLAN;
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload });

  /** Project with one video clip on a `w`×`h` canvas. */
  function makeProject(w = 1920, h = 1080): string {
    const id = `v${Math.random().toString(36).slice(2, 8)}`;
    app.ctx.repos.media.insert({
      id,
      kind: "video",
      name: "entrevista.mp4",
      path: `media/${id}.mp4`,
      sizeBytes: 1,
      durationSec: 4,
      width: w,
      height: h,
      fps: 25,
      hasVideo: true,
      hasAudio: true,
      createdAt: new Date().toISOString(),
    });
    const p = app.ctx.repos.projects.create({ name: "Reels" });
    p.settings = { ...p.settings, width: w, height: h };
    const video = p.tracks.find((t) => t.kind === "video")!;
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
    app.ctx.repos.projects.save(p.id, p);
    return p.id;
  }

  const propose = async (projectId: string) => {
    const res = await post(API_ROUTES.agentPlan, { command: "Exportá para Reels", projectId });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<AgentPlanRecord>();
  };

  it("Asistente, 16:9 with the pack: [reframe(face), export(aspect_fit reframe)] + added", async () => {
    const rec = await propose(makeProject());
    expect(rec.plan!.ops).toEqual([
      { op: "reframe", target: "9:16", subject: "face" },
      { op: "export", preset: "reels-tiktok", aspect_fit: "reframe" },
    ]);
    expect(rec.added).toEqual([{ index: 0, reason_es: ADDED_REFRAME_REASON_ES }]);
    expect(rec.choices).toEqual([]);
    expect(rec.preview_es[0]).toContain(ADDED_SUFFIX_ES);
    expect(rec.risks.join(" ")).toMatch(/Operación larga: analiza las caras/);
    expect(rec.resolved[1]).toMatchObject({ op: "export", aspect_fit: "reframe", confirm: true });
    expect(rec.ok).toBe(true);
  });

  it("without the pack: a choice with 3 options; the export stays unresolved until picked", async () => {
    state.reframeInstalled = false;
    const rec = await propose(makeProject());
    expect(rec.plan!.ops).toEqual([{ op: "export", preset: "reels-tiktok" }]);
    expect(rec.choices).toHaveLength(1);
    const choice = rec.choices[0]!;
    expect(choice.id).toBe("aspect");
    expect(choice.question_es).toBe(
      "El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?",
    );
    expect(choice.options.map((o) => o.id)).toEqual(["reframe", "center", "blur"]);
    expect(choice.options[0]!.label_es).toBe("Seguir la cara (descarga «Reencuadre», 120 MB)");
    expect(choice.options[0]!.insert).toEqual({
      before: 0,
      op: { op: "reframe", target: "9:16", subject: "face" },
    });
    expect(rec.resolved[0]).toBeNull();
    expect(rec.unresolved.join(" ")).toContain("¿Cómo lo encuadro?");
    expect(rec.ok).toBe(false);

    // Picking «al centro» patches the export and gives a new preview.
    const picked = await post(buildRoute(AGENT_PLAN_CHOOSE_ROUTE, { id: rec.id }), {
      choiceId: "aspect",
      optionId: "center",
    });
    expect(picked.statusCode, picked.body).toBe(200);
    const after = picked.json<AgentPlanRecord>();
    expect(after.plan!.ops).toEqual([
      { op: "export", preset: "reels-tiktok", aspect_fit: "center" },
    ]);
    expect(after.choices).toEqual([]);
    expect(after.ok).toBe(true);
    // A stale choice id answers 404.
    const stale = await post(buildRoute(AGENT_PLAN_CHOOSE_ROUTE, { id: rec.id }), {
      choiceId: "aspect",
      optionId: "blur",
    });
    expect(stale.statusCode).toBe(404);

    // «Seguir la cara» inserts the reframe (the pack risk tells to download it).
    const rec2 = await propose(makeProject());
    const face = await post(buildRoute(AGENT_PLAN_CHOOSE_ROUTE, { id: rec2.id }), {
      choiceId: "aspect",
      optionId: "reframe",
    });
    const f = face.json<AgentPlanRecord>();
    expect(f.plan!.ops.map((o) => o.op)).toEqual(["reframe", "export"]);
    expect(f.plan!.ops[1]).toMatchObject({ aspect_fit: "reframe" });
    expect(f.risks.join(" ")).toMatch(/Falta el paquete de IA «Reencuadre»/);
  });

  it("vertical canvas, explicit framing or a reframe already in the plan: no changes", async () => {
    const vertical = await propose(makeProject(1080, 1920));
    expect(vertical.plan!.ops).toEqual(REELS_PLAN.ops);
    expect(vertical.added).toEqual([]);

    state.plan = {
      ...REELS_PLAN,
      ops: [
        { op: "reframe", target: "9:16" },
        { op: "export", preset: "reels-tiktok" },
      ],
    };
    const withReframe = await propose(makeProject());
    expect(withReframe.plan!.ops.filter((o) => o.op === "reframe")).toHaveLength(1);
    expect(withReframe.added).toEqual([]);

    state.plan = {
      ...REELS_PLAN,
      ops: [{ op: "export", preset: "reels-tiktok", aspect_fit: "blur" }],
    };
    const blur = await propose(makeProject());
    expect(blur.plan!.ops).toEqual([{ op: "export", preset: "reels-tiktok", aspect_fit: "blur" }]);

    state.plan = {
      ...REELS_PLAN,
      ops: [
        { op: "set_canvas", preset: "9:16" },
        { op: "export", preset: "reels-tiktok" },
      ],
    };
    const canvas = await propose(makeProject());
    expect(canvas.plan!.ops.map((o) => o.op)).toEqual(["set_canvas", "export"]);
  });

  it("plan editado (edited_ops): the edited export to Reels gets the reframe too", async () => {
    state.plan = { ...REELS_PLAN, ops: [{ op: "export", preset: "youtube-1080p" }] };
    const rec = await propose(makeProject());
    expect(rec.plan!.ops).toHaveLength(1);
    // Edited to Reels; the export is not confirmed, so the api stores the edit and answers 409.
    const res = await post(API_ROUTES.agentApply, {
      planId: rec.id,
      edited_ops: [{ op: "export", preset: "reels-tiktok" }],
    });
    expect(res.statusCode).toBe(409);
    const stored = app.ctx.repos.agentPlans.get(rec.id)!;
    expect(stored.plan!.ops.map((o) => o.op)).toEqual(["reframe", "export"]);
    expect(stored.added).toHaveLength(1);
  });

  it("Consola Claude (studio_validate_plan): same expansion", async () => {
    const projectId = makeProject();
    const res = await post(CONSOLE_ROUTES.plans, { projectId, plan: REELS_PLAN });
    expect(res.statusCode, res.body).toBe(201);
    const rec = res.json<AgentPlanRecord>();
    expect(rec.plan!.ops.map((o) => o.op)).toEqual(["reframe", "export"]);
    expect(rec.added).toEqual([{ index: 0, reason_es: ADDED_REFRAME_REASON_ES }]);
    state.reframeInstalled = false;
    const dry = await post(CONSOLE_ROUTES.plans, { projectId, plan: REELS_PLAN, save: false });
    expect(dry.json<AgentPlanRecord>().choices[0]?.options).toHaveLength(3);
  });

  it("Perfil de estilo: a 16:9 profile exported to Reels gets the reframe", async () => {
    const created = await post(STYLE_API_ROUTES.presets, {
      name: "Horizontal a Reels",
      canvas: "16:9",
      cut_rhythm: { target_shot_s: 3, remove_silences: false, min_silence_ms: 300 },
      captions: { enabled: false, style: "reels", animated: false, position: "bottom" },
      titles: { enabled: false, template: "title-card", params: {} },
      lower_third: { enabled: false },
      transitions: { type: "cut" },
      music: { duck: false, volume_db: -14 },
      export_preset: "reels-tiktok",
      notes_es: "Horizontal, exportado vertical.",
    });
    expect(created.statusCode, created.body).toBe(201);
    const preset = created.json<StylePreset>();
    const res = await post(buildRoute(STYLE_API_ROUTES.apply, { id: preset.id }), {
      projectId: makeProject(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json<StyleApplyResponse>();
    const ops = out.plan.plan!.ops.map((o) => o.op);
    expect(ops.slice(-2)).toEqual(["reframe", "export"]);
    expect(out.plan.added).toHaveLength(1);
  });

  it("expandPlanForAspect: project reframe keyframes or GIF need nothing", () => {
    const projectId = makeProject();
    const project = app.ctx.repos.projects.get(projectId)!;
    const ctx = {
      project: {
        ...project,
        reframe: {
          target: "9:16" as const,
          mode: "manual" as const,
          keyframes: [{ t: 0, ease: "linear" as const, v: { x: 0.3, y: 0, w: 0.3, h: 1 } }],
        },
      },
      media: (id: string) => app.ctx.repos.media.get(id),
      presets: app.ctx.repos.presets.list(),
    };
    expect(expandPlanForAspect(REELS_PLAN, ctx).plan.ops).toEqual(REELS_PLAN.ops);
    const gif: EditPlan = { ...REELS_PLAN, ops: [{ op: "export", preset: "gif-480" }] };
    expect(expandPlanForAspect(gif, { ...ctx, project }).added).toEqual([]);
  });
});
