import { tracksInZOrder, type MediaAsset } from "@studio/shared";
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

describe("new tracks go on top of an explicit z-order (audit sprint 3b)", () => {
  it("orders 0..3, delete the first two, add a track → it is the top one", () => {
    const s = useProjectStore.getState();
    const p = s.project;
    s.loadProject({ ...p, tracks: p.tracks.map((t, i) => ({ ...t, order: i })) });
    const [a, b] = useProjectStore.getState().project.tracks;
    useProjectStore.getState().removeTrack(a!.id);
    useProjectStore.getState().removeTrack(b!.id);
    const id = useProjectStore.getState().addTrack("video");
    const tracks = useProjectStore.getState().project.tracks;
    expect(tracks.find((t) => t.id === id)!.order).toBe(4);
    expect(tracksInZOrder(tracks).at(-1)!.id).toBe(id);
  });

  it("projects without order keep new tracks without order", () => {
    const id = useProjectStore.getState().addTrack("audio");
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === id)!.order).toBe(
      undefined,
    );
  });
});

describe("no overlapping clips on video/audio/motion tracks (feedback 5)", () => {
  const motionClip = (id: string, start: number, dur: number) => ({
    id,
    start,
    in: 0,
    out: dur,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    motion: {
      schemaVersion: 1 as const,
      template: "title-card",
      props: {},
      durationSec: dur,
      fps: 30,
      width: 1920,
      height: 1080,
      format: "webm-vp9-alpha" as const,
      includeAudio: false,
    },
  });
  const motionTracks = () =>
    useProjectStore.getState().project.tracks.filter((t) => t.kind === "motion");

  it("puts a motion clip added over an occupied range on «Motion 2»", () => {
    const s = useProjectStore.getState();
    s.addClip("motion", motionClip("m1", 0, 10));
    useProjectStore.getState().addClip("motion", motionClip("m2", 0, 10));
    useProjectStore.getState().addClip("motion", motionClip("m3", 12, 2));
    const tracks = motionTracks();
    expect(tracks.map((t) => t.name)).toEqual(["Motion 1", "Motion 2"]);
    expect(tracks[0]!.clips.map((c) => c.id)).toEqual(["m1", "m3"]);
    expect(tracks[1]!.clips.map((c) => c.id)).toEqual(["m2"]);
    // a third one at 2 s overlaps both tracks -> Motion 3
    useProjectStore.getState().addClip("motion", motionClip("m4", 2, 3));
    expect(motionTracks().map((t) => t.name)).toEqual(["Motion 1", "Motion 2", "Motion 3"]);
  });

  it("drops onto an occupied video range land on a new video track", () => {
    const s = useProjectStore.getState();
    const video = s.project.tracks.find((t) => t.kind === "video")!;
    s.addAssetClip(asset, { start: 0, trackId: video.id });
    const b = useProjectStore.getState().addAssetClip(asset, { start: 3, trackId: video.id });
    expect(b.trackId).not.toBe(video.id);
    expect(
      useProjectStore.getState().project.tracks.filter((t) => t.kind === "video"),
    ).toHaveLength(2);
  });

  it("moving onto a neighbour snaps to its edge; trimming stops at it", () => {
    const s = useProjectStore.getState();
    const video = s.project.tracks.find((t) => t.kind === "video")!;
    const a = s.addAssetClip(asset, { start: 0, trackId: video.id }); // 0–8
    const b = useProjectStore.getState().addAssetClip(asset, { start: 10, trackId: video.id }); // 10–18
    useProjectStore.getState().moveClip(b.id, 6);
    const moved = clips().find((c) => c.id === b.id)!;
    expect(moved.start).toBe(8); // end of the previous clip
    useProjectStore.getState().moveClip(b.id, 1);
    expect(clips().find((c) => c.id === b.id)!.start).toBe(8);
    useProjectStore.getState().trimClip(b.id, "start", 2);
    expect(clips().find((c) => c.id === b.id)!.start).toBe(8);
    useProjectStore.getState().moveClip(b.id, 20);
    useProjectStore.getState().trimClip(a.id, "end", 30, 100);
    expect(clipEnd(clips().find((c) => c.id === a.id)!)).toBe(20);
  });

  it("render assets (renders/*.webm) go to the Motion track, not over the video", () => {
    const render: MediaAsset = { ...asset, id: "r1", path: "renders/job.webm", hasAlpha: true };
    const c = useProjectStore.getState().addAssetClip(render, { start: 0 });
    const track = useProjectStore.getState().project.tracks.find((t) => t.id === c.trackId)!;
    expect(track.kind).toBe("motion");
  });
});
