import { describe, expect, it } from "vitest";
import {
  createWorkersClient,
  WorkersError,
  workersDownMessage,
} from "../src/services/workers-client.js";
import { createStyleWorkers } from "../src/services/style/workers.js";
import { makeApp } from "./helpers.js";

const DOWN = "http://127.0.0.1:1";

describe("WORKERS_UNAVAILABLE (sprint 5, H4)", () => {
  it("speaks Spanish with start.cmd and hides the raw cause", async () => {
    const err = await createWorkersClient(DOWN)
      .packs()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkersError);
    const w = err as WorkersError;
    expect(w.code).toBe("WORKERS_UNAVAILABLE");
    expect(w.statusCode).toBe(503);
    expect(w.message).toContain("scripts\\windows\\start.cmd");
    expect(w.message).toContain("127.0.0.1:1");
    expect(w.message).not.toMatch(/TypeError|ECONNREFUSED|fetch failed|start\.ps1/);
    expect(w.details).toEqual({ url: DOWN });
    expect(workersDownMessage("http://127.0.0.1:8001")).toBe(
      "La IA local está apagada (no responde en 127.0.0.1:8001). Cerrá Studio y abrilo con scripts\\windows\\start.cmd.",
    );
  });

  it("style workers use the same text", async () => {
    const err = (await createStyleWorkers(DOWN)
      .task("x")
      .catch((e: unknown) => e)) as WorkersError;
    expect(err.code).toBe("WORKERS_UNAVAILABLE");
    expect(err.message).toContain("start.cmd");
    expect(err.message).not.toMatch(/TypeError|ECONNREFUSED/);
  });

  it("routes answer 503 WORKERS_UNAVAILABLE with start.cmd", async () => {
    const { app } = await makeApp();
    try {
      const project = (
        await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P" } })
      ).json() as { id: string };
      const res = await app.inject({
        method: "POST",
        url: "/api/agent/plan",
        payload: { projectId: project.id, command: "agregá un título que diga hola" },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("WORKERS_UNAVAILABLE");
      expect(body.error.message).toContain("start.cmd");
      expect(body.error.message).not.toMatch(/TypeError|ECONNREFUSED/);
    } finally {
      await app.close();
    }
  });
});
