import type { Job } from "@studio/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { JobQueue } from "../src/jobs/queue.js";
import { SqliteJobStore } from "../src/jobs/store.js";
import type { JobContext } from "../src/jobs/types.js";

/** Sprint 6 M3: a background analysis never delays a job the user asked for. */
describe("background lane", () => {
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  const until = (fn: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (fn()) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error("timeout"));
        setTimeout(tick, 5);
      };
      tick();
    });

  it("subtitles.transcribe starts while suggest.analyze is running (and queued ones wait)", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteJobStore(db);
    queue = new JobQueue({ store, storageDir: "/tmp" });
    const started: Record<string, number> = {};
    const release: Record<string, () => void> = {};
    const blocking = (type: Job["type"]) => ({
      type,
      parse: (p: unknown) => p,
      run: (_p: unknown, ctx: JobContext, job: Job) =>
        new Promise<null>((resolve, reject) => {
          started[job.id] = Date.now();
          release[job.id] = () => resolve(null);
          ctx.signal.addEventListener("abort", () => reject(new Error("abort")));
        }),
    });
    queue.register(blocking("suggest.analyze"));
    queue.register(blocking("subtitles.transcribe"));
    queue.start();
    const bg1 = queue.enqueue({
      type: "suggest.analyze",
      payload: { assetId: "a" },
      priority: -10,
    });
    // no explicit priority: the background lane defaults to -10
    const bg2 = queue.enqueue({ type: "suggest.analyze", payload: { assetId: "b" } });
    expect(db.prepare(`SELECT priority FROM jobs WHERE id = ?`).get(bg2.id)).toEqual({
      priority: -10,
    });
    await until(() => started[bg1.id] !== undefined);
    expect(queue.laneOf("suggest.analyze")).toBe("background");
    const t0 = Date.now();
    const user = queue.enqueue({ type: "subtitles.transcribe", payload: {} });
    await until(() => started[user.id] !== undefined);
    expect(started[user.id]! - t0).toBeLessThan(1000);
    // the second analysis waits for the first (background limit 1), the user job did not
    expect(started[bg2.id]).toBeUndefined();
    expect(store.get(bg2.id)?.status).toBe("queued");
    expect(queue.lanes().background).toEqual({ active: 1, limit: 1 });
    release[user.id]!();
    release[bg1.id]!();
    await until(() => started[bg2.id] !== undefined);
    release[bg2.id]!();
    await queue.onIdle();
    expect(store.get(bg2.id)?.status).toBe("succeeded");
  });

  it("a second user job of the workers lane never waits behind a background job", async () => {
    const store = new SqliteJobStore(openDatabase(":memory:"));
    queue = new JobQueue({ store, storageDir: "/tmp" });
    const order: string[] = [];
    queue.register({
      type: "suggest.analyze",
      parse: (p) => p,
      run: async () => {
        order.push("bg");
        await new Promise((r) => setTimeout(r, 200));
        return null;
      },
    });
    queue.register({
      type: "subtitles.transcribe",
      parse: (p) => p,
      run: async () => {
        order.push("user");
        return null;
      },
    });
    queue.enqueue({ type: "suggest.analyze", payload: {}, priority: -10 });
    queue.enqueue({ type: "subtitles.transcribe", payload: {} });
    queue.start();
    await queue.onIdle();
    expect(order).toContain("user");
    expect(order.indexOf("user")).toBeLessThanOrEqual(1);
  });
});
