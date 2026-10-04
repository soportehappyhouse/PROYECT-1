import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  EXTRA_EXPORT_PRESETS,
  ProjectSchema,
  toExportPresetExt,
  type Project,
} from "@studio/shared";
import {
  compileExport,
  ffmpegColor,
  timelineDuration,
  type TimelineAsset,
} from "../src/services/ffmpeg/timeline.js";

const now = "2026-10-04T00:00:00.000Z";
const youtube = toExportPresetExt(DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p")!);
const reels = toExportPresetExt(DEFAULT_EXPORT_PRESETS.find((p) => p.id === "reels-tiktok")!);
const gif = EXTRA_EXPORT_PRESETS.find((p) => p.id === "gif-480")!;
const webmAlpha = EXTRA_EXPORT_PRESETS.find((p) => p.id === "webm-alpha")!;

const assets = new Map<string, TimelineAsset>([
  [
    "v1",
    {
      id: "v1",
      absPath: "/s/media/v1.mp4",
      kind: "video",
      hasVideo: true,
      hasAudio: true,
      durationSec: 10,
    },
  ],
  [
    "v2",
    {
      id: "v2",
      absPath: "/s/media/v2.mp4",
      kind: "video",
      hasVideo: true,
      hasAudio: false,
      durationSec: 10,
    },
  ],
  [
    "img",
    { id: "img", absPath: "/s/media/logo.png", kind: "image", hasVideo: true, hasAudio: false },
  ],
  [
    "mus",
    {
      id: "mus",
      absPath: "/s/media/music.mp3",
      kind: "audio",
      hasVideo: false,
      hasAudio: true,
      durationSec: 30,
    },
  ],
  [
    "mo",
    {
      id: "mo",
      absPath: "/s/renders/mo.webm",
      kind: "video",
      hasVideo: true,
      hasAudio: false,
      hasAlpha: true,
      videoCodec: "vp9",
    },
  ],
]);

function project(): Project {
  return ProjectSchema.parse({
    id: "p1",
    name: "Demo",
    settings: { width: 1920, height: 1080, fps: 30 },
    createdAt: now,
    updatedAt: now,
    subtitles: [{ start: 0.5, end: 2, text: "Hola" }],
    tracks: [
      {
        id: "t1",
        kind: "video",
        name: "V1",
        clips: [
          {
            id: "c1",
            trackId: "t1",
            assetId: "v1",
            start: 0,
            in: 2,
            out: 6,
            voiceEffects: [{ type: "telephone" }],
          },
          {
            id: "c2",
            trackId: "t1",
            assetId: "v2",
            start: 4,
            in: 1,
            out: 5,
            speed: 2,
            transitionIn: { type: "crossfade", durationSec: 0.5 },
          },
          {
            id: "c3",
            trackId: "t1",
            assetId: "img",
            start: 8,
            in: 0,
            out: 2,
            transitionOut: { type: "fade", durationSec: 1 },
          },
        ],
      },
      {
        id: "t2",
        kind: "motion",
        name: "Motion",
        clips: [
          {
            id: "m1",
            trackId: "t2",
            start: 1,
            in: 0,
            out: 3,
            renderedAssetId: "mo",
            motion: { template: "title-card", durationSec: 3 },
          },
        ],
      },
      {
        id: "t3",
        kind: "text",
        name: "Texto",
        clips: [
          {
            id: "x1",
            trackId: "t3",
            start: 1,
            in: 0,
            out: 2,
            text: "Título: 100%",
            textStyle: { position: "top", color: "#ffcc00", background: "#00000080" },
          },
        ],
      },
      {
        id: "t4",
        kind: "audio",
        name: "Música",
        clips: [{ id: "a1", trackId: "t4", assetId: "mus", start: 0, in: 0, out: 10, volume: 0.3 }],
      },
    ],
  });
}

describe("timeline compiler", () => {
  it("computes duration from clip in/out/speed", () => {
    expect(timelineDuration(project())).toBe(10);
  });

  it("compiles a multi-track project into one filter graph", () => {
    const c = compileExport({
      project: project(),
      preset: youtube,
      assets,
      output: "/s/exports/out.mp4",
    });
    expect(c.durationSec).toBe(10);
    // inputs: accurate seek before -i; xfade handle pulls clip 2 back by 0.5 s (1 s of source at 2x)
    expect(c.args.slice(0, 6)).toEqual(["-ss", "2", "-t", "4.5", "-i", "/s/media/v1.mp4"]);
    expect(c.args).toEqual(
      expect.arrayContaining(["-ss", "0", "-t", "5.5", "-i", "/s/media/v2.mp4"]),
    );
    expect(c.args).toEqual(expect.arrayContaining(["-loop", "1", "-framerate", "30"]));
    // VP9 alpha overlay decoded with libvpx
    const mo = c.args.indexOf("/s/renders/mo.webm");
    expect(c.args.slice(mo - 3, mo)).toEqual(["-c:v", "libvpx-vp9", "-i"]);
    expect(c.args).toEqual(
      expect.arrayContaining([
        "-filter_complex_script",
        "graph.txt",
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-t",
        "10",
      ]),
    );
    expect(c.args.at(-1)).toBe("/s/exports/out.mp4");

    const g = c.graph;
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=10,format=yuv420p[base0]");
    expect(g).toContain("setpts=PTS/2");
    expect(g).toMatch(/xfade=transition=fade:duration=0\.5:offset=3\.5/);
    expect(g).toContain("color=c=black@0:s=1920x1080:r=30:d=2"); // gap before image
    expect(g).toContain("fade=t=out:st=1:d=1:alpha=1"); // image fade out (no next clip)
    expect(g).toMatch(/overlay=0:0:eof_action=pass/);
    expect(g).toContain(
      "drawtext=font='Inter':textfile=text-0.txt:expansion=none:fontsize=64:fontcolor=0xFFCC00:box=1:boxcolor=0x000000@0.502",
    );
    expect(g).toContain("enable='between(t,1,3)'");
    expect(g).toContain("highpass=f=300,lowpass=f=3400"); // clip voice effect
    expect(g).toContain("volume=0.3");
    expect(g).toMatch(
      /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end=10/,
    );
    expect(g).toContain("subtitles=subs.srt:force_style=");
    expect(g).toContain("format=yuv420p[vout]");
    expect(c.files.map((f) => f.name)).toEqual(["graph.txt", "text-0.txt", "subs.srt"]);
    expect(c.files.find((f) => f.name === "text-0.txt")!.content).toBe("Título: 100%");
    expect(c.files.find((f) => f.name === "subs.srt")!.content).toBe(
      "1\n00:00:00,500 --> 00:00:02,000\nHola\n",
    );
    expect(c.warnings).toEqual([]);
  });

  it("reframes 16:9 to 9:16 with a blurred background and trims a range", () => {
    const c = compileExport({
      project: project(),
      preset: reels,
      assets,
      output: "o.mp4",
      range: { start: 2, end: 6 },
    });
    expect(c.durationSec).toBe(4);
    expect(c.graph).toContain("trim=start=2:end=6,setpts=PTS-STARTPTS");
    expect(c.graph).toContain("gblur=sigma=30");
    expect(c.graph).toContain("atrim=start=2:end=6");
    expect(c.args).toEqual(expect.arrayContaining(["-t", "4"]));
  });

  it("GIF uses palettegen/paletteuse and no audio", () => {
    const c = compileExport({ project: project(), preset: gif, assets, output: "o.gif" });
    expect(c.graph).toContain(
      "palettegen=stats_mode=diff[gp];[gs1][gp]paletteuse=dither=bayer:bayer_scale=5[vout]",
    );
    expect(c.args).not.toContain("[aout]");
    expect(c.args).toEqual(expect.arrayContaining(["-an", "-loop", "0"]));
  });

  it("WebM alpha keeps a transparent base", () => {
    const c = compileExport({
      project: project(),
      preset: webmAlpha,
      assets,
      output: "o.webm",
      ffmpegMajor: 7,
    });
    expect(c.graph).toContain("color=c=black@0:s=1920x1080:r=30:d=10,format=yuva420p[base0]");
    expect(c.graph).toContain("format=yuva420p[vout]");
    expect(c.args).toContain("-/filter_complex");
  });

  it("warns about unrendered motion clips and missing assets", () => {
    const p = project();
    p.tracks[1]!.clips[0]!.renderedAssetId = undefined;
    p.tracks[0]!.clips[0]!.assetId = "missing";
    const c = compileExport({ project: p, preset: youtube, assets, output: "o.mp4" });
    expect(c.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sin renderizar"),
        expect.stringContaining("missing"),
      ]),
    );
  });

  it("rejects empty projects", () => {
    const p = { ...project(), tracks: [], subtitles: [] };
    expect(() => compileExport({ project: p, preset: youtube, assets, output: "o.mp4" })).toThrow(
      /contenido/,
    );
  });

  it("converts colours", () => {
    expect(ffmpegColor("#fff")).toBe("0xFFFFFF");
    expect(ffmpegColor("red")).toBe("red");
    expect(ffmpegColor("rgba(1,2,3)")).toBe("white");
  });
});
