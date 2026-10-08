import type { Clip, MediaAsset } from "@studio/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clipsInRect } from "@/lib/timeline";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 5 (M2, H10): multi-selection, batch delete/move, ripple and Q/W in the store. */
const st = () => useProjectStore.getState();
const video = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  kind: "video",
  name: `${id}.mp4`,
  path: `media/${id}.mp4`,
  sizeBytes: 1,
  durationSec: 2,
  createdAt: new Date().toISOString(),
  ...extra,
});
const videoClips = (): Clip[] => st().project.tracks.find((t) => t.kind === "video")!.clips;

/** Three 2 s clips back to back on the video track: a [0,2) b [2,4) c [4,6). */
function threeClips(): [string, string, string] {
  const ids = ["a", "b", "c"].map((n, i) => st().addAssetClip(video(n), { start: i * 2 }).id);
  return ids as [string, string, string];
}

beforeEach(() => {
  st().loadProject(createEmptyProject("Selección"));
});

describe("selection modes", () => {
  it("replace / toggle / range keep the last clicked clip as primary", () => {
    const [a, b, c] = threeClips();
    st().selectClip(a);
    expect(st().selectedClipIds).toEqual([a]);
    st().selectClip(c, "range");
    expect(st().selectedClipIds).toEqual([a, b, c]);
    expect(st().selectedClipId).toBe(c);
    st().selectClip(b, "toggle");
    expect(st().selectedClipIds).toEqual([a, c]);
    st().selectClip(b, "toggle");
    expect(st().selectedClipId).toBe(b);
    st().selectClip(a);
    expect(st().selectedClipIds).toEqual([a]);
    st().selectClip(undefined);
    expect(st().selectedClipIds).toEqual([]);
    expect(st().selectedClipId).toBeUndefined();
  });

  it("rectangle and select all (locked tracks excluded)", () => {
    const [a, b] = threeClips();
    const rows = st().project.tracks;
    const zoom = st().zoom;
    st().selectClips(clipsInRect(rows, { left: 0, right: 3 * zoom, top: 1, bottom: 2 }, zoom));
    expect(st().selectedClipIds).toEqual([a, b]);
    const audio = st().project.tracks.find((t) => t.kind === "audio")!;
    st().addClip("audio", { ...videoClips()[0]!, id: "aud", trackId: audio.id });
    st().updateTrack(audio.id, { locked: true });
    st().selectAll();
    expect(st().selectedClipIds).toHaveLength(3);
    expect(st().selectedClipIds).not.toContain("aud");
  });
});

describe("batch edits are one undo step", () => {
  it("deletes several clips (with a hole) and undoes them at once", () => {
    const [a, , c] = threeClips();
    st().selectClip(a);
    st().selectClip(c, "toggle");
    const before = st().past.length;
    expect(st().deleteSelected()).toBe(2);
    expect(st().past.length).toBe(before + 1);
    expect(videoClips().map((x) => [x.start])).toEqual([[2]]);
    expect(st().selectedClipIds).toEqual([]);
    st().undo();
    expect(videoClips()).toHaveLength(3);
  });

  it("Shift+Supr closes the hole and moves the subtitles of the main video track", () => {
    const [, b] = threeClips();
    st().setSubtitles([
      { start: 0.5, end: 1.5, text: "uno" },
      { start: 2.5, end: 3.5, text: "dos" },
      { start: 4.5, end: 5.5, text: "tres" },
    ]);
    st().selectClip(b);
    const before = st().past.length;
    expect(st().deleteSelected({ ripple: true })).toBe(1);
    expect(st().past.length).toBe(before + 1);
    expect(videoClips().map((x) => x.start)).toEqual([0, 2]);
    expect(st().project.subtitles.map((s) => [s.text, s.start])).toEqual([
      ["uno", 0.5],
      ["tres", 2.5],
    ]);
    st().undo();
    expect(videoClips().map((x) => x.start)).toEqual([0, 2, 4]);
    expect(st().project.subtitles).toHaveLength(3);
  });

  it("moves the selection together; refuses overlaps; one undo step", () => {
    const [a, b, c] = threeClips();
    st().selectClip(b);
    st().selectClip(c, "toggle");
    const before = st().past.length;
    expect(st().moveSelected(1)).toBe(true);
    expect(videoClips().map((x) => [x.id, x.start])).toEqual([
      [a, 0],
      [b, 3],
      [c, 5],
    ]);
    expect(st().past.length).toBe(before + 1);
    expect(st().moveSelected(-2)).toBe(false); // b would cover a
    st().undo();
    expect(videoClips().map((x) => x.start)).toEqual([0, 2, 4]);
  });

  it("Q/W trim the clip under the cursor with ripple (one undo step)", () => {
    threeClips();
    st().setPlayhead(2.5);
    expect(st().trimToCursor("start")).toBe(true);
    expect(videoClips().map((x) => [x.start, x.in])).toEqual([
      [0, 0],
      [2, 0.5],
      [3.5, 0],
    ]);
    expect(st().playhead).toBe(2);
    st().setPlayhead(1);
    expect(st().trimToCursor("end")).toBe(true);
    expect(videoClips().map((x) => x.start)).toEqual([0, 1, 2.5]);
    st().undo();
    st().undo();
    expect(videoClips().map((x) => x.start)).toEqual([0, 2, 4]);
  });

  it("closes the gaps of the selected clip's track", () => {
    const [, b] = threeClips();
    st().selectClip(undefined);
    expect(st().deleteSelected()).toBe(0); // nothing selected: no-op
    st().selectClip(b);
    st().deleteSelected();
    st().selectClip(videoClips()[0]!.id);
    expect(st().closeGaps()).toBe(2);
    expect(videoClips().map((x) => x.start)).toEqual([0, 2]);
  });

  it("I/O marks keep in < out and clear", () => {
    threeClips();
    st().markIn(1);
    expect(st().inOut).toEqual({ in: 1, out: 6 });
    st().markOut(4);
    expect(st().inOut).toEqual({ in: 1, out: 4 });
    st().markOut(0.5);
    expect(st().inOut).toEqual({ in: 0, out: 0.5 });
    st().clearInOut();
    expect(st().inOut).toBeUndefined();
  });
});

describe("first video names the project and fits the canvas (one undo step)", () => {
  it("renames «Proyecto sin título», sizes the canvas and undoes both with the clip", () => {
    st().loadProject(createEmptyProject());
    st().addAssetClip(video("mi_viaje", { width: 1080, height: 1920 }));
    expect(st().project.name).toBe("mi viaje");
    expect(st().project.settings).toMatchObject({ width: 1080, height: 1920 });
    expect(st().firstVideoAdjust).toMatchObject({ name: "mi viaje" });
    st().undo();
    expect(st().project.name).toBe("Proyecto sin título");
    expect(st().project.settings).toMatchObject({ width: 1920, height: 1080 });
    expect(videoClips()).toHaveLength(0);
    st().redo();
    expect(st().project.name).toBe("mi viaje");
    expect(videoClips()).toHaveLength(1);
  });

  it("keeps a chosen name and a non-default canvas", () => {
    st().loadProject(createEmptyProject("Mi canal"));
    st().updateProjectSettings({ width: 1080, height: 1080 });
    st().addAssetClip(video("x", { width: 1280, height: 720 }));
    expect(st().project.name).toBe("Mi canal");
    expect(st().project.settings.width).toBe(1080);
  });

  it("renaming the project is one undo step", () => {
    st().renameProject("Nuevo");
    expect(st().project.name).toBe("Nuevo");
    st().undo();
    expect(st().project.name).toBe("Selección");
  });
});
