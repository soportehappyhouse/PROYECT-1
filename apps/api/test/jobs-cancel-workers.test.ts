import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkerStemsResultSchema } from "@studio/shared";
import { openDatabase } from "../src/db/database.js";
import { pollVisionTask } from "../src/jobs/handlers/vision.js";
import { pollWorkerTask } from "../src/jobs/handlers/util.js";
import type { AiDeps } from "../src/jobs/handlers/ai.js";
import { JobQueue } from "../src/jobs/queue.js";
import { SqliteJobStore } from "../src/jobs/store.js";
import type { JobHandler } from "../src/jobs/types.js";
import { createWorkersClient, type WorkersClient } from "../src/services/workers-client.js";
import { waitFor } from "./helpers.js";

/** Fake workers task that runs forever until POST …/cancel. */
describe("canceling a job cancels its worker task (sprint 5)", () => {
  let server: http.Server;
  let workers: WorkersClient;
  const canceledTasks: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const m = /^\/(vision|audio|style|perf|packs|agent)\/tasks\/([\w-]+)(\/cancel)?$/.exec(
          req.url ?? "",
        );
        if (!m) return send(404, { detail: "no" });
        const [, area, id, cancel] = m;
        if (cancel && req.method === "POST") {
          canceledTasks.push(`${area}/${id}`);
          return send(200, { task_id: id, canceled: true, was: "running" });
        }
        const gone = canceledTasks.includes(`${area}/${id}`);
        return send(200, {
          task_id: id,
          kind: area,
          target: "x",
          status: gone ? "canceled" : "running",
          progress: 0.3,
          done: 3,
          total: 10,
          stage_es: "Bloque 3 de 10",
          message: "trabajando",
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    workers = createWorkersClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    canceledTasks.length = 0;
  });

  function queueWith(handler: JobHandler) {
    const store = new SqliteJobStore(openDatabase(":memory:"));
    const queue = new JobQueue({ store, storageDir: "/tmp", progressThrottleMs: 0 });
    queue.register(handler);
    queue.start();
    return { store, queue };
  }

  it("vision.reframe: POST /vision/tasks/{id}/cancel and the job ends canceled", async () => {
    const deps = { workers } as unknown as AiDeps;
    const { store, queue } = queueWith({
      type: "vision.reframe",
      parse: (p) => p,
      run: (_p, ctx) =>
        pollVisionTask(deps, "r1", ctx, WorkerStemsResultSchema, {
          label: "Reencuadre",
          pollMs: 20,
        }),
    });
    const job = queue.enqueue({ type: "vision.reframe", payload: {} });
    await waitFor(() => store.get(job.id)!.detail?.stage_es === "Bloque 3 de 10", 5000);
    expect(store.get(job.id)!.detail).toMatchObject({ done: 3, total: 10 });
    queue.cancel(job.id);
    await queue.onIdle();
    expect(store.get(job.id)!.status).toBe("canceled");
    await waitFor(() => canceledTasks.includes("vision/r1"), 3000);
    await queue.stop();
  });

  it("audio.stems (generic poller): POST /audio/tasks/{id}/cancel", async () => {
    const { store, queue } = queueWith({
      type: "audio.stems",
      parse: (p) => p,
      run: (_p, ctx) => pollWorkerTask(workers, "audio", "s1", ctx, { pollMs: 20 }),
    });
    const job = queue.enqueue({ type: "audio.stems", payload: {} });
    await waitFor(() => (store.get(job.id)!.progress ?? 0) > 0.2, 5000);
    queue.cancel(job.id);
    await queue.onIdle();
    expect(store.get(job.id)!.status).toBe("canceled");
    await waitFor(() => canceledTasks.includes("audio/s1"), 3000);
    await queue.stop();
  });

  it("a task canceled elsewhere ends the vision job as canceled", async () => {
    canceledTasks.push("vision/r2");
    const deps = { workers } as unknown as AiDeps;
    const { store, queue } = queueWith({
      type: "vision.track",
      parse: (p) => p,
      run: (_p, ctx) =>
        pollVisionTask(deps, "r2", ctx, WorkerStemsResultSchema, { label: "Seguir", pollMs: 20 }),
    });
    const job = queue.enqueue({ type: "vision.track", payload: {} });
    await queue.onIdle();
    expect(store.get(job.id)!.status).toBe("canceled");
    await queue.stop();
  });
});
