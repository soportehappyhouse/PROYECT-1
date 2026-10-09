import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job, JobEvent } from "@studio/shared";
import { createAgentEvalHandler } from "../src/jobs/handlers/agent.js";
import type { JobHandler } from "../src/jobs/types.js";
import { makeApp, waitFor } from "./helpers.js";

/** Fake workers: /agent/eval + /agent/tasks/{id} (+ cancel) with a scripted task. */
describe("agent.eval (sprint 5: real progress, cancel, PACK_REQUIRED)", () => {
  let server: http.Server;
  let app: FastifyInstance;
  let storage = "";
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let script: "progress" | "slow" | "unavailable" = "progress";
  let polls = 0;
  let canceled = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        calls.push({ method: req.method!, url: req.url!, body });
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        const task = (extra: Record<string, unknown>) =>
          send(200, {
            task_id: "e1",
            kind: "agent.eval",
            target: "qwen3:8b",
            progress: 0,
            ...extra,
          });
        if (req.method === "GET" && req.url === "/packs")
          return send(200, [
            { id: "agent-llm", name_es: "Asistente local", size_bytes: 5.2e9, installed: false },
          ]);
        if (req.method === "POST" && req.url === "/agent/eval") return send(200, { task_id: "e1" });
        if (req.method === "POST" && req.url === "/agent/tasks/e1/cancel") {
          canceled = true;
          return send(200, { task_id: "e1", canceled: true, was: "running" });
        }
        if (req.method === "GET" && req.url === "/agent/tasks/e1") {
          polls++;
          if (script === "unavailable")
            return task({
              status: "error",
              error: "Ollama no está corriendo: abrí Ollama y probá de nuevo",
              code: "PACK_REQUIRED",
            });
          if (canceled) return task({ status: "canceled", done: 3, total: 20 });
          if (script === "slow" || polls < 40) {
            const done = Math.min(polls, 3);
            return task({
              status: "running",
              progress: done / 20,
              done,
              total: 20,
              stage_es: `qwen3:8b · ${done}/20`,
            });
          }
          const rel = path.join(storage, "run", "agent-eval.json");
          mkdirSync(path.dirname(rel), { recursive: true });
          writeFileSync(
            rel,
            JSON.stringify({
              mode: "quick",
              n: 20,
              models: { "qwen3:8b": { available: true, semantic_rate: 0.9 } },
            }),
          );
          return task({
            status: "done",
            progress: 1,
            done: 20,
            total: 20,
            stage_es: "qwen3:8b · 20/20",
          });
        }
        send(404, { detail: "not found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    ({ app, storage } = await makeApp({ WORKERS_URL: `http://127.0.0.1:${port}` }));
    app.ctx.queue.register(createAgentEvalHandler(app.ctx, { pollMs: 20 }) as JobHandler);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    calls.length = 0;
    polls = 0;
    canceled = false;
  });

  const getJob = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/jobs/${id}` })).json() as Job;

  it("polls /agent/tasks/{id} with stage_es and done/total; mode defaults to quick", async () => {
    script = "progress";
    const events: JobEvent[] = [];
    const listen = (e: JobEvent) => events.push(e);
    app.ctx.queue.on("job", listen);
    const res = await app.inject({ method: "POST", url: "/api/agent/eval", payload: {} });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    await waitFor(async () => (await getJob(jobId)).status === "succeeded", 10_000);
    app.ctx.queue.off("job", listen);
    expect(calls.find((c) => c.url === "/agent/eval")!.body).toMatchObject({ mode: "quick" });
    const mine = events.filter((e) => e.jobId === jobId && e.status === "running");
    const staged = mine.filter((e) => e.detail?.stage_es?.startsWith("qwen3:8b ·"));
    expect(staged.length).toBeGreaterThan(0);
    expect(staged[0]!.detail).toMatchObject({ unit: "commands", total: 20 });
    // Real progress, not the old fixed 0.5.
    expect(mine.some((e) => e.progress > 0.01 && e.progress < 0.2)).toBe(true);
    const job = await getJob(jobId);
    expect(job.result).toMatchObject({ mode: "quick" });
  });

  it("forwards mode full", async () => {
    script = "progress";
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/eval",
      payload: { mode: "full" },
    });
    const { jobId } = res.json() as { jobId: string };
    await waitFor(async () => (await getJob(jobId)).status === "succeeded", 10_000);
    expect(calls.find((c) => c.url === "/agent/eval")!.body).toMatchObject({ mode: "full" });
  });

  it("canceling the job cancels the worker task", async () => {
    script = "slow";
    const { jobId } = (
      await app.inject({ method: "POST", url: "/api/agent/eval", payload: {} })
    ).json() as { jobId: string };
    await waitFor(() => polls >= 2, 5000);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/cancel` });
    expect(res.statusCode).toBe(200);
    await waitFor(async () => (await getJob(jobId)).status === "canceled", 5000);
    await waitFor(() => canceled, 5000);
    expect(calls.some((c) => c.method === "POST" && c.url === "/agent/tasks/e1/cancel")).toBe(true);
  });

  it("no model available → failed with PACK_REQUIRED agent-llm", async () => {
    script = "unavailable";
    const { jobId } = (
      await app.inject({ method: "POST", url: "/api/agent/eval", payload: {} })
    ).json() as { jobId: string };
    await waitFor(async () => (await getJob(jobId)).status === "failed", 5000);
    const job = await getJob(jobId);
    expect(job.errorCode).toBe("PACK_REQUIRED");
    expect(job.result).toMatchObject({ error: "PACK_REQUIRED", packId: "agent-llm" });
    expect(job.error).toMatch(/Ollama/);
  });
});
