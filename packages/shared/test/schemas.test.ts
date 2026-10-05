import { describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  DEFAULT_DASHBOARD_SETTINGS,
  DEFAULT_EXPORT_PRESETS,
  DashboardSettingsSchema,
  EXTRA_EXPORT_PRESETS,
  ExportPresetSchema,
  MediaAssetSchema,
  MotionRenderRequestSchema,
  MotionSpecSchema,
  ProjectSchema,
  VOICE_EFFECT_PRESETS,
  WORKER_ROUTES,
  TtsRequestSchema,
  VoiceEffectSchema,
} from "../src/index.js";

describe("shared schemas", () => {
  it("default export presets are valid", () => {
    for (const preset of DEFAULT_EXPORT_PRESETS) {
      expect(() => ExportPresetSchema.parse(preset)).not.toThrow();
    }
  });

  it("default dashboard settings are valid", () => {
    expect(DashboardSettingsSchema.parse(DEFAULT_DASHBOARD_SETTINGS).theme).toBe("system");
  });

  it("applies MotionSpec defaults", () => {
    const spec = MotionSpecSchema.parse({ template: "title-card", durationSec: 3 });
    expect(spec).toMatchObject({
      schemaVersion: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      format: "mp4-h264",
      includeAudio: false,
    });
  });

  it("validates voice effects and TTS requests", () => {
    expect(VoiceEffectSchema.parse({ type: "pitch", semitones: 3 }).type).toBe("pitch");
    expect(() => VoiceEffectSchema.parse({ type: "pitch", semitones: 99 })).toThrow();
    expect(TtsRequestSchema.parse({ text: "Hola", voice: "es_AR-daniela-high" }).provider).toBe(
      "piper",
    );
  });

  it("builds routes with params", () => {
    expect(buildRoute(API_ROUTES.job, { id: "a b" })).toBe("/api/jobs/a%20b");
    expect(() => buildRoute(API_ROUTES.job)).toThrow();
  });

  it("merged contract extensions (routes, effects, presets, media, settings, timeline)", () => {
    expect(API_ROUTES.libraryScan).toBe("/api/library/scan");
    expect(API_ROUTES.projectAutosave).toBe("/api/projects/:id/autosave");
    expect(WORKER_ROUTES.jobProgress).toBe("/jobs/:id");
    for (const p of VOICE_EFFECT_PRESETS)
      expect(VoiceEffectSchema.array().parse(p.effects)).toBeTruthy();
    expect(VoiceEffectSchema.parse({ type: "loudnorm" })).toMatchObject({ integrated: -16 });
    for (const p of EXTRA_EXPORT_PRESETS) expect(() => ExportPresetSchema.parse(p)).not.toThrow();
    expect(ExportPresetSchema.parse(DEFAULT_EXPORT_PRESETS[0]).alpha).toBe(false);
    expect(
      MediaAssetSchema.parse({
        id: "a",
        kind: "video",
        name: "a",
        path: "media/a.mp4",
        sizeBytes: 1,
        hasAlpha: true,
        videoCodec: "vp9",
        waveformPath: "proxies/a.peaks.json",
        createdAt: "2026-10-04T00:00:00.000Z",
      }).hasAlpha,
    ).toBe(true);
    const ui = { accent: "#000", density: "compact", layout: { a: 1 } };
    expect(DashboardSettingsSchema.parse({ ...DEFAULT_DASHBOARD_SETTINGS, ui }).ui).toMatchObject(
      ui,
    );
    const project = ProjectSchema.parse({
      id: "p",
      name: "p",
      settings: {},
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      tracks: [
        {
          id: "t",
          kind: "video",
          name: "v",
          clips: [
            { id: "c", trackId: "t", start: 0, out: 1, scale: 0.3, position: { x: 1, y: 1 } },
          ],
        },
      ],
    });
    expect(project.tracks[0]!.clips[0]!.scale).toBe(0.3);
    expect(
      MotionRenderRequestSchema.parse({
        template: "title-card",
        durationSec: 1,
        target: { projectId: "p", clipId: "c" },
      }).target,
    ).toEqual({ projectId: "p", clipId: "c" });
  });
});
