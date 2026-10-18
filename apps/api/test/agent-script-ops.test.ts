import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  timelineDuration,
  type AgentApplyResult,
  type AgentPlanRecord,
  type Job,
  type Project,
} from "@studio/shared";
import { CONSOLE_ROUTES } from "../src/routes/console.js";
import { makeApp, waitFor } from "./helpers.js";
import { scriptSegments } from "./script-fixtures.js";

/** Sprint 6 M1: delete_words / fix_text / fit_duration resolve, apply and undo in one step. */
describe("agent script ops", () => {
  let app: FastifyInstance;
  let projectId = "";
  let emptyId = "";

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload });

  beforeAll(async () => {
    ({ app } = await makeApp());
    app.ctx.repos.media.insert({
      id: "asset1",
      kind: "video",
      name: "charla.mp4",
      path: "media/charla.mp4",
      sizeBytes: 1,
      durationSec: 60,
      width: 64,
      height: 64,
      fps: 5,
      hasVideo: true,
      hasAudio: true,
      createdAt: new Date().toISOString(),
    });
    const make = (name: string, withSubs: boolean) => {
      const p = app.ctx.repos.projects.create({ name });
      const video = p.tracks.find((t) => t.kind === "video")!;
      video.clips.push({
        id: `c-${name}`,
        trackId: video.id,
        assetId: "asset1",
        start: 0,
        in: 0,
        out: 60,
        speed: 1,
        volume: 1,
        opacity: 1,
        voiceEffects: [],
      });
      return app.ctx.repos.projects.save(p.id, {
        ...p,
        ...(withSubs && { subtitles: scriptSegments() }),
      })!.id;
    };
    projectId = make("Guion", true);
    emptyId = make("Vacio", false);
  });
  afterAll(() => app.close());

  async function propose(id: string, ops: unknown[]): Promise<AgentPlanRecord> {
    const res = await post(CONSOLE_ROUTES.plans, {
      projectId: id,
      plan: { version: 1, summary_es: "Guion", ops },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json() as AgentPlanRecord;
  }

  async function apply(record: AgentPlanRecord, confirmedIndexes?: number[]) {
    const res = await post(API_ROUTES.agentApply, {
      planId: record.id,
      ...(confirmedIndexes && { confirmedIndexes }),
    });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    let job: Job | undefined;
    await waitFor(async () => {
      job = (await app.inject({ url: `/api/jobs/${jobId}` })).json() as Job;
      return ["succeeded", "failed", "canceled"].includes(job.status);
    });
    return job!;
  }

  it("without a transcript the ops become «Primero transcribí el video»", async () => {
    const rec = await propose(emptyId, [{ op: "delete_words", fillers: "safe" }]);
    expect(rec.ok).toBe(false);
    expect(rec.unresolved[0]).toContain("Primero transcribí el video (Guion → Transcribir).");
  });

  it("delete_words (safe) + fix_text resolve with Spanish previews, apply, and undo in one step", async () => {
    const rec = await propose(projectId, [
      { op: "delete_words", fillers: "safe" },
      { op: "fix_text", find: "frase2", replace: "oración dos" },
    ]);
    expect(rec.ok, JSON.stringify(rec.unresolved)).toBe(true);
    expect(rec.preview_es[0]).toMatch(/^Quitar 8 muletillas seguras \(−[\d,]+ s\)/);
    expect(rec.preview_es[1]).toBe(
      "Corregir «frase2» → «oración dos» (1 vez): 2 palabras con tiempos estimados",
    );
    const before = app.ctx.repos.projects.get(projectId)!;
    const job = await apply(rec);
    expect(job.status, job.error ?? "").toBe("succeeded");
    const result = job.result as AgentApplyResult;
    expect(result.applied).toBe(2);
    const after = app.ctx.repos.projects.get(projectId)!;
    const words = after.subtitles.flatMap((s) => s.words ?? []);
    expect(words.some((w) => w.word === "eh")).toBe(false);
    const fixed = words.filter((w) => w.corrected);
    expect(fixed.map((w) => w.word)).toEqual(["oración", "dos"]);
    const video = after.tracks.find((t) => t.kind === "video")!;
    expect(video.clips).toHaveLength(9);
    expect(video.clips[1]!.audioFade).toEqual({ inMs: 12, outMs: 12 });
    expect(timelineDuration(after)).toBeLessThan(timelineDuration(before) - 4);

    // «Deshacer todo»: one step back to the project before the plan.
    const undo = await post(buildRoute(API_ROUTES.agentPlanUndo, { id: rec.id }), {});
    expect(undo.statusCode, undo.body).toBe(200);
    const back = undo.json<{ project: Project }>().project;
    expect(back.tracks.find((t) => t.kind === "video")!.clips).toHaveLength(1);
    expect(
      back.subtitles.flatMap((s) => s.words ?? []).filter((w) => w.word === "eh"),
    ).toHaveLength(8);
  });

  it("fit_duration 45 s resolves to «60 → 45» and applies", async () => {
    const rec = await propose(projectId, [{ op: "fit_duration", target_s: 45 }]);
    expect(rec.ok, JSON.stringify(rec.unresolved)).toBe(true);
    expect(rec.preview_es[0]).toMatch(
      /^Ajustar duración: 60 s → 4[45],\d s \(−[\d,]+ s en \d pausas/,
    );
    const job = await apply(rec);
    expect(job.status, job.error ?? "").toBe("succeeded");
    const d = timelineDuration(app.ctx.repos.projects.get(projectId)!);
    expect(d).toBeGreaterThanOrEqual(44.5);
    expect(d).toBeLessThanOrEqual(45.5);
    await post(buildRoute(API_ROUTES.agentPlanUndo, { id: rec.id }), { force: true });
  });

  it("delete_words that removes > 20 % asks for confirmation; fit with sentences too", async () => {
    const rec = await propose(projectId, [
      { op: "delete_words", text: "importante1" },
      { op: "fit_duration", target_s: 30, allow_sentences: true },
    ]);
    expect(rec.resolved[0]).toMatchObject({ op: "delete_words" });
    expect(rec.resolved[0]).not.toHaveProperty("confirm");
    expect(rec.resolved[1]).toMatchObject({ op: "fit_duration", confirm: true });
    expect(rec.risks.some((r) => r.startsWith("Quita oraciones enteras"))).toBe(true);
  });
});
