import {
  KEYFRAME_PARITY_CASES,
  interpolate as sharedInterpolate,
  type Clip,
  type Job,
  type MediaAsset,
  type Project,
  type TrackFile,
} from "@studio/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "@/components/panels/PreviewPanel";
import {
  canvasToSource,
  composeAt,
  driverSource,
  opacityAt,
  reframeCropAt,
  sourceToCanvas,
} from "@/lib/compositor";
import { interpolate } from "@/lib/interpolate";
import { addKeyframe, copyKeyframes, pasteKeyframes, staticValue } from "@/lib/keyframes";
import { MasterClock } from "@/lib/master-clock";
import { HARD_SYNC_S, syncRate } from "@/lib/media-pool";
import { primeTrack } from "@/lib/vision-api";
import { useJobsStore } from "@/stores/jobs-store";
import { keyOrPause, useKeyframeStore } from "@/stores/keyframe-store";
import { frameAt, useMaskStore } from "@/stores/mask-store";
import { useMediaStore } from "@/stores/media-store";
import { shouldDropToProxy, usePreviewStore } from "@/stores/preview-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

/** Sprint 2 (web): multilayer compositor, keyframes, mask tool, reframe. The api is mocked. */

type Handler = (
  path: string,
  method: string,
  body: unknown,
) => { status?: number; json?: unknown } | undefined;

function mockFetch(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const res = handler(url.pathname, method, body);
    if (!res)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return new Response(res.json === undefined ? null : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const now = new Date().toISOString();
const asset = (p: Partial<MediaAsset> & Pick<MediaAsset, "id" | "kind">): MediaAsset => ({
  name: p.id,
  path: `media/${p.id}`,
  sizeBytes: 1,
  createdAt: now,
  ...p,
});

const clip = (p: Partial<Clip> & Pick<Clip, "id" | "trackId" | "start" | "out">): Clip => ({
  in: 0,
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
  ...p,
});

const ASSETS: Record<string, MediaAsset> = {
  bg: asset({
    id: "bg",
    kind: "video",
    width: 1920,
    height: 1080,
    durationSec: 20,
    hasAudio: true,
  }),
  pip: asset({ id: "pip", kind: "video", width: 1920, height: 1080, durationSec: 20 }),
  logo: asset({ id: "logo", kind: "image", width: 200, height: 200 }),
  ren: asset({ id: "ren", kind: "video", width: 1920, height: 1080, hasAlpha: true }),
  music: asset({ id: "music", kind: "audio", durationSec: 60, hasAudio: true }),
  alpha: asset({ id: "alpha", kind: "video", width: 1920, height: 1080, hasAlpha: true }),
  trk: asset({ id: "trk", kind: "track" as MediaAsset["kind"], path: "tracks/trk.json" }),
};

/** video(bg) · audio(music) · text · motion(ren) + a second video track with a PiP + image. */
function layered(): Project {
  const p = createEmptyProject("Sprint 2");
  const [video, audio, text, motion] = p.tracks;
  video!.clips = [clip({ id: "v1", trackId: video!.id, start: 0, out: 10, assetId: "bg" })];
  audio!.clips = [
    clip({ id: "a1", trackId: audio!.id, start: 0, out: 10, assetId: "music", volume: 0.5 }),
  ];
  text!.clips = [clip({ id: "t1", trackId: text!.id, start: 1, out: 5, text: "Hola" })];
  motion!.clips = [
    clip({ id: "m1", trackId: motion!.id, start: 0, out: 10, renderedAssetId: "ren" }),
  ];
  p.tracks.push({
    id: "trk_pip",
    kind: "video",
    name: "Video 2",
    muted: false,
    locked: false,
    hidden: false,
    clips: [
      clip({
        id: "p1",
        trackId: "trk_pip",
        start: 0,
        out: 10,
        assetId: "pip",
        scale: 0.25,
        position: { x: 1, y: 0 },
      }),
      clip({ id: "p2", trackId: "trk_pip", start: 2, out: 4, assetId: "logo" }),
    ],
  });
  return p;
}

beforeEach(() => {
  useMediaStore.setState({ assets: { ...ASSETS }, order: Object.keys(ASSETS), status: "ready" });
  useProjectStore.getState().loadProject(layered());
  useKeyframeStore.setState({ selected: undefined, clipboard: undefined, activeProp: "position" });
  usePreviewStore.setState({
    classic: false,
    tool: "none",
    reframeDraft: undefined,
    reframeOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compositor: layer ordering", () => {
  it("stacks tracks like the export (index 0 at the bottom, later starts on top)", () => {
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 3,
    });
    expect(comp.layers.map((l) => l.clipId)).toEqual(["v1", "t1", "m1", "p1", "p2"]);
    expect(comp.layers.map((l) => l.kind)).toEqual(["video", "text", "motion", "video", "image"]);
    // z grows strictly; audio clips are not layers but audio sources with their volume
    const z = comp.layers.map((l) => l.z);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
    expect(comp.audio).toHaveLength(1);
    expect(comp.audio[0]).toMatchObject({ clipId: "a1", volume: 0.5, audible: true });
    // the bottom-most video drives the master clock
    expect(driverSource(comp)?.clipId).toBe("v1");
  });

  it("skips hidden tracks, muted audio and clips outside their window", () => {
    const p = useProjectStore.getState();
    const pip = p.project.tracks.find((t) => t.id === "trk_pip")!;
    p.updateTrack(pip.id, { hidden: true });
    const audio = p.project.tracks.find((t) => t.kind === "audio")!;
    p.updateTrack(audio.id, { muted: true });
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 6,
    });
    expect(comp.layers.map((l) => l.clipId)).toEqual(["v1", "m1"]);
    expect(comp.audio).toHaveLength(0);
  });

  it("places a PiP with the shared fit (25 % top-right) and maps clicks to the source", () => {
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 1,
    });
    const pip = comp.layers.find((l) => l.clipId === "p1")!;
    expect(pip.rect).toEqual({ x: 1440, y: 0, width: 480, height: 270 });
    expect(canvasToSource(pip, { x: 1680, y: 135 })).toEqual({ x: 0.5, y: 0.5 });
    expect(canvasToSource(pip, { x: 10, y: 10 })).toBeUndefined();
    expect(sourceToCanvas(pip, { x: 0, y: 0, w: 1, h: 1 })).toEqual(pip.rect);
  });

  it("draws a matte as background + alpha video", () => {
    useProjectStore.getState().updateClip("v1", {
      matte: { assetId: "alpha", background: { type: "image", value: "logo" } },
    });
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 1,
    });
    const v = comp.layers[0]!;
    expect(v.matte?.alpha).toMatchObject({ key: "v1:alpha", assetId: "alpha", keepOriginal: true });
    expect(v.matte?.backgroundSource).toMatchObject({ key: "v1:bg", element: "image" });
  });
});

describe("keyframe interpolation (parity with the export)", () => {
  it("re-exports the shared interpolate() and matches the parity fixture", () => {
    expect(interpolate).toBe(sharedInterpolate);
    for (const c of KEYFRAME_PARITY_CASES) {
      const v = interpolate(
        [
          { t: 0, v: 0, ease: c.ease },
          { t: 2, v: 100, ease: "linear" },
        ],
        c.t,
      );
      expect(v).toBeCloseTo(c.expected, 6);
    }
  });

  it("the preview layers use the same curve (opacity, position = center, crop)", () => {
    for (const c of KEYFRAME_PARITY_CASES) {
      const k: Clip = clip({
        id: "k",
        trackId: "x",
        start: 10,
        out: 5,
        keyframes: {
          opacity: [
            { t: 0, v: 0, ease: c.ease },
            { t: 2, v: 1, ease: "linear" },
          ],
        },
      });
      expect(opacityAt(k, 10 + c.t)).toBeCloseTo(c.expected / 100, 6);
    }
    useProjectStore.getState().updateClip("p1", {
      keyframes: {
        position: [
          { t: 0, v: { x: 0.25, y: 0.25 }, ease: "linear" },
          { t: 2, v: { x: 0.75, y: 0.75 }, ease: "linear" },
        ],
      },
    });
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 1,
    });
    const r = comp.layers.find((l) => l.clipId === "p1")!.rect;
    expect(r.x + r.width / 2).toBeCloseTo(960, 6);
    expect(r.y + r.height / 2).toBeCloseTo(540, 6);
  });

  it("follows a trackRef through the video rect (shared trackToCanvas)", () => {
    const file: TrackFile = {
      version: 1,
      fps: 10,
      smoothed: true,
      source: { assetId: "bg", method: "csrt" },
      // 10 fps from 0 to 4 s, moving linearly from (0.1, 0.1) to (0.5, 0.5)
      frames: Array.from({ length: 41 }, (_, i) => ({
        t: i / 10,
        x: 0.1 + (0.4 * i) / 40,
        y: 0.1 + (0.4 * i) / 40,
        w: 0.2,
        h: 0.2,
        conf: 1,
      })),
    };
    primeTrack("trk", file);
    useProjectStore
      .getState()
      .updateClip("t1", { trackRef: { assetId: "trk", anchor: "center", offset: { x: 0, y: 0 } } });
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 2,
      trackFile: (id) => (id === "trk" ? file : undefined),
    });
    const t = comp.layers.find((l) => l.clipId === "t1")!;
    expect(t.tracked).toBe(true);
    // t=2 → box (0.3,0.3,0.2,0.2) → center (0.4, 0.4) of the full-frame video
    expect(t.text!.center!.x).toBeCloseTo(0.4 * 1920, 3);
    expect(t.text!.center!.y).toBeCloseTo(0.4 * 1080, 3);
  });

  it("static values are expressed in keyframe units (center, fractions)", () => {
    const p1 = useProjectStore.getState().project.tracks[4]!.clips[0]!;
    expect(
      staticValue(p1, "position", "video", {
        canvas: { width: 1920, height: 1080 },
        asset: ASSETS.pip,
      }),
    ).toEqual({
      x: 0.875,
      y: 0.125,
    });
    expect(staticValue(p1, "crop", "video")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("keyframe store: add / move / delete / undo", () => {
  it("K adds a keyframe at the playhead only when stopped with a clip selected", () => {
    const p = useProjectStore.getState();
    p.selectClip("v1");
    p.setPlayhead(2);
    p.setPlaying(true);
    expect(keyOrPause()).toBe(false); // playing: K pauses
    expect(useProjectStore.getState().playing).toBe(false);
    useKeyframeStore.getState().setActiveProp("opacity");
    expect(keyOrPause()).toBe(true);
    const v1 = () => useProjectStore.getState().project.tracks[0]!.clips[0]!;
    expect(v1().keyframes?.opacity).toEqual([{ t: 2, v: 1, ease: "linear" }]);
    expect(useKeyframeStore.getState().selected).toEqual({
      clipId: "v1",
      prop: "opacity",
      index: 0,
    });
    useProjectStore.getState().undo();
    expect(v1().keyframes).toBeUndefined();
    useProjectStore.getState().redo();
    expect(v1().keyframes?.opacity).toHaveLength(1);
  });

  it("drags (one undo step), edits ease/value, deletes, copies and pastes", () => {
    const kf = useKeyframeStore.getState();
    const p = useProjectStore.getState();
    p.setPlayhead(1);
    kf.addAtPlayhead("scale", "p1");
    p.setPlayhead(3);
    kf.addAtPlayhead("scale", "p1");
    const p1 = () => useProjectStore.getState().project.tracks[4]!.clips[0]!;
    expect(p1().keyframes?.scale?.map((k) => k.t)).toEqual([1, 3]);
    const before = useProjectStore.getState().past.length;
    kf.beginDrag();
    kf.move("p1", "scale", 0, 1.5, false);
    kf.move("p1", "scale", 0, 4, false); // crosses the other one: index follows it
    expect(useKeyframeStore.getState().selected?.index).toBe(1);
    expect(p1().keyframes?.scale?.map((k) => k.t)).toEqual([3, 4]);
    expect(useProjectStore.getState().past.length).toBe(before + 1);
    useProjectStore.getState().undo();
    expect(p1().keyframes?.scale?.map((k) => k.t)).toEqual([1, 3]);

    kf.setEase("p1", "scale", 0, "easeInOut");
    kf.setValue("p1", "scale", 1, 0.5);
    expect(p1().keyframes?.scale).toEqual([
      { t: 1, v: 0.25, ease: "easeInOut" },
      { t: 3, v: 0.5, ease: "linear" },
    ]);
    expect(kf.copy("p1")).toBe(true);
    useProjectStore.getState().setPlayhead(5);
    expect(kf.paste("p1")).toBe(true);
    expect(p1().keyframes?.scale?.map((k) => k.t)).toEqual([1, 3, 5, 7]);
    kf.remove("p1", "scale", 0);
    expect(p1().keyframes?.scale).toHaveLength(3);
    kf.clearProp("p1", "scale");
    expect(p1().keyframes).toBeUndefined();
  });

  it("pure helpers clamp to the clip and replace a keyframe at the same time", () => {
    const c = clip({ id: "c", trackId: "x", start: 0, out: 4 });
    const a = addKeyframe(c, "opacity", 9, 0.5);
    expect(a.patch.keyframes?.opacity).toEqual([{ t: 4, v: 0.5, ease: "linear" }]);
    const b = addKeyframe({ ...c, ...a.patch } as Clip, "opacity", 4.001, 0.2);
    expect(b.patch.keyframes?.opacity).toEqual([{ t: 4, v: 0.2, ease: "linear" }]);
    const board = copyKeyframes({ ...c, ...b.patch } as Clip)!;
    expect(board.props.opacity?.[0]?.t).toBe(0);
    expect(pasteKeyframes(c, board, 1, ["position"])).toEqual({});
  });
});

const job = (id: string, status: Job["status"], extra: Partial<Job> = {}): Job => ({
  id,
  type: "vision.mask",
  status,
  progress: 0,
  payload: {},
  createdAt: now,
  ...extra,
});

describe("mask tool (SAM 2)", () => {
  it("session → + / − points → mask → propagate → result", async () => {
    const calls: { path: string; body: unknown }[] = [];
    mockFetch((path, method, body) => {
      calls.push({ path, body });
      if (path === "/api/ai/vision/sam/session" && method === "POST")
        return { json: { sessionId: "s1", assetId: "bg", frames: 300, fps: 30 } };
      if (path === "/api/ai/vision/sam/session/s1/points")
        return {
          json: {
            frame: 60,
            objId: 1,
            maskPath: "masks/s1/60.png",
            maskUrl: "/files/masks/s1/60.png",
          },
        };
      if (path === "/api/ai/vision/sam/session/s1/propagate")
        return { status: 202, json: { jobId: "j1" } };
      if (path === "/api/jobs/j1")
        return {
          json: job("j1", "succeeded", {
            result: { sessionId: "s1", trackAssetId: "trk", alphaAssetId: "alpha" },
          }),
        };
      if (path === "/api/media") return { json: Object.values(ASSETS) };
      if (path === "/api/ai/vision/sam/session/s1" && method === "DELETE")
        return { json: { deleted: true } };
      return undefined;
    });
    const m = useMaskStore.getState();
    expect(await m.start("v1", "bg")).toBe(true);
    expect(useMaskStore.getState()).toMatchObject({ status: "ready", sessionId: "s1", fps: 30 });
    expect(frameAt(2, 30, 300)).toBe(60);

    await useMaskStore.getState().addPoint(60, 0.5, 0.4);
    useMaskStore.getState().setLabel(0);
    await useMaskStore.getState().addPoint(60, 0.9, 0.9);
    const s = useMaskStore.getState();
    expect(s.points.map((p) => p.label)).toEqual([1, 0]);
    expect(s.maskUrl).toMatch(/\/files\/masks\/s1\/60\.png$/);
    expect(calls.filter((c) => c.path.endsWith("/points")).at(-1)?.body).toEqual({
      frame: 60,
      points: [
        { x: 0.5, y: 0.4, label: 1 },
        { x: 0.9, y: 0.9, label: 0 },
      ],
      objId: 1,
    });
    // another frame starts a new prompt
    await useMaskStore.getState().addPoint(90, 0.1, 0.1, 1);
    expect(useMaskStore.getState().points).toHaveLength(1);
    await useMaskStore.getState().undoPoint();
    expect(useMaskStore.getState().points).toHaveLength(0);
    await useMaskStore.getState().addPoint(60, 0.5, 0.4, 1);

    let result: unknown;
    await act(async () => {
      const pending = useMaskStore.getState().propagate();
      await vi.waitFor(() => expect(useMaskStore.getState().jobId).toBe("j1"));
      expect(useMaskStore.getState().status).toBe("propagating");
      useJobsStore.getState().upsertJob(job("j1", "succeeded"));
      result = await pending;
    });
    expect(result).toMatchObject({ trackAssetId: "trk", alphaAssetId: "alpha" });
    expect(useMaskStore.getState().status).toBe("done");

    await useMaskStore.getState().close();
    expect(useMaskStore.getState().status).toBe("idle");
    expect(calls.some((c) => c.path === "/api/ai/vision/sam/session/s1")).toBe(true);
  });

  it("errors leave the tool usable", async () => {
    mockFetch((path) => {
      if (path === "/api/ai/vision/sam/session")
        return { json: { sessionId: "s2", assetId: "bg", frames: 10, fps: 25 } };
      if (path.endsWith("/points"))
        return { status: 500, json: { error: { code: "WORKERS_ERROR", message: "SAM falló" } } };
      return undefined;
    });
    await useMaskStore.getState().start("v1", "bg");
    await useMaskStore.getState().addPoint(0, 0.5, 0.5);
    expect(useMaskStore.getState()).toMatchObject({ status: "ready", error: "SAM falló" });
    await useMaskStore.getState().close();
  });
});

describe("reframe", () => {
  it("draft crop path → Aplicar writes project.reframe (undoable)", () => {
    const project = useProjectStore.getState().project;
    const keyframes = [
      { t: 0, v: { x: 0, y: 0, w: 0.3, h: 1 }, ease: "linear" as const },
      { t: 4, v: { x: 0.7, y: 0, w: 0.3, h: 1 }, ease: "linear" as const },
    ];
    usePreviewStore.getState().setReframeDraft({ target: "9:16", keyframes });
    // 9:16 inside 1920×1080: w = 0.3164 of the canvas, center follows the keyframes, clamped
    const c0 = reframeCropAt(project, 0, { target: "9:16", keyframes })!;
    expect(c0.w).toBeCloseTo((9 / 16) * (1080 / 1920), 6);
    expect(c0.h).toBe(1);
    expect(c0.x).toBe(0);
    const c2 = reframeCropAt(project, 2, { target: "9:16", keyframes })!;
    expect(c2.x + c2.w / 2).toBeCloseTo(0.5, 6);
    expect(useVisionStore.getState().applyReframe()).toBe(true);
    expect(useProjectStore.getState().project.reframe).toEqual({
      target: "9:16",
      keyframes,
      mode: "auto",
    });
    expect(usePreviewStore.getState().reframeDraft).toBeUndefined();
    useKeyframeStore.getState().updateReframe(1, { ease: "hold" });
    expect(useProjectStore.getState().project.reframe?.mode).toBe("manual");
    useProjectStore.getState().undo();
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.reframe).toBeUndefined();
  });

  it("the panel opens from the preview toolbar", () => {
    render(<PreviewPanel />);
    expect(screen.getByTestId("preview-stage").dataset.renderer).toBe("compositor");
    expect(screen.getByTestId("preview-canvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reencuadrar" }));
    expect(screen.getByRole("region", { name: "Reencuadrar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Analizar para 9:16/ })).toBeTruthy();
  });
});

describe("master clock + sync", () => {
  it("follows the driver, holds while it is a bit behind and folds stalls", () => {
    let ms = 0;
    const clock = new MasterClock(() => ms);
    clock.play(5);
    ms = 100;
    expect(clock.now()).toBeCloseTo(5.1, 6);
    const el = {
      paused: false,
      seeking: false,
      currentTime: 2.2,
      readyState: 4,
    } as HTMLVideoElement;
    clock.setDriver({ el, clipStart: 3, clipIn: 0, speed: 1 });
    expect(clock.now()).toBeCloseTo(5.2, 6); // 3 + 2.2
    expect(clock.source).toBe("driver");
    (el as { currentTime: number }).currentTime = 2.1; // 0.1 s behind: hold
    expect(clock.now()).toBeCloseTo(5.2, 6);
    (el as { paused: boolean }).paused = true; // driver gone: monotonic from there
    ms = 200;
    expect(clock.now()).toBeCloseTo(5.2 + 0.1, 6);
    ms = 2200; // 2 s main-thread stall is not reported as played time
    expect(clock.now()).toBeLessThan(5.4);
  });

  it("nudges the rate for small drift and seeks for large drift", () => {
    expect(syncRate(0.03, 1)).toBe(1);
    expect(syncRate(0.1, 1)).toBeLessThan(1);
    expect(syncRate(-0.1, 1)).toBeGreaterThan(1);
    expect(syncRate(HARD_SYNC_S + 0.1, 1)).toBeUndefined();
  });

  it("drops to proxies after two slow 1 s windows", () => {
    expect(shouldDropToProxy([30, 20], 30)).toBe(false);
    expect(shouldDropToProxy([20, 18], 30)).toBe(true);
    expect(shouldDropToProxy([23, 22], 24)).toBe(false); // a 24 fps source plays at ~23
  });

  it("«Vista previa clásica» swaps the renderer", () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Opciones de la vista previa" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Vista previa clásica/ }));
    expect(screen.getByTestId("preview-stage").dataset.renderer).toBe("classic");
    usePreviewStore.getState().set({ classic: false });
  });
});
