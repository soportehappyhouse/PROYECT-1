import type { Clip, Track } from "@studio/shared";
import { describe, expect, it } from "vitest";
import {
  clipAt,
  clipDuration,
  clipEnd,
  firstFreeStart,
  moveClip,
  projectDuration,
  snapClipStart,
  snapPoints,
  snapTime,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from "@/lib/timeline";

function clip(partial: Partial<Clip> & Pick<Clip, "id" | "trackId">): Clip {
  return {
    start: 0,
    in: 0,
    out: 10,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    ...partial,
  };
}

function track(id: string, kind: Track["kind"], clips: Clip[] = []): Track {
  return { id, kind, name: id, muted: false, locked: false, hidden: false, clips };
}

describe("clip math", () => {
  it("computes duration and end with speed", () => {
    const c = clip({ id: "a", trackId: "t", start: 2, in: 1, out: 9, speed: 2 });
    expect(clipDuration(c)).toBe(4);
    expect(clipEnd(c)).toBe(6);
  });

  it("finds the clip under the playhead and the project duration", () => {
    const tracks = [
      track("v", "video", [
        clip({ id: "a", trackId: "v", start: 0, out: 5 }),
        clip({ id: "b", trackId: "v", start: 5, out: 3 }),
      ]),
      track("au", "audio", [clip({ id: "c", trackId: "au", start: 1, out: 20 })]),
    ];
    expect(clipAt({ tracks }, 6)?.clip.id).toBe("b");
    expect(clipAt({ tracks }, 9)).toBeUndefined();
    expect(clipAt({ tracks }, 2, ["audio"])?.clip.id).toBe("c");
    expect(projectDuration({ tracks })).toBe(21);
  });
});

describe("split", () => {
  it("splits a clip into two contiguous parts", () => {
    const c = clip({ id: "a", trackId: "t", start: 10, in: 2, out: 12 });
    const parts = splitClip(c, 14);
    expect(parts).toBeDefined();
    const [left, right] = parts!;
    expect(left).toMatchObject({ id: "a", start: 10, in: 2, out: 6 });
    expect(right).toMatchObject({ start: 14, in: 6, out: 12 });
    expect(right.id).not.toBe("a");
    expect(clipEnd(left)).toBe(right.start);
  });

  it("respects speed when computing the cut point", () => {
    const c = clip({ id: "a", trackId: "t", start: 0, in: 0, out: 10, speed: 2 });
    const [left, right] = splitClip(c, 2)!;
    expect(left.out).toBe(4);
    expect(right.in).toBe(4);
  });

  it("refuses to split at the edges or outside", () => {
    const c = clip({ id: "a", trackId: "t", start: 0, out: 5 });
    expect(splitClip(c, 0)).toBeUndefined();
    expect(splitClip(c, 5)).toBeUndefined();
    expect(splitClip(c, 8)).toBeUndefined();
  });

  it("keeps transitionIn on the left part and transitionOut on the right part", () => {
    const c = clip({
      id: "a",
      trackId: "t",
      transitionIn: { type: "fade", durationSec: 1 },
      transitionOut: { type: "wipe", durationSec: 1 },
    });
    const [left, right] = splitClip(c, 5)!;
    expect(left.transitionIn?.type).toBe("fade");
    expect(left.transitionOut).toBeUndefined();
    expect(right.transitionIn).toBeUndefined();
    expect(right.transitionOut?.type).toBe("wipe");
  });
});

describe("trim", () => {
  it("trims the start keeping the end fixed", () => {
    const c = clip({ id: "a", trackId: "t", start: 5, in: 2, out: 10 });
    const t = trimClipStart(c, 7);
    expect(t).toMatchObject({ start: 7, in: 4, out: 10 });
    expect(clipEnd(t)).toBe(clipEnd(c));
  });

  it("cannot trim before the source start", () => {
    const c = clip({ id: "a", trackId: "t", start: 5, in: 2, out: 10 });
    expect(trimClipStart(c, 0)).toMatchObject({ start: 3, in: 0 });
  });

  it("trims the end and caps it to the asset duration", () => {
    const c = clip({ id: "a", trackId: "t", start: 0, in: 0, out: 10 });
    expect(trimClipEnd(c, 4).out).toBe(4);
    expect(trimClipEnd(c, 50, 12).out).toBe(12);
    expect(trimClipEnd(c, -3).out).toBeGreaterThan(0);
  });
});

describe("move", () => {
  it("moves within a track and across tracks of the same kind only", () => {
    const tracks = [
      track("v1", "video", [clip({ id: "a", trackId: "v1" })]),
      track("v2", "video"),
      track("au", "audio"),
    ];
    const moved = moveClip(tracks, "a", 3, "v2");
    expect(moved[0]!.clips).toHaveLength(0);
    expect(moved[1]!.clips[0]).toMatchObject({ id: "a", trackId: "v2", start: 3 });

    const refused = moveClip(moved, "a", 4, "au");
    expect(refused[2]!.clips).toHaveLength(0);
    expect(refused[1]!.clips[0]).toMatchObject({ trackId: "v2", start: 4 });
  });

  it("never moves before zero", () => {
    const tracks = [track("v", "video", [clip({ id: "a", trackId: "v", start: 2 })])];
    expect(moveClip(tracks, "a", -5)[0]!.clips[0]!.start).toBe(0);
  });

  it("finds the first free spot on a track", () => {
    const t = track("v", "video", [
      clip({ id: "a", trackId: "v", start: 0, out: 5 }),
      clip({ id: "b", trackId: "v", start: 6, out: 4 }),
    ]);
    expect(firstFreeStart(t, 0, 1)).toBe(5);
    expect(firstFreeStart(t, 0, 2)).toBe(10);
    expect(firstFreeStart(t, 20, 2)).toBe(20);
  });
});

describe("snapping", () => {
  const tracks = [
    track("v", "video", [
      clip({ id: "a", trackId: "v", start: 0, out: 5 }),
      clip({ id: "b", trackId: "v", start: 10, out: 5 }),
    ]),
  ];

  it("collects 0, playhead and clip edges", () => {
    expect(snapPoints(tracks, "b", 7).sort((x, y) => x - y)).toEqual([0, 5, 7]);
  });

  it("snaps to the nearest point within the threshold", () => {
    expect(snapTime(5.1, [0, 5, 10], 0.2)).toBe(5);
    expect(snapTime(5.5, [0, 5, 10], 0.2)).toBe(5.5);
  });

  it("snaps either edge of a moving clip", () => {
    // start near 5 -> snaps start to 5
    expect(snapClipStart(5.1, 2, [5, 20], 0.2)).toBe(5);
    // end near 20 -> start = 18
    expect(snapClipStart(17.9, 2, [5, 20], 0.2)).toBe(18);
  });
});
