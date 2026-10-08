import { describe, expect, it } from "vitest";
import { estimateEtaS, formatEtaEs, isStalled, JOB_STALL_S } from "../src/index.js";

const T0 = Date.parse("2026-10-08T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("estimateEtaS", () => {
  it("uses done/total from the first item", () => {
    // 4 of 20 in 40 s since the first item -> 10 s each -> 160 s left.
    expect(
      estimateEtaS({
        progress: 0.2,
        startedAt: iso(T0),
        firstItemAt: iso(T0 + 5_000),
        now: T0 + 45_000,
        done: 4,
        total: 20,
      }),
    ).toBe(160);
  });

  it("is null before the first item and 0 when all are done", () => {
    expect(
      estimateEtaS({ progress: 0, startedAt: iso(T0), now: T0 + 60_000, done: 0, total: 20 }),
    ).toBeNull();
    expect(
      estimateEtaS({ progress: 1, startedAt: iso(T0), now: T0 + 60_000, done: 20, total: 20 }),
    ).toBe(0);
  });

  it("falls back to the progress fraction after 10 s and 2 %", () => {
    expect(estimateEtaS({ progress: 0.5, startedAt: iso(T0), now: T0 + 9_000 })).toBeNull();
    expect(estimateEtaS({ progress: 0.01, startedAt: iso(T0), now: T0 + 60_000 })).toBeNull();
    expect(estimateEtaS({ progress: 0.25, startedAt: iso(T0), now: T0 + 20_000 })).toBe(60);
  });

  it("is null with a bad start date", () => {
    expect(estimateEtaS({ progress: 0.5, startedAt: "nope", now: T0 })).toBeNull();
  });
});

describe("isStalled", () => {
  it("turns true at JOB_STALL_S without progress", () => {
    expect(JOB_STALL_S).toBe(120);
    expect(isStalled(iso(T0), T0 + 119_000)).toBe(false);
    expect(isStalled(iso(T0), T0 + 120_000)).toBe(true);
    expect(isStalled(undefined, T0)).toBe(false);
  });
});

describe("formatEtaEs", () => {
  it("formats in Spanish", () => {
    expect(formatEtaEs(null)).toBe("calculando…");
    expect(formatEtaEs(40)).toBe("faltan ~40 s");
    expect(formatEtaEs(3)).toBe("faltan ~5 s");
    expect(formatEtaEs(360)).toBe("faltan ~6 min");
    expect(formatEtaEs(4800)).toBe("faltan ~1 h 20 min");
    expect(formatEtaEs(7200)).toBe("faltan ~2 h");
  });
});
