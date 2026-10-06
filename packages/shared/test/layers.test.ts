import { describe, expect, it } from "vitest";
import {
  BLEND_MODES,
  blendChannel,
  blendModeToCanvas,
  blendModeToFfmpeg,
  blendRgb,
  ClipSchema,
  maskShapeRect,
  moveTrackZ,
  normalizeTrackOrder,
  ProjectSchema,
  TrackSchema,
  tracksInZOrder,
} from "../src/index.js";

describe("sprint 3b layers (blend modes, masks, z-order)", () => {
  it("maps every blend mode to FFmpeg blend and canvas composite operations", () => {
    expect(BLEND_MODES.map(blendModeToFfmpeg)).toEqual([
      undefined,
      "multiply",
      "screen",
      "overlay",
      "addition",
      "difference",
      "lighten",
      "darken",
    ]);
    expect(BLEND_MODES.map(blendModeToCanvas)).toEqual([
      "source-over",
      "multiply",
      "screen",
      "overlay",
      "lighter",
      "difference",
      "lighten",
      "darken",
    ]);
    expect(blendModeToFfmpeg(undefined)).toBeUndefined();
    expect(blendModeToCanvas(undefined)).toBe("source-over");
  });

  it("reference blend formulas (W3C separable modes)", () => {
    expect(blendRgb("multiply", [128, 64, 192], [96, 160, 255])).toEqual([48, 40, 192]);
    expect(blendRgb("screen", [128, 64, 192], [96, 160, 255])).toEqual([176, 184, 255]);
    // overlay depends on the backdrop (base), not on the layer
    expect(blendChannel("overlay", 64, 200)).toBe(100);
    expect(blendChannel("overlay", 200, 64)).toBe(173);
    expect(blendChannel("add", 200, 100)).toBe(255);
    expect(blendChannel("add", 192, 255, 0.5)).toBe(255);
    expect(blendChannel("difference", 50, 200)).toBe(150);
    expect(blendChannel("normal", 0, 255, 0.5)).toBe(128);
    expect(blendChannel("multiply", 255, 0, 0.25)).toBe(191);
  });

  it("schema is migration-safe: old clips/tracks parse without the new fields", () => {
    const clip = ClipSchema.parse({ id: "c", trackId: "t", start: 0, out: 1 });
    expect(clip.blendMode).toBeUndefined();
    expect(clip.maskRef).toBeUndefined();
    expect(TrackSchema.parse({ id: "t", kind: "video", name: "V" }).order).toBeUndefined();
    const masked = ClipSchema.parse({
      id: "c",
      trackId: "t",
      start: 0,
      out: 1,
      blendMode: "screen",
      maskRef: { type: "shape", shape: "ellipse", x: 0, y: 0, w: 1, h: 1 },
    });
    expect(masked.maskRef).toEqual({
      type: "shape",
      shape: "ellipse",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      feather: 0,
      invert: false,
    });
    expect(
      ClipSchema.safeParse({ id: "c", trackId: "t", start: 0, out: 1, blendMode: "burn" }).success,
    ).toBe(false);
    expect(
      ClipSchema.parse({
        id: "c",
        trackId: "t",
        start: 0,
        out: 1,
        maskRef: { type: "asset", assetId: "m1" },
      }).maskRef,
    ).toEqual({ type: "asset", assetId: "m1" });
    const now = new Date().toISOString();
    const p = ProjectSchema.parse({
      id: "p",
      name: "p",
      settings: {},
      tracks: [{ id: "a", kind: "video", name: "A", order: 1 }],
      createdAt: now,
      updatedAt: now,
    });
    expect(p.tracks[0]!.order).toBe(1);
  });

  it("z-order: Track.order wins, index otherwise (stable)", () => {
    const tracks = [{ id: "a", order: 2 }, { id: "b" }, { id: "c", order: 0 }];
    // a → 2, b → 1 (index), c → 0
    expect(tracksInZOrder(tracks).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(tracksInZOrder([{ id: "x" }, { id: "y" }]).map((t) => t.id)).toEqual(["x", "y"]);
    expect(normalizeTrackOrder(tracks).map((t) => [t.id, t.order])).toEqual([
      ["c", 0],
      ["b", 1],
      ["a", 2],
    ]);
    const moved = moveTrackZ([{ id: "v1" }, { id: "v2" }, { id: "v3" }], "v1", 2);
    expect(moved.map((t) => `${t.id}:${t.order}`)).toEqual(["v2:0", "v3:1", "v1:2"]);
    expect(moveTrackZ(moved, "v1", -5).map((t) => t.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("shape mask rect in canvas px", () => {
    expect(
      maskShapeRect(
        { x: 100, y: 50, width: 400, height: 200 },
        { x: 0.25, y: 0.5, w: 0.5, h: 0.25 },
      ),
    ).toEqual({ x: 200, y: 150, width: 200, height: 50 });
  });
});
