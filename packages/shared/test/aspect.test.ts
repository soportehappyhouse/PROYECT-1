import { describe, expect, it } from "vitest";
import {
  AgentPlanChooseRequestSchema,
  aspectLabel,
  DEFAULT_EXPORT_PRESETS,
  EXTRA_EXPORT_PRESETS,
  needsAspectChoice,
  orientationEs,
  reframeTargetFor,
} from "../src/index.js";

const preset = (id: string) =>
  [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS].find((p) => p.id === id)!;
const H = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };

describe("needsAspectChoice", () => {
  it("16:9 -> 9:16 yes", () => {
    expect(needsAspectChoice(H, preset("reels-tiktok"))).toBe(true);
    expect(needsAspectChoice(H, preset("youtube-shorts"))).toBe(true);
  });
  it("9:16 -> 9:16 and 16:9 -> 16:9 no", () => {
    expect(needsAspectChoice(V, preset("reels-tiktok"))).toBe(false);
    expect(needsAspectChoice(H, preset("youtube-4k"))).toBe(false);
    // rounding of odd sizes stays the same aspect
    expect(needsAspectChoice({ width: 1281, height: 721 }, preset("youtube-1080p"))).toBe(false);
  });
  it("GIF and alpha never ask", () => {
    expect(needsAspectChoice(V, preset("gif-480"))).toBe(false);
    expect(needsAspectChoice(V, { ...preset("webm-alpha"), width: 1080, height: 1080 })).toBe(
      false,
    );
  });
  it("reframe with keyframes: no choice (the reframe applies)", () => {
    const rf = { keyframes: [{ t: 0, v: { x: 0.3, y: 0, w: 0.3, h: 1 } }] };
    expect(needsAspectChoice(H, preset("reels-tiktok"), rf)).toBe(false);
    expect(needsAspectChoice(H, preset("reels-tiktok"), { keyframes: [] })).toBe(true);
  });
});

describe("aspect labels", () => {
  it("reframe targets of presets", () => {
    expect(reframeTargetFor(preset("reels-tiktok"))).toBe("9:16");
    expect(reframeTargetFor({ width: 1080, height: 1080 })).toBe("1:1");
    expect(reframeTargetFor({ width: 1080, height: 1350 })).toBe("4:5");
    expect(reframeTargetFor(preset("youtube-1080p"))).toBeNull();
  });
  it("orientation and aspect in Spanish", () => {
    expect(orientationEs(1920, 1080)).toBe("horizontal");
    expect(orientationEs(1080, 1920)).toBe("vertical");
    expect(orientationEs(1080, 1080)).toBe("cuadrado");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1000, 300)).toBe("1000×300");
  });
  it("choose request is strict", () => {
    expect(
      AgentPlanChooseRequestSchema.safeParse({ choiceId: "aspect", optionId: "blur" }).success,
    ).toBe(true);
    expect(
      AgentPlanChooseRequestSchema.safeParse({ choiceId: "aspect", optionId: "x" }).success,
    ).toBe(false);
  });
});
