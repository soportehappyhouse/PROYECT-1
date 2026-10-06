import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  blendRgb,
  DEFAULT_EXPORT_PRESETS,
  LAYER_PARITY_BASE,
  LAYER_PARITY_TOLERANCE,
  LAYER_PARITY_TOP,
  ProjectSchema,
  type BlendMode,
  type ClipInput,
  type ExportPreset,
  type Project,
} from "@studio/shared";
import { createFfmpegService, type TimelineAsset } from "../src/services/ffmpeg.js";
import { segmentHash } from "../src/services/ffmpeg/segments.js";
import { compileExport } from "../src/services/ffmpeg/timeline.js";
import { tempStorage } from "./helpers.js";

/**
 * Sprint 3b «Capas y fusiones» (lavfi media + pixel checks): blend modes against the shared
 * reference formulas (the preview tests use the same fixture), a feathered elliptical mask
 * (center opaque, corners transparent, edge ≈ 50 %), inverted / rectangle / asset masks, track
 * z-order (Track.order) and blend + mask on a moving (keyframed) clip.
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** RGB (0-255) of the mean of a 4×4 patch centered at (x, y) of the frame at `t`. */
function rgbAt(file: string, t: number, x: number, y: number): [number, number, number] {
  const raw = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(t),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=4:4:${Math.max(0, x - 2)}:${Math.max(0, y - 2)},format=rgb24`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i++) sum[i % 3]! += raw[i]!;
  const n = raw.length / 3 || 1;
  return sum.map((v) => Math.round(v / n)) as [number, number, number];
}

const hex = (c: readonly number[]) => `0x${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const near = (got: readonly number[], want: readonly number[], tol = LAYER_PARITY_TOLERANCE) =>
  got.every((v, i) => Math.abs(v - want[i]!) <= tol);

describe.skipIf(!hasFfmpeg)(
  "export layers: blend modes, masks, z-order",
  { timeout: 300_000 },
  () => {
    const dir = tempStorage("studio-layers-");
    const f = (n: string) => path.join(dir, n);
    const ff = createFfmpegService("ffmpeg", "ffprobe");
    const W = 320;
    const H = 180;
    const preset: ExportPreset = {
      ...DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!,
      width: W,
      height: H,
      fps: 25,
      crf: 12,
    };
    const assets = new Map<string, TimelineAsset>();
    const media = (id: string, color: string) => {
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=${W}x${H}:r=25:d=3`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv444p",
        f(`${id}.mp4`),
      ]);
      assets.set(id, {
        id,
        absPath: f(`${id}.mp4`),
        kind: "video",
        hasVideo: true,
        hasAudio: false,
        width: W,
        height: H,
        fps: 25,
      });
    };

    beforeAll(() => {
      media("base", hex(LAYER_PARITY_BASE));
      media("top", hex(LAYER_PARITY_TOP));
      media("red", "0xff0000");
      media("blue", "0x0000ff");
      media("green", "0x00ff00");
      // Asset masks: one PNG (left half white) and a SAM-like folder of %05d.png (right half).
      gen([
        "-f",
        "lavfi",
        "-i",
        // geq writes exact 0/255 like the SAM PNGs (a lavfi colour converted to gray is 16..235)
        `color=c=black:s=${W}x${H},format=gray,geq=lum='255*lt(X,${W / 2})'`,
        "-frames:v",
        "1",
        "-pix_fmt",
        "gray",
        f("mask-left.png"),
      ]);
      assets.set("mleft", {
        id: "mleft",
        absPath: f("mask-left.png"),
        kind: "mask",
        hasVideo: true,
        hasAudio: false,
      });
      mkdirSync(f("masks"), { recursive: true });
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${W}x${H}:r=25:d=3,format=gray,geq=lum='255*gte(X,${W / 2})'`,
        "-pix_fmt",
        "gray",
        "-start_number",
        "0",
        path.join(f("masks"), "%05d.png"),
      ]);
      assets.set("mseq", {
        id: "mseq",
        absPath: f("masks"),
        kind: "mask",
        hasVideo: true,
        hasAudio: false,
      });
    });

    const project = (
      tracks: {
        id: string;
        order?: number;
        clip: Omit<ClipInput, "id" | "trackId" | "out" | "start">;
      }[],
    ): Project => {
      const now = new Date().toISOString();
      return ProjectSchema.parse({
        id: "p",
        name: "layers",
        settings: { width: W, height: H, fps: 25 },
        tracks: tracks.map((t) => ({
          id: t.id,
          kind: "video",
          name: t.id,
          ...(t.order !== undefined && { order: t.order }),
          clips: [{ id: `c-${t.id}`, trackId: t.id, start: 0, out: 2, ...t.clip }],
        })),
        createdAt: now,
        updatedAt: now,
      });
    };

    let n = 0;
    const render = async (p: Project) => {
      const out = f(`out-${n++}.mp4`);
      const workDir = f(`work-${n}`);
      mkdirSync(workDir, { recursive: true });
      const res = await ff.exportProject({ project: p, preset, assets, output: out, workDir });
      expect(res.warnings.join(" ")).not.toMatch(/no encontrad/);
      return out;
    };

    it.each(["multiply", "screen", "overlay", "add", "difference", "lighten", "darken"] as const)(
      "%s matches the reference formula on a known patch",
      async (mode: BlendMode) => {
        const out = await render(
          project([
            { id: "v1", clip: { assetId: "base" } },
            { id: "v2", clip: { assetId: "top", blendMode: mode } },
          ]),
        );
        const want = blendRgb(mode, LAYER_PARITY_BASE, LAYER_PARITY_TOP);
        const got = rgbAt(out, 1, W / 2, H / 2);
        expect(near(got, want), `${mode}: got ${got} want ${want}`).toBe(true);
      },
    );

    it.each(["multiply", "add"] as const)(
      "%s at 50 %% opacity follows the reference (alpha-weighted / plus)",
      async (mode) => {
        const out = await render(
          project([
            { id: "v1", clip: { assetId: "base" } },
            { id: "v2", clip: { assetId: "top", blendMode: mode, opacity: 0.5 } },
          ]),
        );
        const want = blendRgb(mode, LAYER_PARITY_BASE, LAYER_PARITY_TOP, 0.5);
        const got = rgbAt(out, 1, W / 2, H / 2);
        expect(near(got, want), `${mode}: got ${got} want ${want}`).toBe(true);
      },
    );

    it("elliptical mask with feather: center opaque, corners transparent, edge ≈ half", async () => {
      const mask = {
        type: "shape" as const,
        shape: "ellipse" as const,
        ...{ x: 0.1, y: 0.1, w: 0.8, h: 0.8, feather: 16 },
      };
      const out = await render(
        project([
          { id: "v1", clip: { assetId: "blue" } },
          { id: "v2", clip: { assetId: "red", maskRef: mask } },
        ]),
      );
      expect(near(rgbAt(out, 1, W / 2, H / 2), [255, 0, 0])).toBe(true);
      for (const [x, y] of [
        [3, 3],
        [W - 3, 3],
        [3, H - 3],
        [W - 3, H - 3],
      ] as const)
        expect(near(rgbAt(out, 1, x, y), [0, 0, 255]), `corner ${x},${y}`).toBe(true);
      // Left end of the ellipse (x = 0.1 W): the blurred step is ~50 % red.
      const edge = rgbAt(out, 1, Math.round(W * 0.1), H / 2);
      expect(edge[0]).toBeGreaterThan(90);
      expect(edge[0]).toBeLessThan(170);

      const inverted = await render(
        project([
          { id: "v1", clip: { assetId: "blue" } },
          { id: "v2", clip: { assetId: "red", maskRef: { ...mask, invert: true } } },
        ]),
      );
      expect(near(rgbAt(inverted, 1, W / 2, H / 2), [0, 0, 255])).toBe(true);
      expect(near(rgbAt(inverted, 1, 3, 3), [255, 0, 0])).toBe(true);
    });

    it("rectangle and asset masks (one PNG, SAM folder) keep only their area", async () => {
      const rect = await render(
        project([
          { id: "v1", clip: { assetId: "blue" } },
          {
            id: "v2",
            clip: {
              assetId: "red",
              maskRef: { type: "shape", shape: "rect", x: 0, y: 0, w: 0.5, h: 1 },
            },
          },
        ]),
      );
      expect(near(rgbAt(rect, 1, W / 4, H / 2), [255, 0, 0])).toBe(true);
      expect(near(rgbAt(rect, 1, (3 * W) / 4, H / 2), [0, 0, 255])).toBe(true);
      for (const [id, keep] of [
        ["mleft", W / 4],
        ["mseq", (3 * W) / 4],
      ] as const) {
        const out = await render(
          project([
            { id: "v1", clip: { assetId: "blue" } },
            { id: "v2", clip: { assetId: "red", maskRef: { type: "asset", assetId: id } } },
          ]),
        );
        expect(near(rgbAt(out, 1, keep, H / 2), [255, 0, 0]), id).toBe(true);
        expect(near(rgbAt(out, 1, W - keep, H / 2), [0, 0, 255]), id).toBe(true);
      }
    });

    it("Track.order decides which clip is on top", async () => {
      const a = await render(
        project([
          { id: "v1", clip: { assetId: "red" } },
          { id: "v2", clip: { assetId: "green" } },
        ]),
      );
      expect(near(rgbAt(a, 1, W / 2, H / 2), [0, 255, 0])).toBe(true);
      const b = await render(
        project([
          { id: "v1", order: 1, clip: { assetId: "red" } },
          { id: "v2", order: 0, clip: { assetId: "green" } },
        ]),
      );
      expect(near(rgbAt(b, 1, W / 2, H / 2), [255, 0, 0])).toBe(true);
    });

    it("screen + ellipse mask on a moving PiP clip (keyframes) stays in place", async () => {
      const out = await render(
        project([
          { id: "v1", clip: { assetId: "base" } },
          {
            id: "v2",
            clip: {
              assetId: "top",
              blendMode: "screen",
              maskRef: { type: "shape", shape: "ellipse", x: 0, y: 0, w: 1, h: 1 },
              keyframes: {
                scale: [{ t: 0, v: 0.5 }],
                position: [
                  { t: 0, v: { x: 0.25, y: 0.5 } },
                  { t: 2, v: { x: 0.75, y: 0.5 } },
                ],
              },
            },
          },
        ]),
      );
      // t = 1: clip center at (W/2, H/2), 160×90; the box corner is outside the ellipse.
      const want = blendRgb("screen", LAYER_PARITY_BASE, LAYER_PARITY_TOP);
      expect(near(rgbAt(out, 1, W / 2, H / 2), want)).toBe(true);
      expect(near(rgbAt(out, 1, W / 2 - 76, H / 2 - 41), LAYER_PARITY_BASE)).toBe(true);
      expect(near(rgbAt(out, 1, 20, H / 2), LAYER_PARITY_BASE)).toBe(true);
    });

    it("graph: normal clips keep the plain overlay; missing mask assets only warn", () => {
      const plain = compileExport({
        project: project([
          { id: "v1", clip: { assetId: "base" } },
          { id: "v2", clip: { assetId: "top" } },
        ]),
        preset,
        assets,
        output: "o.mp4",
      });
      expect(plain.graph).not.toMatch(/blend=|alphamerge/);
      const missing = compileExport({
        project: project([
          { id: "v1", clip: { assetId: "base" } },
          { id: "v2", clip: { assetId: "top", maskRef: { type: "asset", assetId: "nope" } } },
        ]),
        preset,
        assets,
        output: "o.mp4",
      });
      expect(missing.warnings.join(" ")).toMatch(/Máscara nope no encontrada/);
      expect(missing.graph).not.toMatch(/alphamerge/);
    });
  },
);

describe("segment cache hash: layer fields", () => {
  const now = new Date().toISOString();
  const base = (): Project =>
    ProjectSchema.parse({
      id: "p",
      name: "h",
      settings: { width: 320, height: 180, fps: 25 },
      tracks: [
        {
          id: "a",
          kind: "video",
          name: "A",
          clips: [{ id: "c1", trackId: "a", assetId: "v1", start: 0, out: 4 }],
        },
        {
          id: "b",
          kind: "video",
          name: "B",
          clips: [{ id: "c2", trackId: "b", assetId: "v2", start: 0, out: 4 }],
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  const assets = new Map<string, TimelineAsset>(
    ["v1", "v2", "m"].map((id) => [
      id,
      {
        id,
        absPath: `/x/${id}`,
        kind: id === "m" ? "mask" : "video",
        hasVideo: true,
        hasAudio: false,
      },
    ]),
  );
  const preset = DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!;
  const hash = (p: Project, stamps = new Map<string, { mtimeMs: number; size: number }>()) =>
    segmentHash({
      project: p,
      preset,
      encoder: "libx264",
      window: { start: 0, end: 4, frames: 120 },
      gopFrames: 60,
      assets,
      stamps,
    });

  it("includes blend mode, mask (and its file) and z-order; old projects keep their hash", () => {
    const p = base();
    const h0 = hash(p);
    const normal = structuredClone(p);
    normal.tracks[1]!.clips[0]!.blendMode = "normal";
    expect(hash(normal)).toBe(h0);
    const blended = structuredClone(p);
    blended.tracks[1]!.clips[0]!.blendMode = "screen";
    expect(hash(blended)).not.toBe(h0);
    const masked = structuredClone(p);
    masked.tracks[1]!.clips[0]!.maskRef = { type: "asset", assetId: "m" };
    const hm = hash(masked);
    expect(hm).not.toBe(h0);
    expect(hash(masked, new Map([["m", { mtimeMs: 5, size: 1 }]]))).not.toBe(hm);
    const reordered = structuredClone(p);
    reordered.tracks[0]!.order = 1;
    reordered.tracks[1]!.order = 0;
    expect(hash(reordered)).not.toBe(h0);
    const explicit = structuredClone(p);
    explicit.tracks[0]!.order = 0;
    explicit.tracks[1]!.order = 1;
    expect(hash(explicit)).toBe(h0);
  });
});
