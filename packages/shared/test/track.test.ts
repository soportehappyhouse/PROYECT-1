import { describe, expect, it } from "vitest";
import {
  ProjectSchema,
  resolveTrackRefs,
  trackPointAt,
  trackRefKeyframes,
  trackToCanvas,
  type TrackFile,
} from "../src/index.js";

const track: TrackFile = {
  version: 1,
  fps: 10,
  smoothed: true,
  source: { assetId: "src", method: "csrt" },
  // box 0.1×0.2 moving from x=0.1 to x=0.7 over 2 s of source time
  frames: Array.from({ length: 21 }, (_, i) => ({
    t: i / 10,
    x: 0.1 + 0.03 * i,
    y: 0.4,
    w: 0.1,
    h: 0.2,
    conf: 1,
  })),
};

const project = (videoClip: Record<string, unknown>) =>
  ProjectSchema.parse({
    id: "p",
    name: "p",
    settings: { width: 1920, height: 1080 },
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "V",
        clips: [{ id: "vc", trackId: "v", assetId: "src", start: 0, in: 0, out: 2, ...videoClip }],
      },
      {
        id: "t",
        kind: "text",
        name: "T",
        clips: [
          {
            id: "tc",
            trackId: "t",
            start: 0.5,
            out: 1,
            text: "Hola",
            trackRef: { assetId: "trk", anchor: "top", offset: { x: 0, y: -0.05 } },
          },
        ],
      },
    ],
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  });
const size = () => ({ width: 1920, height: 1080 });

describe("track geometry", () => {
  it("maps source boxes to the canvas through the video clip (time + PiP rect)", () => {
    const p = project({ start: 1, in: 0.5, scale: 0.5, position: { x: 0, y: 0 } });
    const follower = p.tracks[1]!.clips[0]!; // starts at 0.5 on the timeline
    const ct = trackToCanvas(p, follower, track, size);
    // timeline 1.0 = source 0.5 -> local 0.5; PiP rect = top-left quarter
    const f = ct.frames.find((x) => Math.abs(x.t - 0.5) < 1e-9)!;
    expect(f.x).toBeCloseTo((0.1 + 0.03 * 5) * 0.5, 9);
    expect(f.y).toBeCloseTo(0.2, 9);
    expect(f.w).toBeCloseTo(0.05, 9);
    expect(trackPointAt(ct, 0.5, "center")!.x).toBeCloseTo(0.125 + 0.025, 9);
  });

  it("builds center keyframes with anchor + offset and resolves trackRef", () => {
    const p = project({});
    const follower = p.tracks[1]!.clips[0]!;
    const kfs = trackRefKeyframes(p, follower, track, size);
    expect(kfs[0]!.t).toBe(0);
    expect(kfs.at(-1)!.t).toBeCloseTo(1, 9);
    // local 0 = source 0.5: x center = 0.25 + 0.05, top = 0.4, offset -0.05
    expect(kfs[0]!.v.x).toBeCloseTo(0.3, 9);
    expect(kfs[0]!.v.y).toBeCloseTo(0.35, 9);
    // linear motion -> RDP keeps only the ends
    expect(kfs).toHaveLength(2);
    const resolved = resolveTrackRefs(p, new Map([["trk", track]]), size);
    const c = resolved.tracks[1]!.clips[0]!;
    expect(c.trackRef).toBeUndefined();
    expect(c.keyframes?.position).toEqual(kfs);
  });
});
