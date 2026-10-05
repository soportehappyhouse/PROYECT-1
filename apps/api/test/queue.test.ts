import { afterEach, describe, expect, it } from "vitest";
import type { Job, JobEvent } from "@studio/shared";
import { openDatabase } from "../src/db/database.js";
import { JobQueue } from "../src/jobs/queue.js";
import { canTransition, DEFAULT_JOB_LANES, isTerminal } from "../src/jobs/state.js";
import { SqliteJobStore } from "../src/jobs/store.js";
import type { JobContext, JobHandler } from "../src/jobs/types.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, timeout = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error("timeout");
    await wait(5);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Handler whose runs block until released; records ctx for assertions. */
function blockingHandler(type: JobHandler["type"]) {
  const runs: { job: Job; ctx: JobContext; gate: ReturnType<typeof deferred> }[] = [];
  const handler: JobHandler<{ n?: number }, { ok: boolean }> = {
    type,
    parse: (p) => (p ?? {}) as { n?: number },
    async run(_p, ctx, job) {
      const gate = deferred();
      runs.push({ job, ctx, gate });
      await new Promise<void>((resolve, reject) => {
        gate.promise.then(resolve, reject);
        ctx.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
      return { ok: true };
    },
  };
  return { handler, runs };
}

let queues: JobQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.map((q) => q.stop()));
  queues = [];
});

function setup(
  lanes?: { ffmpeg?: number; motion?: number; workers?: number },
  progressThrottleMs = 0,
) {
  const db = openDatabase(":memory:");
  const store = new SqliteJobStore(db);
  const queue = new JobQueue({
    store,
    storageDir: "/tmp",
    lanes: lanes ?? {},
    progressThrottleMs,
  });
  const events: JobEvent[] = [];
  queue.on("job", (e) => events.push(e));
  queues.push(queue);
  return { db, store, queue, events };
}

describe("job state machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("queued", "canceled")).toBe(true);
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "canceled")).toBe(true);
    expect(canTransition("running", "queued")).toBe(true);
    for (const s of ["succeeded", "failed", "canceled"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, "running")).toBe(false);
    }
    expect(DEFAULT_JOB_LANES["motion.render"]).toBe("motion");
    expect(DEFAULT_JOB_LANES["voice.tts"]).toBe("workers");
    expect(DEFAULT_JOB_LANES["project.export"]).toBe("ffmpeg");
  });
});

describe("JobQueue", () => {
  it("runs a job to success with progress events and persisted result", async () => {
    const { queue, store, events } = setup();
    queue.register({
      type: "media.probe",
      parse: (p) => p,
      async run(_p, ctx) {
        ctx.reportProgress(0.5, "mitad");
        ctx.log("hola log");
        return { path: "x" };
      },
    });
    queue.start();
    const job = queue.enqueue({ type: "media.probe", payload: { assetId: "a" } });
    await until(() => store.get(job.id)!.status === "succeeded");
    expect(store.get(job.id)).toMatchObject({
      status: "succeeded",
      progress: 1,
      result: { path: "x" },
    });
    expect(store.logTail(job.id)).toEqual(["hola log"]);
    const statuses = events.filter((e) => e.jobId === job.id).map((e) => e.status);
    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("succeeded");
    expect(events.some((e) => e.progress === 0.5 && e.message === "mitad")).toBe(true);
  });

  it("publishes the last throttled progress step when the job ends inside the window", async () => {
    const { queue, store, events } = setup(undefined, 60_000);
    queue.register({
      type: "media.probe",
      parse: (p) => p,
      async run(_p, ctx) {
        ctx.reportProgress(0.1, "primero");
        ctx.reportProgress(0.5, "intermedio");
        ctx.reportProgress(0.9, "último paso");
        return { path: "x" };
      },
    });
    queue.start();
    const job = queue.enqueue({ type: "media.probe", payload: { assetId: "a" } });
    await until(() => store.get(job.id)!.status === "succeeded");
    const mine = events.filter((e) => e.jobId === job.id);
    const messages = mine.map((e) => e.message);
    expect(messages).toContain("primero");
    expect(messages).not.toContain("intermedio");
    const last = messages.indexOf("último paso");
    expect(last).toBeGreaterThan(-1);
    expect(mine[last]).toMatchObject({ status: "running", progress: 0.9 });
    expect(mine.at(-1)).toMatchObject({ status: "succeeded", message: "Completado" });
  });

  it("marks failures with the error message", async () => {
    const { queue, store } = setup();
    queue.register({
      type: "media.proxy",
      parse: (p) => p,
      run: async () => Promise.reject(new Error("boom")),
    });
    queue.start();
    const job = queue.enqueue({ type: "media.proxy", payload: {} });
    await until(() => store.get(job.id)!.status === "failed");
    expect(store.get(job.id)!.error).toBe("boom");
    expect(store.logTail(job.id)).toContain("ERROR: boom");
  });

  it("respects lane concurrency (ffmpeg 2, motion 1) and priority", async () => {
    const { queue, store } = setup({ ffmpeg: 2, motion: 1 });
    const ff = blockingHandler("project.export");
    const mo = blockingHandler("motion.render");
    queue.register(ff.handler).register(mo.handler);
    queue.start();
    const jobs = [1, 2, 3].map(() => queue.enqueue({ type: "project.export", payload: {} }));
    const m = [1, 2].map(() => queue.enqueue({ type: "motion.render", payload: {} }));
    await until(() => ff.runs.length === 2 && mo.runs.length === 1);
    await wait(20);
    expect(ff.runs).toHaveLength(2);
    expect(mo.runs).toHaveLength(1);
    expect(store.get(jobs[2]!.id)!.status).toBe("queued");
    expect(store.get(m[1]!.id)!.status).toBe("queued");
    // a high-priority job jumps the ffmpeg lane queue
    const urgent = queue.enqueue({ type: "project.export", payload: {}, priority: 5 });
    ff.runs[0]!.gate.resolve();
    await until(() => ff.runs.length === 3);
    expect(ff.runs[2]!.job.id).toBe(urgent.id);
    for (const r of [...ff.runs, ...mo.runs]) r.gate.resolve();
    await until(() => ff.runs.length === 4 && mo.runs.length === 2);
    for (const r of [...ff.runs, ...mo.runs]) r.gate.resolve();
    await queue.onIdle();
    expect(store.list({ status: "succeeded" })).toHaveLength(6);
  });

  it("cancels queued and running jobs (aborting the signal)", async () => {
    const { queue, store } = setup({ ffmpeg: 1 });
    const ff = blockingHandler("project.export");
    queue.register(ff.handler);
    queue.start();
    const a = queue.enqueue({ type: "project.export", payload: {} });
    const b = queue.enqueue({ type: "project.export", payload: {} });
    await until(() => ff.runs.length === 1);
    expect(queue.cancel(b.id)!.status).toBe("canceled");
    queue.cancel(a.id);
    await until(() => store.get(a.id)!.status === "canceled");
    expect(ff.runs[0]!.ctx.signal.aborted).toBe(true);
    expect(store.get(b.id)!.finishedAt).toBeDefined();
    // terminal jobs are unchanged by cancel
    expect(queue.cancel(a.id)!.status).toBe("canceled");
    expect(queue.cancel("nope")).toBeUndefined();
  });

  it("keeps jobs without a handler queued until one is registered", async () => {
    const { queue, store } = setup();
    queue.start();
    const job = queue.enqueue({ type: "voice.tts", payload: { text: "hola" } });
    await wait(20);
    expect(store.get(job.id)!.status).toBe("queued");
    queue.register({
      type: "voice.tts",
      parse: (p) => p,
      run: async () => ({ path: "renders/x.wav" }),
    });
    await until(() => store.get(job.id)!.status === "succeeded");
  });

  it("re-queues jobs left running by a restart, then fails after max attempts", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteJobStore(db);
    const first = store.create({ type: "media.probe", payload: {} });
    store.claimNext(["media.probe"]); // attempt 1, now "running" (simulated crash)
    const queue = new JobQueue({ store, storageDir: "/tmp", maxAttempts: 2 });
    queues.push(queue);
    let runs = 0;
    queue.register({ type: "media.probe", parse: (p) => p, run: async () => ({ runs: ++runs }) });
    queue.start();
    await until(() => store.get(first.id)!.status === "succeeded");
    expect(store.attempts(first.id)).toBe(2);

    const second = store.create({ type: "media.probe", payload: {} });
    store.claimNext(["media.probe"]);
    store.update(second.id, { status: "queued" });
    store.claimNext(["media.probe"]); // attempts = 2, running
    expect(store.recoverInterrupted(2)).toBe(0);
    expect(store.get(second.id)).toMatchObject({ status: "failed" });
  });

  it("stop() leaves running jobs queued for the next start", async () => {
    const { queue, store } = setup();
    const ff = blockingHandler("media.proxy");
    queue.register(ff.handler);
    queue.start();
    const job = queue.enqueue({ type: "media.proxy", payload: {} });
    await until(() => ff.runs.length === 1);
    await queue.stop();
    expect(store.get(job.id)!.status).toBe("queued");
  });
});
