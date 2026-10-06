import { describe, expect, it } from "vitest";
import {
  FEATURE_VRAM_MB,
  JobTypeSchema,
  STEM_NAMES,
  STEMS_API_ROUTES,
  STEMS_JOB_TYPE,
  StemsRequestSchema,
  StemsResultSchema,
  stemTrackNames,
  willRunOnCpu,
  WorkerStemsResultSchema,
} from "../src/index.js";

describe("stems contract (sprint 3b §C)", () => {
  it("job type, routes and GPU estimate", () => {
    expect(JobTypeSchema.parse(STEMS_JOB_TYPE)).toBe("audio.stems");
    expect(STEMS_API_ROUTES.stems).toBe("/api/audio/stems");
    expect(FEATURE_VRAM_MB.stems).toBe(2000);
    expect(willRunOnCpu({ mode: "gpu", vram_free_mb: 1500 }, "stems")).toBe(true);
    expect(willRunOnCpu({ mode: "gpu", vram_free_mb: 4000 }, "stems")).toBe(false);
  });

  it("request: assetId or clipId (+ target), default mode two", () => {
    expect(StemsRequestSchema.parse({ assetId: "a" })).toEqual({ assetId: "a", mode: "two" });
    expect(
      StemsRequestSchema.parse({ clipId: "c", mode: "four", target: { projectId: "p" } }),
    ).toMatchObject({ clipId: "c", mode: "four" });
    expect(StemsRequestSchema.safeParse({}).success).toBe(false);
    expect(StemsRequestSchema.safeParse({ clipId: "c" }).success).toBe(false);
    expect(StemsRequestSchema.safeParse({ assetId: "a", mode: "six" }).success).toBe(false);
  });

  it("stem names and Spanish track names", () => {
    expect(STEM_NAMES.two).toEqual(["vocals", "no_vocals"]);
    expect(stemTrackNames("two")).toEqual(["Voz", "Música"]);
    expect(stemTrackNames("four")).toEqual(["Voz", "Batería", "Bajo", "Otros"]);
  });

  it("worker and job results", () => {
    const w = WorkerStemsResultSchema.parse({
      stems: { vocals: "renders/x-vocals.wav", no_vocals: "renders/x-no_vocals.wav" },
      device: "cuda",
      segment: 7,
      warnings: null,
    });
    expect(w.sample_rate).toBe(44_100);
    const r = StemsResultSchema.parse({
      mode: "two",
      sourceAssetId: "a",
      stems: [{ name: "vocals", label: "Voz", assetId: "s1", path: "renders/x-vocals.wav" }],
      sampleRate: 44_100,
      device: "cpu",
      undoSnapshotId: "snap",
    });
    expect(r.stems[0]!.label).toBe("Voz");
  });
});
