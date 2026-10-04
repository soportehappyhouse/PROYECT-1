import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MotionSpecSchema } from "@studio/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildTitleArgs,
  createFfmpegLottieEngine,
  fadeAlphaExpr,
  ffmpegTitleSchema,
  filterExpr,
  filterPath,
  parseProgressLine,
  validateFfmpegTitle,
} from "../src/index.js";

const spec = (over: Record<string, unknown> = {}) =>
  MotionSpecSchema.parse({
    template: "ffmpeg-title",
    durationSec: 3,
    width: 1280,
    height: 720,
    ...over,
  });

const base = {
  output: "/out/x.mp4",
  titleFile: "/tmp/job/title.txt",
  fontFile: "/fonts/Bold.ttf",
};

const fc = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";

describe("ffmpeg-title command builder", () => {
  it("solid background -> lavfi color + drawtext with fade/rise -> h264", () => {
    const args = buildTitleArgs({ ...base, spec: spec(), props: ffmpegTitleSchema.parse({}) });
    expect(args).toContain("-progress");
    expect(args[args.indexOf("-i") + 1]).toBe("color=c=#111111:s=1280x720:r=30:d=3,format=rgba");
    const graph = fc(args);
    expect(graph).toContain(
      "drawtext=textfile='/tmp/job/title.txt':fontfile='/fonts/Bold.ttf':expansion=none",
    );
    expect(graph).toContain(`alpha='max(0\\,min(1\\,min(t/0.5\\,(3-t)/0.5)))'`);
    expect(graph).toContain("fontsize=96");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-pix_fmt", "yuv420p"]));
    expect(args.at(-1)).toBe("/out/x.mp4");
    expect(args).not.toContain("0:a?");
  });

  it("transparent background -> alpha color source and VP9 yuva420p", () => {
    const args = buildTitleArgs({
      ...base,
      output: "/out/x.webm",
      spec: spec({ format: "webm-vp9-alpha" }),
      props: ffmpegTitleSchema.parse({ background: "transparent" }),
    });
    expect(args.join(" ")).toContain("color=c=black@0.0:s=1280x720");
    expect(args).toEqual(
      expect.arrayContaining(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"]),
    );
  });

  it("alpha WebM overlay forces the libvpx decoder before its -i and overlays it", () => {
    const args = buildTitleArgs({
      ...base,
      spec: spec(),
      props: ffmpegTitleSchema.parse({ overlayPosition: "bottom-right", overlayStartSec: 0.5 }),
      overlay: "/s/renders/lottie.webm",
    });
    const i = args.indexOf("/s/renders/lottie.webm");
    expect(args.slice(i - 3, i)).toEqual(["-c:v", "libvpx-vp9", "-i"]);
    expect(fc(args)).toContain("[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[ov]");
    expect(fc(args)).toContain("overlay=x=W-w-40:y=H-h-40:eof_action=pass");
  });

  it("video background keeps audio only when includeAudio; image loops", () => {
    const withAudio = buildTitleArgs({
      ...base,
      spec: spec({ includeAudio: true, format: "prores-4444" }),
      props: ffmpegTitleSchema.parse({ subtitle: "Sub" }),
      subtitleFile: "/tmp/job/subtitle.txt",
      backgroundMedia: { path: "/s/media/a.mp4", kind: "video" },
    });
    expect(withAudio).toEqual(expect.arrayContaining(["-map", "0:a?", "-c:a", "pcm_s16le"]));
    expect(withAudio).toEqual(expect.arrayContaining(["-c:v", "prores_ks", "-profile:v", "4444"]));
    expect(fc(withAudio)).toContain("[sub]");
    const image = buildTitleArgs({
      ...base,
      spec: spec(),
      props: ffmpegTitleSchema.parse({}),
      backgroundMedia: { path: "/s/media/a.png", kind: "image" },
    });
    expect(image.slice(image.indexOf("-loop"), image.indexOf("-loop") + 4)).toEqual([
      "-loop",
      "1",
      "-i",
      "/s/media/a.png",
    ]);
  });

  it("png-sequence writes numbered frames into the output folder", () => {
    const args = buildTitleArgs({
      ...base,
      output: "/out/frames/",
      spec: spec({ format: "png-sequence" }),
      props: ffmpegTitleSchema.parse({}),
    });
    expect(args.at(-1)).toBe("/out/frames/frame-%05d.png");
  });

  it("escapes Windows font paths and expressions for the filtergraph", () => {
    expect(filterPath("C:\\Windows\\Fonts\\arialbd.ttf")).toBe("'C\\:/Windows/Fonts/arialbd.ttf'");
    expect(filterExpr("min(t/0.5,1)")).toBe("'min(t/0.5\\,1)'");
    expect(fadeAlphaExpr(3, 0, 0)).toBe("max(0,min(1,min(1,1)))");
  });

  it("validates props and media refs", () => {
    expect(validateFfmpegTitle(spec({ props: { fontColor: "not a color!" } })).ok).toBe(false);
    expect(
      validateFfmpegTitle(spec({ media: { overlay: { kind: "lottie", path: "x.json" } } })),
    ).toMatchObject({ ok: false });
    expect(validateFfmpegTitle(spec({ media: { foo: { kind: "video", path: "a.mp4" } } })).ok).toBe(
      false,
    );
    expect(
      validateFfmpegTitle(spec({ media: { background: { kind: "video", path: "../a.mp4" } } })).ok,
    ).toBe(false);
    expect(
      validateFfmpegTitle(spec({ props: { text: "Hola", fontColor: "0xffd400@0.8" } })),
    ).toEqual({ ok: true });
  });

  it("parses -progress lines", () => {
    expect(parseProgressLine("out_time_us=1500000")).toBe(1.5);
    expect(parseProgressLine("out_time_ms=2000000")).toBe(2);
    expect(parseProgressLine("progress=continue")).toBeUndefined();
  });
});

function systemFfmpegHasDrawtext(): boolean {
  try {
    return / drawtext /.test(
      execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
}

describe.skipIf(!systemFfmpegHasDrawtext())(
  "ffmpeg-lottie render (integration, system ffmpeg)",
  () => {
    let dir = "";
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it(
      "renders a transparent title to WebM and composites it as overlay over a title mp4",
      { timeout: 60_000 },
      async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "studio-ffmpeg-"));
        const engine = createFfmpegLottieEngine({ ffmpegPath: "ffmpeg" });
        expect(await engine.checkAvailable()).toEqual({ ok: true });
        const ctx = (out: string) => ({
          jobId: "t",
          storageDir: dir,
          outputPath: out,
          tmpDir: path.join(dir, "tmp", out),
          mediaBaseUrl: "http://127.0.0.1:3001/files/",
        });
        const small = { durationSec: 1, width: 320, height: 180, fps: 25 };
        const ratios: number[] = [];
        const overlay = await engine.render(
          spec({
            ...small,
            format: "webm-vp9-alpha",
            props: { text: "Hola: 100% ¡ñ!", background: "transparent", fontSize: 40 },
          }),
          { ...ctx("renders/ov.webm"), onProgress: (p) => ratios.push(p.ratio) },
        );
        expect(overlay.hasAlpha).toBe(true);
        const alpha = execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream_tags=alpha_mode",
            "-of",
            "csv=p=0",
            path.join(dir, "renders/ov.webm"),
          ],
          { encoding: "utf8" },
        );
        expect(alpha.trim()).toBe("1");

        const result = await engine.render(
          spec({
            ...small,
            props: { text: "Base", subtitle: "con overlay", fontSize: 30, subtitleSize: 16 },
            media: { overlay: { kind: "video", path: "renders/ov.webm" } },
          }),
          ctx("renders/final.mp4"),
        );
        expect(result).toMatchObject({
          engine: "ffmpeg-lottie",
          format: "mp4-h264",
          hasAlpha: false,
        });
        expect(existsSync(path.join(dir, "renders/final.mp4"))).toBe(true);
        expect(ratios.at(-1)).toBe(1);
      },
    );
  },
);
