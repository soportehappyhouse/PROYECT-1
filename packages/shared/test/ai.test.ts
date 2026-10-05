import { describe, expect, it } from "vitest";
import {
  aiLabelText,
  AnalyzeSilencesRequestSchema,
  API_ROUTES,
  DEFAULT_AI_LABEL_TEXT,
  ExportRequestSchema,
  GpuStatusSchema,
  JobTypeSchema,
  MediaAssetSchema,
  PackRequiredBodySchema,
  PackSchema,
  PackTaskSchema,
  PerfResultSchema,
  ProjectSchema,
  PublishSettingsSchema,
  SilenceCutsSchema,
} from "../src/index.js";

const now = "2026-10-05T00:00:00.000Z";

describe("Sprint 1 AI contract", () => {
  it("parses workers payloads (snake_case, nulls)", () => {
    expect(
      GpuStatusSchema.parse({
        cuda: false,
        gpu_name: null,
        vram_total_mb: null,
        vram_free_mb: null,
        resident_model: null,
        mode: "cpu",
        sysmem_fallback: false,
      }),
    ).toMatchObject({ mode: "cpu", resident_model: null });
    const pack = PackSchema.parse({
      id: "scenes",
      name_es: "Escenas",
      size_bytes: 5e7,
      installed: false,
    });
    expect(pack).toMatchObject({ partial: false, files: [], required_by: [] });
    expect(PackTaskSchema.parse({ status: "running", progress: 0.4 })).toMatchObject({
      bytes_done: 0,
    });
    expect(
      SilenceCutsSchema.parse({ cuts: [{ start: 1, end: 2 }], total_removed_s: 1 }).cuts[0]!.kind,
    ).toBe("silence");
    expect(
      PerfResultSchema.parse({
        gpu: "RTX 4050",
        whisper_turbo_s_per_min: 3,
        piper_s_per_100chars: null,
        scenes_fps: 200,
        ran_at: now,
      }).cpu_fallback_ok,
    ).toBe(false);
    expect(
      PackRequiredBodySchema.parse({
        error: "PACK_REQUIRED",
        packId: "voz-limpia",
        name_es: "Voz limpia",
        size_bytes: 2e8,
      }).packId,
    ).toBe("voz-limpia");
  });

  it("adds job types, routes, request defaults and the segment cache flag", () => {
    for (const t of [
      "packs.download",
      "analyze.scenes",
      "analyze.silences",
      "timeline.apply-cuts",
      "audio.denoise",
      "perf.run",
    ])
      expect(JobTypeSchema.parse(t)).toBe(t);
    expect(API_ROUTES.aiPackDownload).toBe("/api/ai/packs/:id/download");
    expect(AnalyzeSilencesRequestSchema.parse({ projectId: "p", clipId: "c" }).options).toEqual({
      minSilenceMs: 500,
      noiseDb: -35,
      paddingMs: 120,
      fillers: true,
    });
    expect(ExportRequestSchema.parse({ presetId: "x" }).useSegmentCache).toBeUndefined();
    expect(
      ExportRequestSchema.parse({ presetId: "x", useSegmentCache: false }).useSegmentCache,
    ).toBe(false);
  });

  it("keeps project.publish and asset scenes (additive, optional)", () => {
    const base = { id: "p", name: "P", settings: {}, createdAt: now, updatedAt: now };
    expect(ProjectSchema.parse(base).publish).toBeUndefined();
    const p = ProjectSchema.parse({ ...base, publish: { forSocial: true, aiLabel: true } });
    expect(p.publish).toEqual({
      forSocial: true,
      aiLabel: true,
      flags: { aiFace: false, aiVoice: false, aiOther: false, music: false, thirdParty: false },
    });
    expect(aiLabelText(p.publish)).toBe(DEFAULT_AI_LABEL_TEXT);
    expect(aiLabelText(PublishSettingsSchema.parse({ aiLabel: true, aiLabelText: "  IA  " }))).toBe(
      "IA",
    );
    expect(aiLabelText(PublishSettingsSchema.parse({ aiLabel: false }))).toBeUndefined();
    const asset = MediaAssetSchema.parse({
      id: "a",
      kind: "video",
      name: "a",
      path: "media/a.mp4",
      sizeBytes: 1,
      createdAt: now,
      scenes: [{ start: 0, end: 2, score: 12 }],
    });
    expect(asset.scenes).toHaveLength(1);
  });
});
