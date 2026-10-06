import {
  blendRgb,
  LAYER_PARITY_BASE,
  LAYER_PARITY_TOLERANCE,
  LAYER_PARITY_TOP,
  type BlendMode,
  type ClipMaskShape,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LayerSection } from "@/components/panels/LayerSection";
import { useMaskEditorStore } from "@/components/preview/mask-editor-store";
import { composeAt, drawComposition, type ScratchCanvas } from "@/lib/compositor";
import {
  dragMaskShape,
  handlePoint,
  lumaToAlpha,
  maskChoiceOf,
  maskForChoice,
  maskImageUrl,
  moveTrackBy,
  moveTrackTo,
  setClipBlendMode,
  setClipMask,
  timelineRows,
} from "@/lib/layers";
import { useMediaStore } from "@/stores/media-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 3b (web): blend modes, masks and track z-order — store ops, editor math, compositor. */

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  kind: "video",
  name: id,
  path: `media/${id}.mp4`,
  sizeBytes: 1,
  width: 1920,
  height: 1080,
  durationSec: 10,
  hasVideo: true,
  hasAudio: false,
  createdAt: new Date(0).toISOString(),
  ...extra,
});
const ASSETS: Record<string, MediaAsset> = {
  a: asset("a"),
  b: asset("b"),
  sam: asset("sam", { kind: "mask", path: "masks/job1", width: 1920, height: 1080 }),
};

function seed(): Project {
  const p = createEmptyProject("capas");
  p.tracks = [
    {
      id: "t1",
      kind: "video",
      name: "Video 1",
      muted: false,
      locked: false,
      hidden: false,
      clips: [{ id: "c1", trackId: "t1", assetId: "a", start: 0, in: 0, out: 5 } as never],
    },
    {
      id: "t2",
      kind: "video",
      name: "Video 2",
      muted: false,
      locked: false,
      hidden: false,
      clips: [{ id: "c2", trackId: "t2", assetId: "b", start: 0, in: 0, out: 5 } as never],
    },
    {
      id: "t3",
      kind: "text",
      name: "Texto 1",
      muted: false,
      locked: false,
      hidden: false,
      clips: [],
    },
  ].map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
      ...(c as object),
    })),
  })) as Project["tracks"];
  return p;
}

beforeEach(() => {
  useProjectStore.getState().loadProject(seed());
  useMediaStore.setState({ assets: ASSETS });
  useMaskEditorStore.setState({ clipId: undefined });
});

const clip = (id: string) =>
  useProjectStore
    .getState()
    .project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;

describe("store ops (undoable)", () => {
  it("reorders tracks: array and Track.order follow the z-order; one undo step", () => {
    moveTrackTo("t1", 2);
    const p = useProjectStore.getState().project;
    expect(p.tracks.map((t) => `${t.id}:${t.order}`)).toEqual(["t2:0", "t3:1", "t1:2"]);
    expect(timelineRows(p).map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
    moveTrackBy("t1", -1);
    expect(useProjectStore.getState().project.tracks.map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
    // no-op moves do not add history
    const past = useProjectStore.getState().past.length;
    moveTrackBy("t2", -1);
    expect(useProjectStore.getState().past.length).toBe(past);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("sets blend mode and mask with undo; normal removes the field", () => {
    setClipBlendMode("c2", "multiply");
    expect(clip("c2").blendMode).toBe("multiply");
    setClipBlendMode("c2", "normal");
    expect(clip("c2").blendMode).toBeUndefined();
    useProjectStore.getState().undo();
    expect(clip("c2").blendMode).toBe("multiply");
    const m = maskForChoice(undefined, "ellipse");
    setClipMask("c2", m);
    expect(clip("c2").maskRef).toMatchObject({ type: "shape", shape: "ellipse", invert: false });
    // switching shape keeps geometry / feather / invert
    const kept = maskForChoice({ ...(m as ClipMaskShape), feather: 12, invert: true }, "rect");
    expect(kept).toMatchObject({ shape: "rect", feather: 12, invert: true });
    expect(maskForChoice(m, "asset", "sam")).toEqual({ type: "asset", assetId: "sam" });
    expect(maskForChoice(m, "none")).toBeUndefined();
    expect(maskChoiceOf({ type: "asset", assetId: "x" })).toBe("asset");
    useProjectStore.getState().undo();
    expect(clip("c2").maskRef).toBeUndefined();
  });
});

describe("shape mask editor math", () => {
  const start: ClipMaskShape = {
    type: "shape",
    shape: "ellipse",
    x: 0.2,
    y: 0.2,
    w: 0.4,
    h: 0.4,
    feather: 0,
    invert: false,
  };
  const rect = { width: 1000, height: 500 };
  it("moves, resizes from edges/corners (opposite side fixed) and clamps", () => {
    expect(dragMaskShape(start, "move", 100, 50, rect)).toMatchObject({ x: 0.3, y: 0.3, w: 0.4 });
    expect(dragMaskShape(start, "e", 100, 0, rect)).toMatchObject({ x: 0.2, w: 0.5 });
    expect(dragMaskShape(start, "nw", 100, 50, rect)).toMatchObject({
      x: 0.3,
      y: 0.3,
      w: 0.3,
      h: 0.3,
    });
    // cannot invert / collapse the shape
    const tiny = dragMaskShape(start, "w", 900, 0, rect);
    expect(tiny.w).toBeCloseTo(0.02);
    expect(tiny.x + tiny.w).toBeCloseTo(0.6);
    expect(dragMaskShape(start, "move", 5000, 0, rect).x).toBeCloseTo(1.1);
    expect(handlePoint({ x: 10, y: 20, width: 100, height: 50 }, "se")).toEqual({ x: 110, y: 70 });
    expect(handlePoint({ x: 10, y: 20, width: 100, height: 50 }, "n")).toEqual({ x: 60, y: 20 });
  });

  it("mask image URLs (SAM folder frame / single PNG) and luma → alpha", () => {
    expect(maskImageUrl({ path: "masks/job1" }, 1, 25)).toMatch(
      /\/files\/masks\/job1\/00025\.png$/,
    );
    expect(maskImageUrl({ path: "masks/one.png" }, 3, 25)).toMatch(/\/files\/masks\/one\.png$/);
    const px = lumaToAlpha(
      new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]),
    );
    expect([px[3], px[7], px[11]]).toEqual([255, 0, 128]);
  });
});

describe("compositor: z-order, blend and masks", () => {
  it("stacks by Track.order like the export", () => {
    const p = useProjectStore.getState().project;
    expect(composeAt({ project: p, assets: ASSETS, time: 1 }).layers.map((l) => l.clipId)).toEqual([
      "c1",
      "c2",
    ]);
    const swapped = {
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, order: t.id === "t1" ? 5 : t.id === "t2" ? 0 : 1 })),
    };
    expect(
      composeAt({ project: swapped, assets: ASSETS, time: 1 }).layers.map((l) => l.clipId),
    ).toEqual(["c2", "c1"]);
  });

  it("carries blend mode and masks (feather scaled with the PiP scale, SAM frame URL)", () => {
    setClipBlendMode("c2", "screen");
    useProjectStore.getState().updateClip("c2", { scale: 0.5 });
    setClipMask("c2", {
      type: "shape",
      shape: "ellipse",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      feather: 20,
      invert: false,
    });
    let l = composeAt({ project: useProjectStore.getState().project, assets: ASSETS, time: 1 })
      .layers[1]!;
    expect(l.blend).toBe("screen");
    expect(l.mask).toMatchObject({ kind: "shape", featherScale: 0.5 });
    setClipMask("c2", { type: "asset", assetId: "sam" });
    l = composeAt({ project: useProjectStore.getState().project, assets: ASSETS, time: 2 })
      .layers[1]!;
    expect(l.mask?.kind).toBe("url");
    expect(l.mask && "key" in l.mask && l.mask.key).toMatch(/^url:.*\/masks\/job1\/00060\.png$/);
  });

  /** Recording 2D context: ops in order (composite op / filter / alpha at each draw). */
  function fakeCtx(w: number, h: number, log: string[], name: string) {
    const state = { op: "source-over", alpha: 1, filter: "none" };
    const stack: (typeof state)[] = [];
    const ctx = {
      canvas: { width: w, height: h },
      get globalCompositeOperation() {
        return state.op;
      },
      set globalCompositeOperation(v: string) {
        state.op = v;
      },
      get globalAlpha() {
        return state.alpha;
      },
      set globalAlpha(v: number) {
        state.alpha = v;
      },
      get filter() {
        return state.filter;
      },
      set filter(v: string) {
        state.filter = v;
      },
      fillStyle: "",
      save: () => stack.push({ ...state }),
      restore: () => Object.assign(state, stack.pop()),
      setTransform: () => undefined,
      getTransform: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }),
      fillRect: () => undefined,
      clearRect: () => log.push(`${name}:clear`),
      beginPath: () => undefined,
      rect: () => undefined,
      clip: () => undefined,
      ellipse: (cx: number, cy: number, rx: number, ry: number) =>
        log.push(`${name}:ellipse ${cx},${cy} ${rx}x${ry}`),
      fill: () => log.push(`${name}:fill ${state.op} ${state.filter}`),
      drawImage: (el: unknown) =>
        log.push(
          `${name}:draw ${(el as { tag?: string }).tag ?? "?"} ${state.op} a=${state.alpha}`,
        ),
    };
    return ctx;
  }

  it("draws blended / masked layers offscreen with the canvas composite operations", () => {
    setClipBlendMode("c2", "add");
    useProjectStore.getState().updateClip("c2", { opacity: 0.5 });
    setClipMask("c2", {
      type: "shape",
      shape: "ellipse",
      x: 0.1,
      y: 0.1,
      w: 0.8,
      h: 0.8,
      feather: 16,
      invert: false,
    });
    const comp = composeAt({
      project: useProjectStore.getState().project,
      assets: ASSETS,
      time: 1,
    });
    const log: string[] = [];
    const main = fakeCtx(960, 540, log, "main");
    const off = fakeCtx(960, 540, log, "off");
    const scratch = (): ScratchCanvas =>
      ({ width: 960, height: 540, tag: "offscreen", getContext: () => off }) as never;
    const lookup = (key: string) => ({ tag: key }) as unknown as CanvasImageSource;
    drawComposition(main as never, comp, lookup, { width: 1920, height: 1080 }, undefined, {
      scratch,
    });
    // c1 straight on the main canvas; c2 offscreen, masked (blur = feather/2 × device scale 0.5)
    expect(log).toEqual([
      "main:draw c1 source-over a=1",
      "off:clear",
      "off:draw c2 source-over a=1",
      "off:ellipse 480,270 384x216",
      "off:fill destination-in blur(4.00px)",
      "main:draw offscreen lighter a=0.5",
    ]);
    setClipMask("c2", {
      type: "shape",
      shape: "rect",
      x: 0,
      y: 0,
      w: 0.5,
      h: 1,
      feather: 0,
      invert: true,
    });
    setClipBlendMode("c2", "multiply");
    log.length = 0;
    drawComposition(
      main as never,
      composeAt({ project: useProjectStore.getState().project, assets: ASSETS, time: 1 }),
      lookup,
      { width: 1920, height: 1080 },
      undefined,
      { scratch },
    );
    expect(log.slice(-2)).toEqual([
      "off:fill destination-out none",
      "main:draw offscreen multiply a=0.5",
    ]);
  });

  /**
   * Parity with the export: the canvas composite (W3C formulas, as Chromium applies them) of the
   * operation the preview picks must equal the shared reference that the export pixel tests use.
   */
  it.each(["multiply", "screen", "overlay", "add", "difference", "lighten", "darken"] as const)(
    "%s: preview composite = export reference",
    (mode: BlendMode) => {
      setClipBlendMode("c2", mode);
      const l = composeAt({ project: useProjectStore.getState().project, assets: ASSETS, time: 1 })
        .layers[1]!;
      const op = { add: "lighter" }[mode as "add"] ?? l.blend!;
      const canvasOp = (b: number, s: number, a: number) => {
        const [cb, cs] = [b / 255, s / 255];
        const f: Record<string, () => number> = {
          multiply: () => cb * cs,
          screen: () => cb + cs - cb * cs,
          overlay: () => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
          // "lighter" is a Porter-Duff plus: Cb + a·Cs (clamped)
          lighter: () => Math.min(1, cb + cs),
          difference: () => Math.abs(cb - cs),
          lighten: () => Math.max(cb, cs),
          darken: () => Math.min(cb, cs),
        };
        const m = f[op]!();
        return op === "lighter"
          ? Math.round(255 * Math.min(1, cb + a * cs))
          : Math.round(255 * ((1 - a) * cb + a * m));
      };
      for (const a of [1, 0.5]) {
        const want = blendRgb(mode, LAYER_PARITY_BASE, LAYER_PARITY_TOP, a);
        const got = LAYER_PARITY_BASE.map((b, i) => canvasOp(b, LAYER_PARITY_TOP[i]!, a));
        got.forEach((v, i) =>
          expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(LAYER_PARITY_TOLERANCE),
        );
      }
    },
  );
});

describe("inspector «Capa»", () => {
  it("sets the blend mode and an ellipse mask (shape editor on), feather and invert", () => {
    useProjectStore.getState().selectClip("c2");
    const c = clip("c2");
    const track = useProjectStore.getState().project.tracks[1]!;
    const { rerender } = render(<LayerSection clip={c} track={track} />);
    expect(screen.getByText("Capa 2 de 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Modo de fusión"), { target: { value: "screen" } });
    expect(clip("c2").blendMode).toBe("screen");
    fireEvent.change(screen.getByLabelText("Máscara"), { target: { value: "ellipse" } });
    expect(clip("c2").maskRef).toMatchObject({ type: "shape", shape: "ellipse" });
    expect(useMaskEditorStore.getState().clipId).toBe("c2");
    rerender(<LayerSection clip={clip("c2")} track={track} />);
    fireEvent.change(screen.getByLabelText("Difuminado"), { target: { value: "24" } });
    expect(clip("c2").maskRef).toMatchObject({ feather: 24 });
    rerender(<LayerSection clip={clip("c2")} track={track} />);
    fireEvent.click(screen.getByRole("button", { name: /Invertir/ }));
    expect(clip("c2").maskRef).toMatchObject({ invert: true, feather: 24 });
    rerender(<LayerSection clip={clip("c2")} track={track} />);
    fireEvent.change(screen.getByLabelText("Máscara"), { target: { value: "asset" } });
    expect(clip("c2").maskRef).toEqual({ type: "asset", assetId: "sam" });
  });
});
