import { renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@studio/shared";
import { failureDescription, sseRetryDelayMs, useJobEvents } from "@/hooks/use-job-events";
import {
  JOBS_ACTIVE_KEY,
  JOBS_SEEN_KEY,
  initialHandled,
  markJobsSeen,
  useJobsStore,
} from "@/stores/jobs-store";

/** Sprint 5 (M1, H2/H3): toasts once per job, with the real error, also across reloads. */

const job = (over: Partial<Job>): Job => ({
  id: "j",
  type: "subtitles.transcribe",
  status: "succeeded",
  progress: 1,
  payload: {},
  createdAt: "2026-10-08T10:00:00.000Z",
  ...over,
});

let serverJobs: Job[] = [];

function mockApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const send = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/api/jobs") return send(serverJobs);
    const m = /^\/api\/jobs\/([\w-]+)$/.exec(url.pathname);
    if (m) {
      const found = serverJobs.find((j) => j.id === m[1]);
      return found ? send(found) : send({ error: { code: "NOT_FOUND", message: "x" } }, 404);
    }
    return send({ error: { code: "NOT_FOUND", message: "x" } }, 404);
  });
}

/** A fresh page: empty in-memory store, same localStorage. */
function reload() {
  useJobsStore.setState({ jobs: {}, handled: {}, intents: {}, loaded: false });
}

function spies() {
  return {
    success: vi.spyOn(toast, "success").mockImplementation(() => 1),
    error: vi.spyOn(toast, "error").mockImplementation(() => 1),
  };
}

beforeEach(() => {
  reload();
  mockApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("job toasts (decision 6)", () => {
  it("first load shows no toasts for jobs that were already finished", async () => {
    serverJobs = [
      job({ id: "a", type: "project.export", status: "succeeded" }),
      job({ id: "b", status: "failed", error: "Falta faster-whisper" }),
    ];
    const t = spies();
    const { unmount } = renderHook(() => useJobEvents());
    await waitFor(() => expect(Object.keys(useJobsStore.getState().jobs)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.success).not.toHaveBeenCalled();
    expect(t.error).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(JOBS_SEEN_KEY)!)).toEqual(["a", "b"]);
    unmount();
  });

  it("seen ids avoid repeating a toast after a reload", async () => {
    // Tab 1 sees the job running, then it fails: one toast with the real error.
    serverJobs = [job({ id: "r", status: "running", progress: 0.4 })];
    const t = spies();
    const first = renderHook(() => useJobEvents());
    await waitFor(() => expect(useJobsStore.getState().jobs.r?.status).toBe("running"));
    serverJobs = [job({ id: "r", status: "failed", error: "Falta el paquete «Whisper»" })];
    useJobsStore
      .getState()
      .applyEvent({ jobId: "r", status: "failed", progress: 0.4, message: "Error" });
    await waitFor(() => expect(t.error).toHaveBeenCalledTimes(1));
    expect(t.error.mock.calls[0]![1]).toMatchObject({ description: "Falta el paquete «Whisper»" });
    first.unmount();
    // Reload: no new toast.
    reload();
    const second = renderHook(() => useJobEvents());
    await waitFor(() => expect(useJobsStore.getState().jobs.r?.status).toBe("failed"));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.error).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it("a job that finished while the page was reloading is notified once", async () => {
    serverJobs = [job({ id: "x", type: "project.export", status: "running", progress: 0.5 })];
    const t = spies();
    const first = renderHook(() => useJobEvents());
    await waitFor(() => expect(useJobsStore.getState().jobs.x?.status).toBe("running"));
    first.unmount();
    expect(JSON.parse(window.localStorage.getItem(JOBS_ACTIVE_KEY)!)).toContain("x");
    // It finishes during the reload.
    serverJobs = [job({ id: "x", type: "project.export", status: "succeeded" })];
    reload();
    const second = renderHook(() => useJobEvents());
    await waitFor(() => expect(t.success).toHaveBeenCalledTimes(1));
    second.unmount();
    reload();
    const third = renderHook(() => useJobEvents());
    await waitFor(() => expect(useJobsStore.getState().jobs.x?.status).toBe("succeeded"));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.success).toHaveBeenCalledTimes(1);
    third.unmount();
  });

  it("works with localStorage blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markJobsSeen(["a"])).not.toThrow();
    expect(initialHandled([job({ id: "a" })])).toEqual({ handled: ["a"], pending: [] });
  });
});

describe("failureDescription (H2)", () => {
  it("prefers the full job error over the bare «Error» message", () => {
    expect(failureDescription({ error: "Falta el paquete" }, { message: "Error" })).toBe(
      "Falta el paquete",
    );
    expect(failureDescription({}, { error: "x", message: "Error" })).toBe("x");
    expect(failureDescription({}, { message: "Error" })).toBeUndefined();
  });
});

describe("SSE reconnect (audit D8)", () => {
  it("backs off 2 s → 4 s → 8 s → 10 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(sseRetryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });

  it("reconnects after 2 s instead of 20 s and resets after opening", async () => {
    const created: FakeEventSource[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((m: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) {
        created.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = renderHook(() => useJobEvents());
      expect(created).toHaveLength(1);
      created[0]!.onerror?.();
      await vi.advanceTimersByTimeAsync(1_900);
      expect(created).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(created).toHaveLength(2); // 2 s
      created[1]!.onerror?.();
      await vi.advanceTimersByTimeAsync(3_900);
      expect(created).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(created).toHaveLength(3); // 4 s
      created[2]!.onopen?.(); // live again: the next failure waits 2 s
      created[2]!.onerror?.();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(created).toHaveLength(4);
      unmount();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
