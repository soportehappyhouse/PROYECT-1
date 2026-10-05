import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  ProjectSchema,
  type ClipInput,
  type ExportPreset,
  type Project,
  type TrackFile,
} from "@studio/shared";
import { createFfmpegService, type TimelineAsset } from "../src/services/ffmpeg.js";
import { tempStorage } from "./helpers.js";

/**
 * Sprint 2 export (lavfi media + pixel checks): a text clip following a synthetic moving-box track,
 * a matte (alpha WebM) over a colour background, a reframe crop following its keyframes, an
 * opacity ramp, a moving/zooming clip, and the segment cache equal to the single pass when an
 * animation crosses a block boundary (expressions rebased per block).
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Raw pixels of the frame at `t` (`fmt` gray = 1 byte, rgb24 = 3 bytes per pixel). */
function frameAt(file: string, t: number, fmt: "gray" | "rgb24" = "gray"): Buffer {
  return execFileSync("ffmpeg", [
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
    `format=${fmt}`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
}

/** Bounding box of luma > `min` (gray frame `w` wide). */
function brightBox(raw: Buffer, w: number, min = 200) {
  const h = raw.length / w;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[y * w + x]! > min) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return undefined;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

const rgbAt = (raw: Buffer, w: number, x: number, y: number) => {
  const i = (y * w + x) * 3;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!] as const;
};
const meanLuma = (raw: Buffer) => raw.reduce((n, v) => n + v, 0) / raw.length;
const meanAbsDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};

describe.skipIf(!hasFfmpeg)(
  "sprint 2 export: keyframes, track, matte, reframe",
  { timeout: 300_000 },
  () => {
    const dir = tempStorage("studio-kf-");
    const f = (n: string) => path.join(dir, n);
    const ff = createFfmpegService("ffmpeg", "ffprobe");
    const W = 640;
    const H = 360;
    const FPS = 25;
    const youtube: ExportPreset = {
      ...DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!,
      width: W,
      height: H,
      fps: FPS,
    };
    const assets = new Map<string, TimelineAsset>();
    let n = 0;

    const make = (tracks: unknown[], extra: Partial<Project> = {}, size = { w: W, h: H }) => {
      const now = new Date().toISOString();
      return ProjectSchema.parse({
        id: "p",
        name: "kf",
        settings: { width: size.w, height: size.h, fps: FPS },
        tracks,
        ...extra,
        createdAt: now,
        updatedAt: now,
      });
    };
    const videoTrack = (clips: ClipInput[], id = "tv") => ({ id, kind: "video", name: id, clips });
    const run = async (
      project: Project,
      o: { preset?: ExportPreset; tracks?: Map<string, TrackFile>; cache?: boolean } = {},
    ) => {
      const out = f(`out-${++n}.mp4`);
      const workDir = f(`work-${n}`);
      mkdirSync(workDir, { recursive: true });
      const outcome = await ff.exportProject({
        project,
        preset: o.preset ?? youtube,
        assets,
        output: out,
        workDir,
        ...(o.tracks && { tracks: o.tracks }),
        ...(o.cache && { segmentCache: { dir: f("cache"), maxBytes: 1e9 } }),
      });
      return { out, outcome };
    };

    // Moving dim box (0x404040, 60×40) on black: x = 40 + 100 t, y = 150, 25 fps, 12 s.
    const box = (t: number) => ({ x: 40 + 100 * t, y: 150, w: 60, h: 40 });
    const track: TrackFile = {
      version: 1,
      fps: FPS,
      smoothed: true,
      source: { assetId: "mov", method: "csrt" },
      frames: Array.from({ length: 4 * FPS + 1 }, (_, i) => {
        const b = box(i / FPS);
        return { t: i / FPS, x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H, conf: 1 };
      }),
    };

    beforeAll(async () => {
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${W}x${H}:r=${FPS}:d=12[b];color=c=0x404040:s=60x40:r=${FPS}:d=12[w];[b][w]overlay=x='40+100*t':y=150`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        f("moving.mp4"),
      ]);
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=white:s=${W}x${H}:r=${FPS}:d=12`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        f("white.mp4"),
      ]);
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=4`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        f("person.mp4"),
      ]);
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=black@0:s=${W}x${H}:r=${FPS}:d=4,format=yuva420p,drawbox=x=200:y=100:w=100:h=100:color=white@1:t=fill:replace=1`,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        f("person-alpha.webm"),
      ]);
      // Split matte (RVM alpha_codec "split"): white colour stream + alpha box as full-range luma.
      gen([
        "-f",
        "lavfi",
        "-i",
        `color=c=white:s=${W}x${H}:r=${FPS}:d=4`,
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${W}x${H}:r=${FPS}:d=4,drawbox=x=200:y=100:w=100:h=100:color=white:t=fill`,
        "-filter_complex",
        "[0:v]format=yuv420p[c];[1:v]format=gray,scale=in_range=full:out_range=full,format=yuv420p,setparams=range=pc[a]",
        "-map",
        "[c]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-qp",
        "0",
        f("person-alpha.mkv"),
      ]);
      const video = (id: string, file: string, dur: number): TimelineAsset => ({
        id,
        absPath: f(file),
        kind: "video",
        hasVideo: true,
        hasAudio: false,
        width: W,
        height: H,
        durationSec: dur,
      });
      assets.set("mov", video("mov", "moving.mp4", 12));
      assets.set("white", video("white", "white.mp4", 12));
      assets.set("person", video("person", "person.mp4", 4));
      const alpha = await ff.probe(f("person-alpha.webm"));
      assets.set("alpha", {
        ...video("alpha", "person-alpha.webm", 4),
        hasAlpha: true,
        ...(alpha.videoCodec && { videoCodec: alpha.videoCodec }),
      });
      assets.set("alpha-split", { ...video("alpha-split", "person-alpha.mkv", 4), hasAlpha: true });
    });

    it("a text clip following a moving-box track lands on the box at 3 timestamps", async () => {
      const project = make([
        videoTrack([{ id: "v", trackId: "tv", assetId: "mov", start: 0, in: 0, out: 4 }]),
        {
          id: "tt",
          kind: "text",
          name: "T",
          clips: [
            {
              id: "txt",
              trackId: "tt",
              start: 0,
              out: 4,
              text: "II",
              textStyle: { fontSize: 30, color: "#ffffff" },
              trackRef: { assetId: "trk", anchor: "center", offset: { x: 0, y: 0 } },
            },
          ],
        },
      ]);
      const { out, outcome } = await run(project, { tracks: new Map([["trk", track]]) });
      expect(outcome.warnings.join(" ")).not.toMatch(/Seguimiento/);
      for (const t of [0.5, 1.5, 3]) {
        const b = brightBox(frameAt(out, t), W)!;
        const exp = box(t);
        expect(b, `t=${t}`).toBeDefined();
        expect(Math.abs(b.cx - (exp.x + exp.w / 2)), `x at t=${t}`).toBeLessThan(8);
        expect(Math.abs(b.cy - (exp.y + exp.h / 2)), `y at t=${t}`).toBeLessThan(8);
      }
    });

    it("draws a matte (alpha WebM) over a colour background", async () => {
      const project = make([
        videoTrack([
          {
            id: "v",
            trackId: "tv",
            assetId: "person",
            start: 0,
            in: 0,
            out: 3,
            matte: { assetId: "alpha", background: { type: "color", value: "#00ff00" } },
          },
        ]),
      ]);
      const { out } = await run(project);
      const raw = frameAt(out, 1, "rgb24");
      const inside = rgbAt(raw, W, 250, 150);
      const outside = rgbAt(raw, W, 50, 50);
      expect(Math.min(...inside)).toBeGreaterThan(200); // white "person"
      expect(outside[1]).toBeGreaterThan(200); // green background
      expect(outside[0]).toBeLessThan(60);
      expect(outside[2]).toBeLessThan(60);
    });

    it("draws a split matte (colour + alpha-as-luma streams) like the WebM one", async () => {
      const clip = {
        id: "v",
        trackId: "tv",
        assetId: "person",
        start: 0,
        in: 0,
        out: 3,
        matte: { assetId: "alpha-split", background: { type: "color", value: "#00ff00" } },
      } satisfies ClipInput;
      const { out } = await run(make([videoTrack([clip])]));
      const raw = frameAt(out, 1, "rgb24");
      expect(Math.min(...rgbAt(raw, W, 250, 150))).toBeGreaterThan(200); // white colour stream
      const [r, g, b] = rgbAt(raw, W, 50, 50); // alpha 0 -> green background
      expect(g).toBeGreaterThan(200);
      expect(Math.max(r, b)).toBeLessThan(60);
    });

    it("reframes to 9:16 with a crop that follows its keyframes", async () => {
      const reels: ExportPreset = {
        ...DEFAULT_EXPORT_PRESETS.find((p) => p.id === "reels-tiktok")!,
        width: 180,
        height: 320,
        fps: FPS,
      };
      // Crop window (202×360 on the 640×360 canvas) centered on the box center 70 + 100 t.
      const cw = 202 / W;
      const rect = (t: number) => ({ x: (70 + 100 * t) / W - cw / 2, y: 0, w: cw, h: 1 });
      const project = make(
        [videoTrack([{ id: "v", trackId: "tv", assetId: "mov", start: 0, in: 0, out: 4 }])],
        {
          reframe: {
            target: "9:16",
            mode: "manual",
            keyframes: [
              { t: 0, v: rect(0), ease: "linear" },
              { t: 4, v: rect(4), ease: "linear" },
            ],
          },
        },
      );
      const { out } = await run(project, { preset: reels });
      for (const t of [1, 2, 3]) {
        const b = brightBox(frameAt(out, t), 180, 40)!;
        expect(b, `t=${t}`).toBeDefined();
        expect(Math.abs(b.cx - 90), `crop center at t=${t}`).toBeLessThan(6);
      }
    });

    it("ramps opacity with keyframes (geq) and moves/zooms a clip (overlay + scale eval=frame)", async () => {
      const ramp = make([
        videoTrack([
          {
            id: "v",
            trackId: "tv",
            assetId: "white",
            start: 0,
            in: 0,
            out: 3,
            keyframes: {
              opacity: [
                { t: 0, v: 0, ease: "linear" },
                { t: 2, v: 1, ease: "linear" },
              ],
            },
          },
        ]),
      ]);
      const { out } = await run(ramp);
      const l = [0.5, 1, 1.5, 2.5].map((t) => meanLuma(frameAt(out, t)));
      expect(l[0]!).toBeLessThan(l[1]!);
      expect(l[1]!).toBeLessThan(l[2]!);
      expect(l[1]! / l[3]!).toBeGreaterThan(0.42);
      expect(l[1]! / l[3]!).toBeLessThan(0.58);

      const moving = make([
        videoTrack([
          {
            id: "v",
            trackId: "tv",
            assetId: "white",
            start: 0,
            in: 0,
            out: 4,
            keyframes: {
              position: [
                { t: 0, v: { x: 0.25, y: 0.5 }, ease: "linear" },
                { t: 4, v: { x: 0.75, y: 0.5 }, ease: "linear" },
              ],
              scale: [
                { t: 0, v: 0.25, ease: "linear" },
                { t: 4, v: 0.5, ease: "linear" },
              ],
            },
          },
        ]),
      ]);
      const res = await run(moving);
      for (const t of [1, 2]) {
        const b = brightBox(frameAt(res.out, t), W)!;
        const s = 0.25 + (0.25 * t) / 4;
        expect(Math.abs(b.cx - (0.25 + (0.5 * t) / 4) * W), `x at t=${t}`).toBeLessThan(4);
        expect(Math.abs(b.cy - H / 2), `y at t=${t}`).toBeLessThan(4);
        expect(Math.abs(b.w - W * s), `w at t=${t}`).toBeLessThan(5);
      }
    });

    it("segment cache equals the single pass when animations cross a block boundary", async () => {
      const project = make([
        videoTrack([{ id: "v", trackId: "tv", assetId: "mov", start: 0, in: 0, out: 12 }]),
        videoTrack(
          [
            {
              id: "w",
              trackId: "tw",
              assetId: "white",
              start: 0,
              in: 0,
              out: 12,
              // One clip over the whole timeline: the planner must cut it at 10 s.
              keyframes: {
                position: [
                  { t: 0, v: { x: 0.2, y: 0.3 }, ease: "linear" },
                  { t: 8, v: { x: 0.3, y: 0.4 }, ease: "easeInOut" },
                  { t: 12, v: { x: 0.8, y: 0.7 }, ease: "linear" },
                ],
                scale: [
                  { t: 9, v: 0.2, ease: "easeOut" },
                  { t: 11, v: 0.3, ease: "linear" },
                ],
                opacity: [
                  { t: 8, v: 0.3, ease: "linear" },
                  { t: 12, v: 1, ease: "linear" },
                ],
              },
            },
          ],
          "tw",
        ),
      ]);
      const single = await run(project);
      const seg = await run(project, { cache: true });
      expect(seg.outcome.mode).toBe("segments");
      expect(seg.outcome.segments!.total).toBe(2); // [0, 10) and [10, 12): cut inside the clip
      for (const t of [9.6, 10.04, 10.4, 11.5]) {
        const d = meanAbsDiff(frameAt(single.out, t), frameAt(seg.out, t));
        expect(d, `t=${t}`).toBeLessThan(4);
      }
    });
  },
);
