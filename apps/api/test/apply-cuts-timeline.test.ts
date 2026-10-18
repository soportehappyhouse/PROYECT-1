import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clip, Job, Project } from "@studio/shared";
import { applyTimelineCuts } from "../src/services/timeline-edit.js";
import { makeApp, waitFor } from "./helpers.js";

/** Sprint 6 M1: timeline.apply-cuts {mode:"timeline", joinFadeMs}. */
const clip = (id: string, trackId: string, start: number, dur: number, extra: Partial<Clip> = {}) =>
  ({
    id,
    trackId,
    start,
    in: 0,
    out: dur,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    ...extra,
  }) as Clip;

function project(): Project {
  return {
    id: "p1",
    name: "Guion",
    settings: { width: 1080, height: 1920, fps: 30, sampleRate: 48000 },
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "Video 1",
        muted: false,
        locked: false,
        hidden: false,
        clips: [clip("c1", "v", 0, 10, { assetId: "a1" })],
      },
      {
        id: "a",
        kind: "audio",
        name: "Música",
        muted: false,
        locked: false,
        hidden: false,
        clips: [clip("m1", "a", 0, 10, { assetId: "a2" })],
      },
      {
        id: "l",
        kind: "audio",
        name: "Bloqueada",
        muted: false,
        locked: true,
        hidden: false,
        clips: [clip("k1", "l", 0, 10, { assetId: "a3" })],
      },
      {
        id: "t",
        kind: "text",
        name: "Texto",
        muted: false,
        locked: false,
        hidden: false,
        clips: [clip("x1", "t", 6, 2, { text: "Hola" })],
      },
    ],
    subtitles: [
      {
        start: 0,
        end: 3,
        text: "hola eh qué tal",
        words: [
          { word: "hola", start: 0.2, end: 0.6 },
          { word: "eh", start: 1.0, end: 1.4 },
          { word: "qué", start: 1.8, end: 2.0 },
          { word: "tal", start: 2.1, end: 2.5 },
        ],
      },
    ],
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  } as unknown as Project;
}

describe("applyTimelineCuts (pure)", () => {
  it("cuts every unlocked track, fades the joins and ripples subtitles", () => {
    let n = 0;
    const out = applyTimelineCuts(project(), "c1", [{ start: 0.8, end: 1.6 }], () => `n${++n}`, 12);
    expect(out.removedSec).toBeCloseTo(0.8, 6);
    const [v, a, locked, t] = out.project.tracks;
    expect(v!.clips.map((c) => [c.start, c.in, c.out])).toEqual([
      [0, 0, 0.8],
      [0.8, 1.6, 10],
    ]);
    expect(v!.clips[0]!.audioFade).toEqual({ inMs: 0, outMs: 12 });
    expect(v!.clips[1]!.audioFade).toEqual({ inMs: 12, outMs: 0 });
    expect(a!.clips).toHaveLength(2); // the music is cut too (sync)
    expect(locked!.clips[0]).toMatchObject({ start: 0, in: 0, out: 10 }); // locked: untouched
    expect(t!.clips[0]!.start).toBeCloseTo(5.2, 6);
    const words = out.project.subtitles[0]!.words!;
    expect(words.map((w) => w.word)).toEqual(["hola", "qué", "tal"]);
    expect(words[1]!.start).toBeCloseTo(1.0, 6);
    expect(out.pieceIds).toEqual(["c1", "n1"]);
  });
});

describe("POST /api/ai/timeline/apply-cuts mode:timeline", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  it("runs the job and saves the cut project", async () => {
    const p = project();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: p.name },
    });
    const id = (created.json() as { id: string }).id;
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}`,
      payload: { ...p, id },
    });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/timeline/apply-cuts",
      payload: {
        projectId: id,
        clipId: "c1",
        cuts: [{ start: 0.8, end: 1.6 }],
        mode: "timeline",
        joinFadeMs: 12,
      },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    let job: Job | undefined;
    await waitFor(async () => {
      job = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}` })).json() as Job;
      return job.status === "succeeded" || job.status === "failed";
    });
    expect(job!.status).toBe("succeeded");
    const saved = app.ctx.repos.projects.get(id)!;
    expect(saved.tracks[0]!.clips).toHaveLength(2);
    expect(saved.tracks[0]!.clips[1]!.audioFade).toEqual({ inMs: 12, outMs: 0 });
  });
});
