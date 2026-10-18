import { afterEach, describe, expect, it } from "vitest";
import type { JobEvent } from "@studio/shared";
import { openDatabase } from "../src/db/database.js";
import { HttpError } from "../src/lib/errors.js";
import { PackRequiredError } from "../src/lib/errors.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ensureSprint5Columns, SqliteJobStore } from "../src/jobs/store.js";
import type { JobContext, JobHandler } from "../src/jobs/types.js";
import { makeApp, waitFor } from "./helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let queues: JobQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.map((q) => q.stop()));
  queues = [];
});

function setup(stallCheckMs?: number) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const queue = new JobQueue({
    store,
    storageDir: "/tmp",
    progressThrottleMs: 0,
    ...(stallCheckMs && { stallCheckMs }),
  });
  const events: JobEvent[] = [];
  queue.on("job", (e) => events.push(e));
  queues.push(queue);
  return { db, store, queue, events };
}

function gated(type: JobHandler["type"], body?: (ctx: JobContext) => void) {
  const ctxs: JobContext[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handler: JobHandler = {
    type,
    parse: (p) => p,
    async run(_p, ctx) {
      ctxs.push(ctx);
      body?.(ctx);
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        ctx.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
      return { ok: true };
    },
  };
  return { handler, ctxs, release: () => release() };
}

describe("job progress detail (sprint 5)", () => {
  it("persists detail and sends it in every event (with ETA from done/total)", async () => {
    const { queue, store, events } = setup();
    const g = gated("agent.eval");
    queue.register(g.handler);
    queue.start();
    const job = queue.enqueue({ type: "agent.eval", payload: {} });
    await waitFor(() => g.ctxs.length === 1);
    const ctx = g.ctxs[0]!;
    ctx.reportProgress(0.05, "qwen3:8b · 0/20", {
      done: 0,
      total: 20,
      unit: "commands",
      stage_es: "qwen3:8b · 0/20",
    });
    await wait(30);
    ctx.reportProgress(0.15, "qwen3:8b · 3/20", {
      done: 3,
      total: 20,
      stage_es: "qwen3:8b · 3/20",
    });
    const stored = store.get(job.id)!;
    expect(stored.detail).toMatchObject({
      done: 3,
      total: 20,
      unit: "commands",
      stage_es: "qwen3:8b · 3/20",
      cancellable: true,
      stalled: false,
    });
    expect(typeof stored.detail!.eta_s).toBe("number");
    expect(stored.detail!.progressAt).toBeTruthy();
    const last = events.filter((e) => e.jobId === job.id).at(-1)!;
    expect(last.detail?.stage_es).toBe("qwen3:8b · 3/20");
    g.release();
    await queue.onIdle();
    expect(store.get(job.id)!.status).toBe("succeeded");
  });

  it("failed events carry the real error and errorCode", async () => {
    const { queue, store, events } = setup();
    queue.register({
      type: "subtitles.transcribe",
      parse: (p) => p,
      async run() {
        throw new PackRequiredError("whisper", "Transcripción (Whisper)", 1.5e9);
      },
    });
    queue.register({
      type: "analyze.scenes",
      parse: (p) => p,
      async run() {
        throw new HttpError(503, "WORKERS_UNAVAILABLE", "La IA local está apagada");
      },
    });
    queue.start();
    const a = queue.enqueue({ type: "subtitles.transcribe", payload: {} });
    const b = queue.enqueue({ type: "analyze.scenes", payload: {} });
    await queue.onIdle();
    const ea = events.find((e) => e.jobId === a.id && e.status === "failed")!;
    expect(ea.errorCode).toBe("PACK_REQUIRED");
    expect(ea.error).toMatch(/Falta el paquete/);
    const eb = events.find((e) => e.jobId === b.id && e.status === "failed")!;
    expect(eb).toMatchObject({
      errorCode: "WORKERS_UNAVAILABLE",
      error: "La IA local está apagada",
    });
    expect(store.get(b.id)!.errorCode).toBe("WORKERS_UNAVAILABLE");
  });

  it("marks a job stalled when its progress does not change for 120 s", async () => {
    const { queue, store } = setup(20);
    const g = gated("perf.run");
    queue.register(g.handler);
    queue.start();
    const job = queue.enqueue({ type: "perf.run", payload: {} });
    await waitFor(() => g.ctxs.length === 1);
    g.ctxs[0]!.reportProgress(0.1, "x");
    // Pretend the last progress change was 3 minutes ago.
    const old = new Date(Date.now() - 180_000).toISOString();
    g.ctxs[0]!.reportProgress(0.1, "x", { progressAt: old });
    await waitFor(() => store.get(job.id)!.detail?.stalled === true, 2000);
    g.release();
    await queue.onIdle();
    expect(store.get(job.id)!.detail?.stalled).toBe(false);
  });

  it("409 JOB_NOT_CANCELLABLE for short jobs and detail.cancellable=false", async () => {
    const { queue, store } = setup();
    const g = gated("timeline.apply-cuts");
    const h = gated("perf.run", (ctx) => ctx.reportProgress(0.1, "x", { cancellable: false }));
    queue.register(g.handler).register(h.handler);
    queue.start();
    const a = queue.enqueue({ type: "timeline.apply-cuts", payload: {} });
    const b = queue.enqueue({ type: "perf.run", payload: {} });
    await waitFor(() => g.ctxs.length === 1 && h.ctxs.length === 1);
    expect(store.get(a.id)!.detail?.cancellable).toBe(false);
    expect(() => queue.cancel(a.id)).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "JOB_NOT_CANCELLABLE" }),
    );
    expect(() => queue.cancel(b.id)).toThrowError(HttpError);
    g.release();
    h.release();
    await queue.onIdle();
  });

  it("adds the detail/error_code columns to an old jobs table (idempotent)", () => {
    const db = openDatabase(":memory:");
    ensureSprint5Columns(db);
    ensureSprint5Columns(db);
    const cols = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(["detail", "error_code"]));
  });
});

describe("POST /api/jobs/:id/cancel", () => {
  it("answers 409 JOB_NOT_CANCELLABLE for a running media.probe", async () => {
    const { app } = await makeApp();
    try {
      const g = gated("media.probe");
      app.ctx.queue.register(g.handler);
      const job = app.ctx.queue.enqueue({ type: "media.probe", payload: {} });
      await waitFor(() => g.ctxs.length === 1);
      const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/cancel` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: "JOB_NOT_CANCELLABLE" } });
      g.release();
      await app.ctx.queue.onIdle();
    } finally {
      await app.close();
    }
  });
});
