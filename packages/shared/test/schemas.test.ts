import { describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  DEFAULT_DASHBOARD_SETTINGS,
  DEFAULT_EXPORT_PRESETS,
  DashboardSettingsSchema,
  ExportPresetSchema,
  MotionSpecSchema,
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
});
