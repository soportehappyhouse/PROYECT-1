import { describe, expect, it } from "vitest";
import {
  ClipSchema,
  dedupeKeyframes,
  ease,
  interpolate,
  KEYFRAME_PARITY_CASES,
  linearizeKeyframes,
  normalizeCropRect,
  ProjectSchema,
  simplifyKeyframes,
  simplifyKeyframesToRate,
  type Keyframe,
  type Vec2,
} from "../src/index.js";

describe("interpolate (shared by export and preview)", () => {
  it.each(KEYFRAME_PARITY_CASES)("$ease at t=$t -> $expected", ({ ease: e, t, expected }) => {
    const kfs: Keyframe<number>[] = [
      { t: 0, v: 0, ease: e },
      { t: 2, v: 100, ease: "linear" },
    ];
    expect(interpolate(kfs, t)).toBe(expected);
  });

  it("easing curves at exact points", () => {
    expect(ease("linear", 0.3)).toBe(0.3);
    expect(ease("easeIn", 0.5)).toBe(0.125);
    expect(ease("easeOut", 0.5)).toBe(0.875);
    expect(ease("easeInOut", 0.5)).toBe(0.5);
    expect(ease("easeInOut", 0.25)).toBe(0.0625);
    expect(ease("hold", 0.99)).toBe(0);
    expect(ease("hold", 1)).toBe(1);
  });

  it("interpolates {x,y} and {x,y,w,h}, sorts unsorted keyframes, empty -> undefined", () => {
    const pos: Keyframe<Vec2>[] = [
      { t: 2, v: { x: 0.5, y: 0.5 }, ease: "linear" },
      { t: 0, v: { x: 0, y: 1 }, ease: "linear" },
    ];
    expect(interpolate(pos, 1)).toEqual({ x: 0.25, y: 0.75 });
    const crop = [
      { t: 0, v: { x: 0, y: 0, w: 0.5, h: 1 }, ease: "linear" as const },
      { t: 4, v: { x: 0.5, y: 0, w: 0.5, h: 1 }, ease: "linear" as const },
    ];
    expect(interpolate(crop, 1)).toEqual({ x: 0.125, y: 0, w: 0.5, h: 1 });
    expect(interpolate([], 1)).toBeUndefined();
    expect(interpolate(undefined, 1)).toBeUndefined();
  });

  it("uses the outgoing ease of each keyframe across 3 keyframes", () => {
    const kfs: Keyframe<number>[] = [
      { t: 0, v: 0, ease: "hold" },
      { t: 1, v: 10, ease: "easeOut" },
      { t: 3, v: 20, ease: "linear" },
    ];
    expect(interpolate(kfs, 0.999)).toBe(0);
    expect(interpolate(kfs, 1)).toBe(10);
    expect(interpolate(kfs, 2)).toBe(18.75);
  });
});

describe("keyframe helpers", () => {
  it("linearizes eased segments at <= rate keypoints/s and keeps linear ones", () => {
    const pts = linearizeKeyframes(
      [
        { t: 0, v: 0, ease: "linear" },
        { t: 1, v: 10, ease: "easeIn" },
        { t: 2, v: 20, ease: "hold" },
        { t: 3, v: 0, ease: "linear" },
      ],
      10,
    );
    // 0 | 1 + 9 samples | 2 + hold step | 3
    expect(pts).toHaveLength(1 + 10 + 2 + 1);
    expect(pts[2]).toEqual({ t: 1.1, v: 10 + 10 * 0.001 });
    expect(pts.at(-2)).toEqual({ t: 3 - 1e-6, v: 20 });
  });

  it("RDP keeps the corners of a polyline and drops collinear samples", () => {
    const line: Keyframe<Vec2>[] = [];
    for (let i = 0; i <= 20; i++)
      line.push({
        t: i / 10,
        v: { x: i <= 10 ? i / 10 : 1, y: i <= 10 ? 0 : (i - 10) / 10 },
        ease: "linear",
      });
    const s = simplifyKeyframes(line, 0.001);
    expect(s.map((k) => k.t)).toEqual([0, 1, 2]);
  });

  it("limits to N keyframes per second", () => {
    const wiggle: Keyframe<Vec2>[] = [];
    for (let i = 0; i <= 120; i++)
      wiggle.push({ t: i / 30, v: { x: 0.5 + 0.1 * Math.sin(i / 3), y: 0.5 }, ease: "linear" });
    const s = simplifyKeyframesToRate(wiggle, 2);
    expect(s.length).toBeLessThanOrEqual(2 * 4 + 1);
    expect(s[0]!.t).toBe(0);
    expect(s.at(-1)!.t).toBe(4);
  });

  it("dedupes repeated values and same-time keyframes", () => {
    const d = dedupeKeyframes([
      { t: 0, v: 1, ease: "linear" },
      { t: 1, v: 1, ease: "linear" },
      { t: 2, v: 1, ease: "linear" },
      { t: 2, v: 2, ease: "linear" },
    ]);
    expect(d).toEqual([
      { t: 0, v: 1, ease: "linear" },
      { t: 1, v: 1, ease: "linear" },
      { t: 2, v: 2, ease: "linear" },
    ]);
  });

  it("normalizes percent crop rects to fractions", () => {
    expect(normalizeCropRect({ x: 25, y: 0, w: 50, h: 100 })).toEqual({
      x: 0.25,
      y: 0,
      w: 0.5,
      h: 1,
    });
    expect(normalizeCropRect({ x: 0.1, y: 0, w: 0.5, h: 1 })).toEqual({
      x: 0.1,
      y: 0,
      w: 0.5,
      h: 1,
    });
  });

  it("parses the sprint 2 clip / project fields", () => {
    const clip = ClipSchema.parse({
      id: "c",
      trackId: "t",
      start: 0,
      out: 2,
      keyframes: {
        position: [{ t: 0, v: { x: 0.5, y: 0.5 } }],
        crop: [{ t: 0, v: { x: 0, y: 0, w: 0.5, h: 1 } }],
      },
      trackRef: { assetId: "trk" },
      matte: { assetId: "alpha", background: { type: "color", value: "#00ff00" } },
    });
    expect(clip.keyframes?.position?.[0]).toEqual({ t: 0, v: { x: 0.5, y: 0.5 }, ease: "linear" });
    expect(clip.keyframes?.crop?.[0]?.v).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(clip.trackRef).toEqual({ assetId: "trk", anchor: "center", offset: { x: 0, y: 0 } });
    const p = ProjectSchema.parse({
      id: "p",
      name: "x",
      settings: {},
      reframe: { target: "9:16", keyframes: [{ t: 0, v: { x: 0.3, y: 0, w: 0.316, h: 1 } }] },
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
    });
    expect(p.reframe?.mode).toBe("auto");
  });
});
