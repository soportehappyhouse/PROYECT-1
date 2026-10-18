import { describe, expect, it } from "vitest";
import { ProjectSchema, type Job, type Project } from "@studio/shared";
import {
  pendingMotionClips,
  renderPendingMotion,
} from "../src/services/export/motion-prerender.js";
import { findExportBlockers } from "../src/services/ffmpeg/timeline.js";

/** Sprint 6 (integration, M2 cross request 1): the export renders motion clips without a render. */
const project = (): Project => {
  const now = new Date().toISOString();
  const spec = { template: "title-card", durationSec: 2, props: {} };
  return ProjectSchema.parse({
    id: "p1",
    name: "x",
    settings: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      {
        id: "tm",
        kind: "motion",
        name: "Motion 1",
        clips: [
          { id: "m1", trackId: "tm", start: 0, out: 2, motion: spec },
          { id: "m2", trackId: "tm", start: 3, out: 2, motion: spec, renderedAssetId: "r2" },
          { id: "m3", trackId: "tm", start: 6, out: 2, motion: spec, renderedAssetId: "gone" },
        ],
      },
      {
        id: "th",
        kind: "motion",
        name: "Oculta",
        hidden: true,
        clips: [{ id: "h1", trackId: "th", start: 0, out: 2, motion: spec }],
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
};
const has = (id: string) => id === "r2";

function fakeApp(finalStatus: Job["status"] = "succeeded") {
  const enqueued: { id: string; payload: unknown }[] = [];
  const canceled: string[] = [];
  const polls = new Map<string, number>();
  const job = (id: string, status: Job["status"]): Job =>
    ({ id, type: "motion.render", status, progress: 0, error: "sin Chrome" }) as unknown as Job;
  return {
    enqueued,
    canceled,
    app: {
      queue: {
        enqueue: ({ payload }: { payload: unknown }) => {
          const id = `j${enqueued.length + 1}`;
          enqueued.push({ id, payload });
          return job(id, "queued");
        },
        cancel: (id: string) => {
          canceled.push(id);
          return undefined;
        },
      },
      jobs: {
        get: (id: string) => {
          const n = (polls.get(id) ?? 0) + 1;
          polls.set(id, n);
          return job(id, n >= 2 ? finalStatus : "running");
        },
      },
      repos: {},
    } as never,
  };
}

describe("export: motion clips without a render", () => {
  it("are not blockers with autoRenderMotion, and pendingMotionClips lists them", () => {
    const p = project();
    expect(findExportBlockers(p, has)).toHaveLength(2);
    expect(findExportBlockers(p, has, undefined, { autoRenderMotion: true })).toEqual([]);
    expect(pendingMotionClips(p, has).map((c) => c.id)).toEqual(["m1", "m3"]);
    expect(pendingMotionClips(p, has, { start: 5, end: 9 }).map((c) => c.id)).toEqual(["m3"]);
  });

  it("renders them one by one as motion.render jobs targeting the clip", async () => {
    const f = fakeApp();
    const progress: string[] = [];
    const n = await renderPendingMotion(f.app, "p1", pendingMotionClips(project(), has), {
      signal: new AbortController().signal,
      pollMs: 1,
      onProgress: (d, t, label) => progress.push(`${d}/${t} ${label}`),
    });
    expect(n).toBe(2);
    expect(f.enqueued.map((e) => (e.payload as { target: unknown }).target)).toEqual([
      { projectId: "p1", clipId: "m1" },
      { projectId: "p1", clipId: "m3" },
    ]);
    expect(progress[0]).toMatch(/^0\/2 Renderizando gráficos 1\/2/);
    expect(progress.at(-1)).toBe("2/2 Gráficos listos");
  });

  it("a failed render fails with a Spanish message; aborting cancels the render", async () => {
    const f = fakeApp("failed");
    await expect(
      renderPendingMotion(f.app, "p1", pendingMotionClips(project(), has), {
        signal: new AbortController().signal,
        pollMs: 1,
      }),
    ).rejects.toThrow(
      /No se pudo renderizar el gráfico «title-card» antes de exportar: sin Chrome/,
    );
    const g = fakeApp("running");
    const ac = new AbortController();
    const run = renderPendingMotion(g.app, "p1", pendingMotionClips(project(), has), {
      signal: ac.signal,
      pollMs: 5,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(run).rejects.toThrow();
    expect(g.canceled).toEqual(["j1"]);
  });
});
