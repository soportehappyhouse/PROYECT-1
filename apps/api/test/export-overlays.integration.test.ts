import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  fitRect,
  ProjectSchema,
  type CaptionStyle,
  type ExportPreset,
  type Project,
} from "@studio/shared";
import { createFfmpegService, type TimelineAsset } from "../src/services/ffmpeg.js";
import { buildAss } from "../src/services/ffmpeg/ass.js";
import { tempStorage } from "./helpers.js";

/**
 * Regression tests for the first real user test (docs/trabajo/feedback-usuario-2026-10-05.md):
 *  1. motion overlays must be in the export (overlapping clips on one Motion track, clips linked
 *     through renderedAssetId or added from Media with assetId, 16:9 and 9:16 blurred reframe);
 *  3. burned subtitles honour top / center / bottom;
 *  4. burned subtitles stay inside the video rect of a vertical clip in a 16:9 canvas.
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Mean luma (0-255) of a region of the frame at `t` (decoded to gray raw pixels). */
function regionLuma(
  file: string,
  t: number,
  r: { x: number; y: number; w: number; h: number },
): number {
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
    `crop=${r.w}:${r.h}:${r.x}:${r.y},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  let sum = 0;
  for (const v of raw) sum += v;
  return raw.length ? sum / raw.length : 0;
}

/** Bounding box of the bright pixels (luma > 128) of a `w`×`h` image. */
function brightBox(
  file: string,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | undefined {
  const raw = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "format=gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[y * w + x]! > 128) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe.skipIf(!hasFfmpeg)(
  "export overlays + burned subtitles (user feedback)",
  { timeout: 300_000 },
  () => {
    const dir = tempStorage("studio-ovl-");
    const f = (n: string) => path.join(dir, n);
    const ff = createFfmpegService("ffmpeg", "ffprobe");

    // A vertical "WhatsApp" clip (478×850 scaled to 120×214) and 5 VP9-alpha overlays, each drawing a
    // white box at its own x so the frame shows which overlays made it into the export.
    const W = 640;
    const H = 360;
    const boxes = [40, 150, 260, 370, 480];
    const setup = () => {
      gen([
        "-f",
        "lavfi",
        "-i",
        "color=c=0x202020:s=120x214:r=25:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=f=300:d=4",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        f("vertical.mp4"),
      ]);
      boxes.forEach((x, i) =>
        gen([
          "-f",
          "lavfi",
          "-i",
          `color=c=black@0:s=${W}x${H}:r=25:d=4,format=yuva420p,drawbox=x=${x}:y=40:w=60:h=40:color=white@1:t=fill:replace=1`,
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
          f(`ov${i}.webm`),
        ]),
      );
    };

    const assets = new Map<string, TimelineAsset>();
    const project = (): Project => {
      const now = new Date().toISOString();
      const motion = (id: string, i: number, start: number, dur: number, linked: boolean) => ({
        id,
        trackId: "tm",
        start,
        in: 0,
        out: dur,
        // Linked like a render ("Renderizar subtítulos como motion" / "Renderizar y añadir") or
        // added from the Media panel (assetId of the render).
        ...(linked
          ? {
              renderedAssetId: `ov${i}`,
              motion: {
                template: i < 2 ? "animated-captions" : "title-card",
                durationSec: dur,
                format: "webm-vp9-alpha",
                props: {},
              },
            }
          : { assetId: `ov${i}` }),
      });
      return ProjectSchema.parse({
        id: "p1",
        name: "vertical",
        settings: { width: W, height: H, fps: 25 },
        tracks: [
          {
            id: "tv",
            kind: "video",
            name: "Video 1",
            clips: [{ id: "v", trackId: "tv", assetId: "vid", start: 0, in: 0, out: 4 }],
          },
          {
            id: "tm",
            kind: "motion",
            name: "Motion 1",
            clips: [
              // two caption renders at the same start, three title cards at the playhead (0 s)
              motion("c1", 0, 0.2, 3.5, true),
              motion("c2", 1, 0.2, 3.5, true),
              motion("t1", 2, 0, 2, true),
              motion("t2", 3, 0, 2, false),
              motion("t3", 4, 0.5, 2, false),
            ],
          },
        ],
        createdAt: now,
        updatedAt: now,
      });
    };

    it("keeps every overlapping motion overlay (16:9 and 9:16 blurred reframe)", async () => {
      setup();
      assets.set("vid", {
        id: "vid",
        absPath: f("vertical.mp4"),
        kind: "video",
        hasVideo: true,
        hasAudio: true,
        width: 120,
        height: 214,
      });
      for (let i = 0; i < boxes.length; i++) {
        const info = await ff.probe(f(`ov${i}.webm`));
        expect(info.hasAlpha).toBe(true);
        assets.set(`ov${i}`, {
          id: `ov${i}`,
          absPath: f(`ov${i}.webm`),
          kind: "video",
          hasVideo: true,
          hasAudio: false,
          hasAlpha: true,
          ...(info.videoCodec && { videoCodec: info.videoCodec }),
        });
      }
      const presets: { preset: ExportPreset; scale: number; offsetY: number }[] = [
        {
          preset: {
            ...DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!,
            width: W,
            height: H,
            fps: 25,
          },
          scale: 1,
          offsetY: 0,
        },
        {
          // 9:16 blurred-background path: the 640×360 canvas is fitted to 360 px wide, centered.
          preset: {
            ...DEFAULT_EXPORT_PRESETS.find((p) => p.id === "reels-tiktok")!,
            width: 360,
            height: 640,
            fps: 25,
          },
          scale: 360 / W,
          offsetY: (640 - H * (360 / W)) / 2,
        },
      ];
      for (const { preset, scale, offsetY } of presets) {
        const out = f(`${preset.id}.mp4`);
        const workDir = f(`work-${preset.id}`);
        mkdirSync(workDir, { recursive: true });
        const outcome = await ff.exportProject({
          project: project(),
          preset,
          assets,
          output: out,
          workDir,
        });
        expect(outcome.warnings.join(" ")).not.toMatch(/se omite/);
        for (const [i, x] of boxes.entries()) {
          const region = {
            x: Math.round((x + 15) * scale),
            y: Math.round(offsetY + 50 * scale),
            w: Math.max(4, Math.round(30 * scale)),
            h: Math.max(4, Math.round(20 * scale)),
          };
          expect(regionLuma(out, 1, region), `${preset.id}: overlay ${i}`).toBeGreaterThan(200);
        }
        // Without the motion track the same regions are dark (the check is meaningful).
        const bare = project();
        bare.tracks = bare.tracks.filter((t) => t.kind !== "motion");
        const outBare = f(`${preset.id}-bare.mp4`);
        await ff.exportProject({ project: bare, preset, assets, output: outBare, workDir });
        expect(
          regionLuma(outBare, 1, {
            x: Math.round(55 * scale),
            y: Math.round(offsetY + 50 * scale),
            w: 8,
            h: 8,
          }),
        ).toBeLessThan(120);
      }
    });

    const style = (position: CaptionStyle["position"]): CaptionStyle => ({
      id: "t",
      name: "t",
      fontFamily: "DejaVu Sans",
      fontSize: 90,
      color: "#ffffff",
      background: "",
      highlightColor: "#ffffff",
      position,
      uppercase: false,
      animation: "none",
    });

    it.each(["top", "center", "bottom"] as const)(
      "burns subtitles at %s, inside the pillarboxed video rect",
      (position) => {
        const canvas = { width: W, height: H };
        const rect = fitRect(canvas, { width: 478, height: 850 });
        const ass = buildAss(
          [{ start: 0, end: 2, text: "Hola esto es una prueba larga de subtítulos" }],
          { canvas, style: style(position), rectAt: () => rect },
        );
        const sub = f(`pos-${position}`);
        mkdirSync(sub, { recursive: true });
        writeFileSync(path.join(sub, "subs.ass"), ass);
        const png = path.join(sub, "frame.png");
        execFileSync(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=black:s=${W}x${H}:d=1`,
            "-vf",
            "subtitles=subs.ass",
            "-frames:v",
            "1",
            "frame.png",
          ],
          { cwd: sub },
        );
        const box = brightBox(png, W, H);
        expect(box, "no text found").toBeDefined();
        const b = box!;
        // horizontally inside the video rect (wrapped there, not across the 16:9 canvas)
        expect(b.x).toBeGreaterThanOrEqual(Math.floor(rect.x) - 2);
        expect(b.x + b.w).toBeLessThanOrEqual(Math.ceil(rect.x + rect.width) + 2);
        const mid = b.y + b.h / 2;
        if (position === "top") expect(mid).toBeLessThan(H / 3);
        if (position === "center") expect(Math.abs(mid - H / 2)).toBeLessThan(H / 6);
        if (position === "bottom") expect(mid).toBeGreaterThan((H * 2) / 3);
      },
    );
  },
);
