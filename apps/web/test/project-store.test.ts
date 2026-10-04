import type { MediaAsset } from "@studio/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clipEnd } from "@/lib/timeline";
import {
  createEmptyProject,
  loadLocalProject,
  persistLocalProject,
  useProjectStore,
} from "@/stores/project-store";

const asset: MediaAsset = {
  id: "asset1",
  kind: "video",
  name: "toma.mp4",
  path: "media/asset1.mp4",
  sizeBytes: 1000,
  durationSec: 8,
  createdAt: new Date().toISOString(),
};

const audio: MediaAsset = {
  ...asset,
  id: "asset2",
  kind: "audio",
  name: "voz.wav",
  durationSec: 4,
};

function clips() {
  return useProjectStore.getState().project.tracks.flatMap((t) => t.clips);
}

beforeEach(() => {
  useProjectStore.getState().loadProject(createEmptyProject("Test"));
});

describe("project store", () => {
  it("starts with one track per kind", () => {
    expect(useProjectStore.getState().project.tracks.map((t) => t.kind)).toEqual([
      "video",
      "audio",
      "text",
      "motion",
    ]);
  });

  it("adds an asset clip on the matching track at the playhead, after existing clips", () => {
    const s = useProjectStore.getState();
    s.setPlayhead(2);
    const a = s.addAssetClip(asset);
    const b = useProjectStore.getState().addAssetClip(asset);
    const c = useProjectStore.getState().addAssetClip(audio);
    const tracks = useProjectStore.getState().project.tracks;
    expect(tracks.find((t) => t.kind === "video")!.clips.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(b.start).toBe(clipEnd(a));
    expect(tracks.find((t) => t.kind === "audio")!.clips[0]!.id).toBe(c.id);
    expect(a).toMatchObject({ start: 2, in: 0, out: 8, assetId: "asset1" });
  });

  it("splits at the playhead and undoes/redoes", () => {
    const s = useProjectStore.getState();
    const a = s.addAssetClip(asset, { start: 0 });
    useProjectStore.getState().selectClip(undefined);
    useProjectStore.getState().setPlayhead(3);
    expect(useProjectStore.getState().splitAt()).toBe(true);
    expect(clips()).toHaveLength(2);
    expect(clips().map((c) => [c.start, c.in, c.out])).toEqual([
      [0, 0, 3],
      [3, 3, 8],
    ]);

    useProjectStore.getState().undo();
    expect(clips()).toHaveLength(1);
    expect(clips()[0]!.id).toBe(a.id);
    useProjectStore.getState().redo();
    expect(clips()).toHaveLength(2);
  });

  it("moves and trims with a single undo step per gesture", () => {
    const a = useProjectStore.getState().addAssetClip(asset, { start: 0 });
    const s = useProjectStore.getState();
    const before = s.past.length;
    s.checkpoint();
    s.moveClip(a.id, 1, undefined, false);
    s.moveClip(a.id, 2, undefined, false);
    s.moveClip(a.id, 3, undefined, false);
    expect(useProjectStore.getState().past.length).toBe(before + 1);
    expect(clips()[0]!.start).toBe(3);
    useProjectStore.getState().undo();
    expect(clips()[0]!.start).toBe(0);

    useProjectStore.getState().trimClip(a.id, "end", 20, asset.durationSec);
    expect(clips()[0]!.out).toBe(8);
    useProjectStore.getState().trimClip(a.id, "start", 2);
    expect(clips()[0]).toMatchObject({ start: 2, in: 2 });
  });

  it("deletes the selected clip and does nothing on locked tracks", () => {
    const a = useProjectStore.getState().addAssetClip(asset, { start: 0 });
    const trackId = a.trackId;
    useProjectStore.getState().updateTrack(trackId, { locked: true });
    useProjectStore.getState().deleteClip(a.id);
    expect(clips()).toHaveLength(1);
    useProjectStore.getState().updateTrack(trackId, { locked: false });
    useProjectStore.getState().selectClip(a.id);
    useProjectStore.getState().deleteClip();
    expect(clips()).toHaveLength(0);
    expect(useProjectStore.getState().selectedClipId).toBeUndefined();
  });

  it("edits subtitles sorted by time", () => {
    const s = useProjectStore.getState();
    s.setSubtitles([
      { start: 5, end: 6, text: "b" },
      { start: 1, end: 2, text: "a" },
    ]);
    expect(useProjectStore.getState().project.subtitles.map((x) => x.text)).toEqual(["a", "b"]);
    useProjectStore.getState().updateSubtitle(0, { text: "A" });
    useProjectStore.getState().removeSubtitle(1);
    expect(useProjectStore.getState().project.subtitles).toEqual([{ start: 1, end: 2, text: "A" }]);
  });

  it("clamps zoom and persists the project to localStorage", () => {
    useProjectStore.getState().setZoom(100_000);
    expect(useProjectStore.getState().zoom).toBe(800);
    useProjectStore.getState().addTextClip({ text: "Hola", start: 1 });
    persistLocalProject(useProjectStore.getState().project);
    const restored = loadLocalProject();
    expect(restored.id).toBe(useProjectStore.getState().project.id);
    expect(restored.tracks.flatMap((t) => t.clips)[0]).toMatchObject({ text: "Hola", start: 1 });
  });

  it("falls back to an empty project when localStorage is corrupted", () => {
    window.localStorage.setItem("studio.project.v1", "{not json");
    expect(loadLocalProject().tracks).toHaveLength(4);
  });
});
