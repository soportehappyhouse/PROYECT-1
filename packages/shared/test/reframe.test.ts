import { describe, expect, it } from "vitest";
import { reframeCropAt, reframeWindow, type Keyframe } from "../src/index.js";

/**
 * Sprint 2 integration: one reframe geometry for the export (crop expressions) and the preview.
 * Keyframes come from the api in fractions of the canvas (workers send percent of the source;
 * the api converts) — percent is still accepted.
 */
describe("reframe window", () => {
  const canvas = { width: 1920, height: 1080 };

  it("is the largest target-aspect rect of the canvas", () => {
    const w916 = reframeWindow(canvas, "9:16");
    expect(w916.h).toBe(1);
    expect(w916.w * 1920).toBeCloseTo(607.5, 6);
    expect(reframeWindow(canvas, "1:1")).toEqual({ w: 1080 / 1920, h: 1 });
    const tall = reframeWindow({ width: 1080, height: 1920 }, "1:1");
    expect(tall.w).toBe(1);
    expect(tall.h * 1920).toBeCloseTo(1080, 6);
  });

  it("follows the center of the keyframes (absolute seconds), clamped inside the canvas", () => {
    const kfs: Keyframe[] = [
      { t: 1, v: { x: 0.1, y: 0, w: 0.2, h: 1 }, ease: "linear" },
      { t: 3, v: { x: 0.5, y: 0, w: 0.2, h: 1 }, ease: "linear" },
    ];
    const r = { target: "9:16" as const, keyframes: kfs };
    const w = reframeWindow(canvas, "9:16").w;
    // t=2: center 0.4 -> window x = 0.4 - w/2
    expect(reframeCropAt(r, canvas, 2)!.x).toBeCloseTo(0.4 - w / 2, 9);
    // before the first keyframe: first value (center 0.2)
    expect(reframeCropAt(r, canvas, 0)!.x).toBeCloseTo(0.2 - w / 2, 9);
    // clamped: a center at the left edge keeps the window inside
    const edge = {
      target: "9:16" as const,
      keyframes: [{ ...kfs[0]!, v: { x: 0, y: 0, w: 0, h: 1 } }],
    };
    expect(reframeCropAt(edge, canvas, 0)!.x).toBe(0);
  });

  it("percent keyframes give the same window as fractions", () => {
    const frac: Keyframe[] = [{ t: 0, v: { x: 0.3, y: 0, w: 0.3, h: 1 }, ease: "linear" }];
    const pct: Keyframe[] = [{ t: 0, v: { x: 30, y: 0, w: 30, h: 100 }, ease: "linear" }];
    const a = reframeCropAt({ target: "9:16", keyframes: frac }, canvas, 0)!;
    const b = reframeCropAt({ target: "9:16", keyframes: pct }, canvas, 0)!;
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.w).toBeCloseTo(a.w, 9);
  });

  it("no keyframes -> undefined", () => {
    expect(reframeCropAt({ target: "9:16", keyframes: [] }, canvas, 1)).toBeUndefined();
  });
});
