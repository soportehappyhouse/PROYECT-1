import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  EXTRA_EXPORT_PRESETS,
  ExportPresetSchema,
  ProjectSchema,
  type Project,
} from "@studio/shared";
import { proxyArgs, proxyVideoArgs } from "../src/services/ffmpeg/builders.js";
import { segmentSafetyArgs } from "../src/services/ffmpeg/encoders.js";
import {
  canonicalJson,
  COMPILER_VERSION,
  planSegments,
  segmentHash,
  segmentPresetBlocker,
  segmentProgressMessage,
  transitionWindows,
  type SegmentWindow,
} from "../src/services/ffmpeg/segments.js";
import {
  aiLabelFilter,
  compileExport,
  sliceClipsToWindow,
  type TimelineAsset,
} from "../src/services/ffmpeg/timeline.js";

const now = "2026-10-05T00:00:00.000Z";
const youtube = ExportPresetSchema.parse(DEFAULT_EXPORT_PRESETS[0]!);
const assets = new Map<string, TimelineAsset>([
  [
    "v1",
    {
      id: "v1",
      absPath: "/s/media/v1.mp4",
      kind: "video",
      hasVideo: true,
      hasAudio: true,
      durationSec: 60,
    },
  ],
  [
    "v2",
    {
      id: "v2",
      absPath: "/s/media/v2.mp4",
      kind: "video",
      hasVideo: true,
      hasAudio: true,
      durationSec: 60,
    },
  ],
]);
const clip = (id: string, start: number, len: number, extra: Record<string, unknown> = {}) => ({
  id,
  trackId: "tv",
  assetId: "v1",
  start,
  in: 1,
  out: 1 + len,
  ...extra,
});
const project = (clips: unknown[], extra: Record<string, unknown> = {}): Project =>
  ProjectSchema.parse({
    id: "p",
    name: "P",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "tv", kind: "video", name: "V", clips },
      { id: "tt", kind: "text", name: "T", clips: [] },
    ],
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

describe("segment planner", () => {
  it("cuts at clip boundaries, max 10 s, on the frame grid", () => {
    const p = project([clip("a", 0, 4), clip("b", 4, 25), clip("c", 29, 3)]);
    const plan = planSegments(p, { fps: 30, start: 0, end: 32 });
    if (!("segments" in plan)) throw new Error(plan.fallback);
    const s = plan.segments;
    expect(s[0]).toMatchObject({ start: 0, end: 4, frames: 120 });
    for (const w of s) {
      expect(w.end - w.start).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.abs(w.frames - Math.round((w.end - w.start) * 30))).toBeLessThanOrEqual(1);
    }
    expect(s.at(-1)!.end).toBe(32);
    expect(s.reduce((n, w) => n + w.frames, 0)).toBe(960);
    expect(s.map((w) => w.start)).toEqual([0, 4, 14, 24]);
  });

  it("never cuts inside a fade or an xfade window, and falls back when it must", () => {
    const xfade = project([
      clip("a", 0, 9.5),
      clip("b", 9.5, 9, { transitionIn: { type: "crossfade", durationSec: 1 } }),
    ]);
    expect(transitionWindows(xfade)).toEqual([{ start: 7.5, end: 11.5 }]);
    const plan = planSegments(xfade, { fps: 30, start: 0, end: 18.5 });
    if (!("segments" in plan)) throw new Error(plan.fallback);
    for (const w of plan.segments)
      expect(w.start <= 7.5 + 1e-9 || w.start >= 11.5 - 1e-9).toBe(true);

    const fadeIn = project([clip("a", 0, 30, { transitionIn: { type: "fade", durationSec: 2 } })]);
    expect(transitionWindows(fadeIn)).toEqual([{ start: 0, end: 4 }]);
    // An xfade so long that no cut fits within 10 s: single pass.
    const long = project([
      clip("a", 0, 20),
      clip("b", 9.8, 20, { transitionIn: { type: "crossfade", durationSec: 9.9 } }),
    ]);
    const fb = planSegments(long, { fps: 30, start: 0.2, end: 29 });
    expect("fallback" in fb && fb.fallback).toMatch(/transición/);
  });

  it("rejects presets that cannot be concatenated", () => {
    expect(segmentPresetBlocker(youtube)).toBeUndefined();
    for (const id of ["gif-480", "webm-alpha"])
      expect(segmentPresetBlocker(EXTRA_EXPORT_PRESETS.find((p) => p.id === id)!)).toBeTruthy();
    expect(segmentProgressMessage(3, 12, 2)).toBe("3/12 bloques (2 en caché)");
  });
});

describe("segment hash", () => {
  const p = project([clip("a", 0, 12), clip("b", 12, 12, { assetId: "v2" })], {
    tracks: [
      {
        id: "tv",
        kind: "video",
        name: "V",
        clips: [clip("a", 0, 12), clip("b", 12, 12, { assetId: "v2" })],
      },
      {
        id: "tt",
        kind: "text",
        name: "T",
        clips: [{ id: "t1", trackId: "tt", start: 14, in: 0, out: 2, text: "Hola" }],
      },
      { id: "ta", kind: "audio", name: "A", clips: [] },
    ],
  });
  const stamps = new Map([
    ["v1", { mtimeMs: 1, size: 10 }],
    ["v2", { mtimeMs: 2, size: 20 }],
  ]);
  const w1: SegmentWindow = { start: 0, end: 10, frames: 300 };
  const w2: SegmentWindow = { start: 12, end: 20, frames: 240 };
  const hash = (proj: Project, w: SegmentWindow, st = stamps) =>
    segmentHash({
      project: proj,
      preset: youtube,
      encoder: "libx264",
      window: w,
      gopFrames: 60,
      assets,
      stamps: st,
    });

  it("is stable and only changes for inputs inside the window", () => {
    expect(hash(p, w1)).toBe(hash(structuredClone(p), w1));
    expect(hash(p, w1)).toMatch(/^[0-9a-f]{40}$/);
    const text = structuredClone(p);
    text.tracks[1]!.clips[0]!.text = "Chau";
    expect(hash(text, w1)).toBe(hash(p, w1));
    expect(hash(text, w2)).not.toBe(hash(p, w2));
    // audio-only edits never invalidate video blocks
    const vol = structuredClone(p);
    vol.tracks[0]!.clips[0]!.volume = 0.2;
    expect(hash(vol, w1)).toBe(hash(p, w1));
    // touching the source file (mtime) invalidates the blocks that use it
    const touched = new Map(stamps).set("v1", { mtimeMs: 99, size: 10 });
    expect(hash(p, w1, touched)).not.toBe(hash(p, w1));
    expect(hash(p, w2, touched)).toBe(hash(p, w2));
    const label = {
      ...p,
      publish: {
        forSocial: true,
        flags: { aiFace: false, aiVoice: true, aiOther: false, music: false, thirdParty: false },
        aiLabel: true,
      },
    };
    expect(hash(label, w1)).not.toBe(hash(p, w1));
    // not for social -> no label -> same blocks as without publish settings
    expect(hash({ ...label, publish: { ...label.publish, forSocial: false } }, w1)).toBe(
      hash(p, w1),
    );
  });

  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 0.1234567891 } })).toBe(
      '{"a":{"c":0.123457},"b":1}',
    );
    expect(COMPILER_VERSION).toBeTruthy();
  });
});

describe("compiler window / audio-only / AI label", () => {
  const p = project(
    [clip("a", 0, 12, { transitionIn: { type: "fade", durationSec: 0.5 } }), clip("b", 12, 6)],
    {
      subtitles: [{ start: 9, end: 13, text: "Hola" }],
      publish: {
        forSocial: true,
        flags: { aiFace: true, aiVoice: false, aiOther: false, music: false, thirdParty: false },
        aiLabel: true,
      },
    },
  );

  it("slices clips to a window and keeps transitions only on uncut sides", () => {
    const s = sliceClipsToWindow(p.tracks[0]!.clips, { start: 10, end: 14 });
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ start: 0, in: 11, out: 13 });
    expect(s[0]!.transitionIn).toBeUndefined();
    expect(s[1]).toMatchObject({ start: 2, in: 1, out: 3 });
  });

  it("renders a window as video only with a forced keyframe and absolute-time overlays", () => {
    const c = compileExport({
      project: p,
      preset: youtube,
      assets,
      output: "seg.mp4",
      window: { start: 10, end: 14, timelineEnd: 18, gopFrames: 60, frames: 120 },
    });
    expect(c.args).toEqual(
      expect.arrayContaining(["-force_key_frames", "0", "-g", "60", "-frames:v", "120", "-an"]),
    );
    expect(c.args).not.toContain("[aout]");
    expect(c.graph).not.toMatch(/amix|anullsrc/);
    expect(c.graph).toContain("setpts=PTS+10/TB,subtitles=subs.ass,setpts=PTS-10/TB");
    expect(c.graph).toContain("textfile=ailabel.txt");
    expect(c.files.find((f) => f.name === "ailabel.txt")?.content).toBe(
      "Contenido alterado con IA",
    );
    expect(c.durationSec).toBe(4);
    expect(c.args[c.args.indexOf("-ss")! + 1]).toBe("11");
  });

  it("adds -bf 0 -forced-idr 1 to NVENC blocks (QSV: -forced_idr) and leaves libx264 alone", () => {
    const window = { start: 10, end: 14, timelineEnd: 18, gopFrames: 60, frames: 120 };
    const block = (encoder?: "h264_nvenc" | "h264_qsv" | "h264_amf") =>
      compileExport({
        project: p,
        preset: youtube,
        assets,
        output: "seg.mp4",
        window,
        ...(encoder && { encoder }),
      }).args;
    const nv = block("h264_nvenc");
    const at = nv.indexOf("-bf");
    expect(nv.slice(at, at + 4)).toEqual(["-bf", "0", "-forced-idr", "1"]);
    expect(nv).toEqual(expect.arrayContaining(["h264_nvenc", "-force_key_frames", "0"]));
    expect(block("h264_qsv")).toEqual(expect.arrayContaining(["-bf", "0", "-forced_idr", "1"]));
    for (const args of [block(), block("h264_amf")]) {
      expect(args).not.toContain("-forced-idr");
      expect(args).not.toContain("-forced_idr");
      expect(args).not.toContain("-bf");
    }
    // the single-pass export (no window) is unchanged
    const full = compileExport({
      project: p,
      preset: youtube,
      assets,
      output: "o.mp4",
      encoder: "h264_nvenc",
    }).args;
    expect(full).not.toContain("-forced-idr");
    expect(segmentSafetyArgs(["-c:v", "hevc_nvenc"])).toEqual(["-bf", "0", "-forced-idr", "1"]);
    expect(segmentSafetyArgs(["-c:v", "libx264"])).toEqual([]);
  });

  it("renders the audio mix alone", () => {
    const c = compileExport({
      project: p,
      preset: youtube,
      assets,
      output: "audio.m4a",
      audioOnly: true,
    });
    expect(c.args).toEqual(expect.arrayContaining(["-map", "[aout]", "-vn"]));
    expect(c.args).not.toContain("[vout]");
    expect(c.graph).not.toMatch(/color=|overlay|drawtext|subtitles/);
    expect(c.graph).toContain("amix=inputs=2");
  });

  it("burns the label in the single pass too, with the caption font", () => {
    const styled = {
      ...p,
      captionStyle: {
        id: "x",
        name: "x",
        fontFamily: "Roboto",
        fontSize: 80,
        color: "#fff",
        background: "",
        highlightColor: "#ff0",
        position: "bottom" as const,
        uppercase: false,
        animation: "none" as const,
      },
    };
    const c = compileExport({ project: styled, preset: youtube, assets, output: "o.mp4" });
    expect(c.graph).toContain("textfile=ailabel.txt");
    expect(aiLabelFilter(styled, 1920, 1080)).toMatch(
      /font='Roboto':.*fontsize=34:.*x=24:y=h-text_h-24/,
    );
    const off = compileExport({
      project: { ...p, publish: { ...p.publish!, aiLabel: false } },
      preset: youtube,
      assets,
      output: "o.mp4",
    });
    expect(off.graph).not.toContain("ailabel");
    // decision 4: unchecking "Voy a subirlo a redes" turns the label off even with aiLabel on
    const notSocial = compileExport({
      project: { ...p, publish: { ...p.publish!, forSocial: false } },
      preset: youtube,
      assets,
      output: "o.mp4",
    });
    expect(notSocial.graph).not.toContain("ailabel");
    expect(notSocial.files.find((f) => f.name === "ailabel.txt")).toBeUndefined();
    const custom = compileExport({
      project: { ...p, publish: { ...p.publish!, aiLabelText: "Hecho con IA" } },
      preset: youtube,
      assets,
      output: "o.mp4",
    });
    expect(custom.files.find((f) => f.name === "ailabel.txt")?.content).toBe("Hecho con IA");
  });
});

describe("proxy encoders (NVENC with libx264 fallback)", () => {
  it("builds hardware and libx264 proxy args", () => {
    expect(proxyVideoArgs("libx264")).toEqual([
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-g",
      "15",
      "-keyint_min",
      "15",
      "-sc_threshold",
      "0",
    ]);
    const nv = proxyArgs({ input: "in.mp4", output: "out.mp4", encoder: "h264_nvenc" });
    expect(nv).toEqual(expect.arrayContaining(["-c:v", "h264_nvenc", "-g", "15", "-bf", "0"]));
    expect(nv).not.toContain("libx264");
    expect(proxyArgs({ input: "a", output: "b" })).toContain("libx264");
    for (const e of ["h264_qsv", "h264_amf"] as const) expect(proxyVideoArgs(e)).toContain(e);
  });
});
