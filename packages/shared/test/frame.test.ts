import { describe, expect, it } from "vitest";
import {
  captionSafeArea,
  effectiveBurnSubtitles,
  fitRect,
  ProjectSchema,
  subtitlesToBurn,
  videoRectAt,
} from "../src/index.js";

const canvas = { width: 1920, height: 1080 };

describe("frame geometry (feedback 4/7)", () => {
  it("fits a vertical 478×850 clip into a 16:9 canvas (pillarbox)", () => {
    const r = fitRect(canvas, { width: 478, height: 850 });
    expect(r.height).toBeCloseTo(1080);
    expect(r.width).toBeCloseTo(607.3, 1);
    expect(r.x).toBeCloseTo((1920 - 607.3) / 2, 0);
    expect(r.y).toBeCloseTo(0);
  });

  it("applies PiP scale and anchor like the export", () => {
    const r = fitRect(
      canvas,
      { width: 1920, height: 1080 },
      { scale: 0.5, position: { x: 1, y: 0 } },
    );
    expect(r).toEqual({ x: 960, y: 0, width: 960, height: 540 });
  });

  it("finds the video rect under a time and turns it into a caption safe area", () => {
    const now = new Date().toISOString();
    const p = ProjectSchema.parse({
      id: "p",
      name: "p",
      settings: canvas,
      createdAt: now,
      updatedAt: now,
      tracks: [
        {
          id: "v",
          kind: "video",
          name: "V",
          clips: [{ id: "c", trackId: "v", assetId: "a", start: 0, out: 10 }],
        },
      ],
    });
    const size = () => ({ width: 478, height: 850 });
    const r = videoRectAt(p, size, 5);
    expect(r.width).toBeCloseTo(607.3, 1);
    expect(videoRectAt(p, size, 50).width).toBeCloseTo(607.3, 1); // gap: first clip
    const safe = captionSafeArea(r, canvas);
    expect(safe.left).toBeGreaterThan(34);
    expect(safe.right).toBeGreaterThan(34);
    expect(videoRectAt(p, () => undefined)).toEqual({ x: 0, y: 0, ...canvas });
  });
});

describe("subtitlesToBurn (feedback 2)", () => {
  const now = new Date().toISOString();
  const project = ProjectSchema.parse({
    id: "p",
    name: "p",
    settings: canvas,
    createdAt: now,
    updatedAt: now,
    subtitles: [
      { start: 0, end: 2, text: "bajo los animados" },
      { start: 8, end: 9, text: "fuera" },
    ],
    tracks: [
      {
        id: "m",
        kind: "motion",
        name: "M",
        clips: [
          {
            id: "c",
            trackId: "m",
            start: 0,
            out: 5,
            renderedAssetId: "r",
            motion: { template: "animated-captions", durationSec: 5 },
          },
        ],
      },
    ],
  });
  it("never draws segments an animated-captions clip already shows", () => {
    expect(effectiveBurnSubtitles(project)).toBe(false);
    expect(subtitlesToBurn(project, false)).toEqual([]);
    expect(subtitlesToBurn(project, true).map((s) => s.text)).toEqual(["fuera"]);
    expect(effectiveBurnSubtitles({ ...project, burnSubtitles: true })).toBe(true);
    expect(effectiveBurnSubtitles({ ...project, burnSubtitles: true }, false)).toBe(false);
  });
});
