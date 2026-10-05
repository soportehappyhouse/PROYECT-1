import { describe, expect, it } from "vitest";
import {
  aiLabelText,
  AnalyzeSilencesRequestSchema,
  API_ROUTES,
  DEFAULT_AI_LABEL_TEXT,
  ExportRequestSchema,
  FEATURE_PACKS,
  FEATURE_VRAM_MB,
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
  SilenceOptionsSchema,
  TranscribeJobResultSchema,
  TranscribeRequestSchema,
  willRunOnCpu,
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

  it("estimates VRAM per feature and predicts the CPU fallback (decision 7)", () => {
    expect(FEATURE_VRAM_MB).toEqual({ transcribe: 2500, rvc: 2000, denoise: 1000 });
    expect(willRunOnCpu({ mode: "cpu", vram_free_mb: null }, "denoise")).toBe(true);
    expect(willRunOnCpu({ mode: "gpu", vram_free_mb: 2200 }, "transcribe")).toBe(true);
    expect(willRunOnCpu({ mode: "gpu", vram_free_mb: 2200 }, "rvc")).toBe(false);
    expect(willRunOnCpu({ mode: "gpu", vram_free_mb: null }, "transcribe")).toBe(false);
    expect(willRunOnCpu(undefined, "rvc")).toBe(false);
  });

  it("packs on demand: rvc-base required, whisper-turbo suggested; vad flags (decision 6)", () => {
    expect(FEATURE_PACKS.rvc).toBe("rvc-base");
    expect(FEATURE_PACKS.transcribeGpu).toBe("whisper-turbo");
    const suggestedPack = { packId: "whisper-turbo", name_es: "Whisper turbo", size_bytes: 1.6e9 };
    const r = TranscribeJobResultSchema.parse({
      assetId: "a",
      path: "renders/j.json",
      srtPath: "renders/j.srt",
      assPath: "renders/j.ass",
      transcript: { language: "es", durationSec: 1, segments: [] },
      suggestedPack,
    });
    expect(r.suggestedPack).toEqual(suggestedPack);
    expect(TranscribeRequestSchema.parse({ assetId: "a", vad: false }).vad).toBe(false);
    expect(TranscribeRequestSchema.parse({ assetId: "a" }).vad).toBeUndefined();
    expect(SilenceOptionsSchema.parse({ vad: false }).vad).toBe(false);
  });

  it("burns the AI label only when forSocial and aiLabel are both on (decision 4)", () => {
    const on = PublishSettingsSchema.parse({ forSocial: true, aiLabel: true });
    expect(aiLabelText(on)).toBe(DEFAULT_AI_LABEL_TEXT);
    expect(aiLabelText({ ...on, forSocial: false })).toBeUndefined();
    expect(aiLabelText({ ...on, aiLabel: false })).toBeUndefined();
    expect(aiLabelText(undefined)).toBeUndefined();
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
    expect(
      aiLabelText(
        PublishSettingsSchema.parse({ forSocial: true, aiLabel: true, aiLabelText: "  IA  " }),
      ),
    ).toBe("IA");
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
