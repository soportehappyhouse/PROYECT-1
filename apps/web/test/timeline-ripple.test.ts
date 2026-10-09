import type { Clip, Track } from "@studio/shared";
import { describe, expect, it } from "vitest";
import {
  clipEnd,
  clipsInRect,
  closeGaps,
  mergeRanges,
  rippleDelete,
  rippleTime,
  trackGaps,
  trimToCursor,
} from "@/lib/timeline";

/** Sprint 5 (M2): ripple delete, close gaps and Q/W on the pure timeline helpers. */
const clip = (id: string, trackId: string, start: number, len: number, extra = {}): Clip => ({
  id,
  trackId,
  start,
  in: 0,
  out: len,
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
  ...extra,
});
const track = (id: string, clips: Clip[], extra: Partial<Track> = {}): Track => ({
  id,
  kind: "video",
  name: id,
  muted: false,
  locked: false,
  hidden: false,
  clips,
  ...extra,
});
const starts = (t: Track | undefined) => t?.clips.map((c) => [c.id, c.start]);

describe("rippleDelete", () => {
  it("closes the hole on the clip's own track only", () => {
    const tracks = [
      track("v", [clip("a", "v", 0, 2), clip("b", "v", 2, 3), clip("c", "v", 5, 2)]),
      track("au", [clip("x", "au", 6, 2)], { kind: "audio" }),
    ];
    const { tracks: out, removed } = rippleDelete(tracks, ["b"]);
    expect(starts(out[0])).toEqual([
      ["a", 0],
      ["c", 2],
    ]);
    expect(starts(out[1])).toEqual([["x", 6]]);
    expect(removed).toEqual({ v: [{ start: 2, end: 5 }] });
  });

  it("merges overlapping ranges (text clips may overlap) and shifts by their union", () => {
    const tracks = [
      track(
        "t",
        [
          clip("a", "t", 0, 4),
          clip("b", "t", 2, 4),
          clip("keep", "t", 3, 1),
          clip("late", "t", 10, 1),
        ],
        { kind: "text" },
      ),
    ];
    const { tracks: out, removed } = rippleDelete(tracks, ["a", "b"]);
    expect(removed.t).toEqual([{ start: 0, end: 6 }]);
    // «keep» sat inside the removed range: it lands at the cut; «late» moves 6 s left.
    expect(starts(out[0])).toEqual([
      ["keep", 0],
      ["late", 4],
    ]);
  });

  it("never touches a locked track", () => {
    const tracks = [
      track("v", [clip("a", "v", 0, 2), clip("b", "v", 2, 2)], { locked: true }),
      track("v2", [clip("c", "v2", 0, 1), clip("d", "v2", 1, 1)]),
    ];
    const { tracks: out, removed } = rippleDelete(tracks, ["a", "c"]);
    expect(out[0]).toBe(tracks[0]);
    expect(starts(out[1])).toEqual([["d", 0]]);
    expect(Object.keys(removed)).toEqual(["v2"]);
  });

  it("sync lock: time cut from the main track is cut from every unlocked track (audit D5)", () => {
    const tracks = [
      track("v", [clip("a", "v", 0, 2), clip("b", "v", 2, 3), clip("c", "v", 5, 2)]),
      track(
        "t",
        [
          clip("before", "t", 0, 1),
          clip("inside", "t", 2.5, 1),
          clip("head", "t", 4, 2), // starts inside 2..5: loses its first second
          clip("after", "t", 6, 1),
        ],
        { kind: "text" },
      ),
      track("m", [clip("music", "m", 0, 10, { in: 1, out: 11 })], { kind: "audio" }),
      track("l", [clip("lock", "l", 6, 1)], { kind: "audio", locked: true }),
    ];
    const { tracks: out, removed } = rippleDelete(tracks, ["b"], { syncTrackId: "v" });
    expect(removed).toEqual({ v: [{ start: 2, end: 5 }] });
    expect(starts(out[0])).toEqual([
      ["a", 0],
      ["c", 2],
    ]);
    const t = out[1]!;
    expect(starts(t)).toEqual([
      ["before", 0],
      ["head", 2],
      ["after", 3],
    ]);
    expect(t.clips.find((c) => c.id === "head")).toMatchObject({ in: 1, out: 2 });
    // A clip spanning the cut keeps its start and loses the cut time at its tail.
    expect(out[2]!.clips[0]).toMatchObject({ start: 0, in: 1, out: 8 });
    expect(clipEnd(out[2]!.clips[0]!)).toBe(7);
    expect(out[3]).toBe(tracks[3]); // locked: untouched
  });

  it("sync lock composes with clips deleted on another track too", () => {
    const tracks = [
      track("v", [clip("a", "v", 0, 2), clip("b", "v", 2, 2), clip("c", "v", 4, 2)]),
      track("t", [clip("x", "t", 0, 1), clip("y", "t", 5, 1)], { kind: "text" }),
    ];
    // Delete b (2..4) on the main track and x (0..1) on the text track.
    const { tracks: out } = rippleDelete(tracks, ["b", "x"], { syncTrackId: "v" });
    expect(starts(out[1])).toEqual([["y", 2]]); // 5 − 1 (own) − 2 (main)
  });

  it("rippleTime maps times across several removed ranges", () => {
    const removed = mergeRanges([
      { start: 5, end: 6 },
      { start: 1, end: 2 },
      { start: 1.5, end: 3 },
    ]);
    expect(removed).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(rippleTime(0.5, removed)).toBe(0.5);
    expect(rippleTime(2, removed)).toBe(1);
    expect(rippleTime(4, removed)).toBe(2);
    expect(rippleTime(7, removed)).toBe(4);
  });
});

describe("closeGaps", () => {
  it("packs every clip leftwards, from 0", () => {
    const t = track("v", [clip("a", "v", 1, 2), clip("b", "v", 5, 1), clip("c", "v", 8, 1)]);
    expect(trackGaps(t)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
    const { track: out, removed } = closeGaps(t);
    expect(removed).toHaveLength(3);
    expect(starts(out)).toEqual([
      ["a", 0],
      ["b", 2],
      ["c", 3],
    ]);
    expect(closeGaps(out).removed).toEqual([]);
    expect(closeGaps({ ...t, locked: true }).track.clips[0]!.start).toBe(1);
  });
});

describe("trimToCursor (Q/W)", () => {
  const tracks = [track("v", [clip("a", "v", 0, 4), clip("b", "v", 4, 4), clip("c", "v", 8, 2)])];

  it("Q trims the start to the cursor and pulls the rest left", () => {
    const res = trimToCursor(tracks, "b", 5.5, "start")!;
    const [a, b, c] = res.tracks[0]!.clips;
    expect(res.removed).toEqual({ start: 4, end: 5.5 });
    expect(b).toMatchObject({ id: "b", start: 4, in: 1.5, out: 4 });
    expect(clipEnd(b!)).toBe(6.5);
    expect(c).toMatchObject({ id: "c", start: 6.5 });
    expect(a!.start).toBe(0);
  });

  it("W trims the end to the cursor and pulls the rest left", () => {
    const res = trimToCursor(tracks, "b", 5, "end")!;
    const [, b, c] = res.tracks[0]!.clips;
    expect(res.removed).toEqual({ start: 5, end: 8 });
    expect(b).toMatchObject({ start: 4, in: 0, out: 1 });
    expect(c!.start).toBe(5);
  });

  it("does nothing outside the clip or on a locked track", () => {
    expect(trimToCursor(tracks, "b", 9, "start")).toBeUndefined();
    expect(trimToCursor(tracks, "b", 4, "end")).toBeUndefined();
    const locked = [{ ...tracks[0]!, locked: true }];
    expect(trimToCursor(locked, "b", 5, "end")).toBeUndefined();
  });
});

describe("clipsInRect", () => {
  it("selects the clips the rectangle touches, skipping locked rows", () => {
    const rows = [
      track("v", [clip("a", "v", 0, 2), clip("b", "v", 3, 2)]),
      track("au", [clip("x", "au", 1, 2)], { kind: "audio" }),
      track("t", [clip("y", "t", 1, 2)], { kind: "text", locked: true }),
    ];
    // zoom 10 px/s, rows 56 px: x 15..35 px = 1.5..3.5 s, rows 0..2
    const ids = clipsInRect(rows, { left: 35, right: 15, top: 10, bottom: 150 }, 10);
    expect(ids.sort()).toEqual(["a", "b", "x"]);
    expect(clipsInRect(rows, { left: 15, right: 35, top: 60, bottom: 70 }, 10)).toEqual(["x"]);
  });
});
