import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_PRESETS, EXTRA_EXPORT_PRESETS, toExportPresetExt } from "@studio/shared";
import {
  atempoChain,
  buildAudioFxGraph,
  duckingFragment,
  effectFragment,
  loudnormFilter,
  parseLoudnormJson,
  pitchChain,
} from "../src/services/ffmpeg/audio-fx.js";
import {
  audioMixArgs,
  audioMixFilter,
  blurredBackgroundFilter,
  centerCropVerticalFilter,
  concatFilter,
  cornerPosition,
  fadeFilters,
  hexToAssColour,
  overlayFilter,
  pipArgs,
  planSprite,
  proxyArgs,
  speedArgs,
  speedFilters,
  spriteArgs,
  thumbnailArgs,
  trimArgs,
  verticalBlurArgs,
  xfadeFilter,
  xfadeOffsets,
  xfadeTransitionName,
} from "../src/services/ffmpeg/builders.js";
import {
  encoderProbeArgs,
  h264EncoderArgs,
  presetEncoding,
} from "../src/services/ffmpeg/encoders.js";

const fx = (e: Parameters<typeof effectFragment>[0], rubberband = false) =>
  effectFragment(e, "in", "out", "p", { rubberband });

describe("ffmpeg command builders", () => {
  it("accurate trim puts -ss before -i and uses -t", () => {
    expect(trimArgs({ input: "in.mp4", output: "out.mp4", start: 1, duration: 3 }).join(" ")).toBe(
      "-ss 1 -i in.mp4 -t 3 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k -movflags +faststart out.mp4",
    );
  });

  it("concat = trim + concat filter (not the demuxer)", () => {
    const g = concatFilter(
      [
        { input: "a.mp4", start: 1, end: 3, hasAudio: true },
        { input: "b.mp4", start: 0, end: 2, hasAudio: false },
      ],
      { width: 1280, height: 720 },
      30,
    );
    expect(g).toContain(
      "[0:v]trim=1:3,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease",
    );
    expect(g).toContain("[0:a]atrim=1:3,asetpts=PTS-STARTPTS");
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:2[a1]");
    expect(g).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
    expect(g).not.toContain("inpoint");
  });

  it("9:16 blurred background", () => {
    expect(blurredBackgroundFilter({ width: 1080, height: 1920 })).toBe(
      "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30[bgb];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]",
    );
    expect(verticalBlurArgs({ input: "i.mp4", output: "o.mp4" })).toContain("0:a?");
    expect(centerCropVerticalFilter()).toBe("crop=ih*9/16:ih,scale=1080:1920,setsar=1");
  });

  it("speed uses setpts and a chained atempo", () => {
    expect(speedFilters(2)).toEqual({ video: "setpts=PTS/2", audio: "atempo=2" });
    expect(speedFilters(0.5)).toEqual({ video: "setpts=PTS/0.5", audio: "atempo=0.5" });
    expect(speedFilters(4).audio).toBe("atempo=2,atempo=2");
    expect(atempoChain(0.25)).toBe("atempo=0.5,atempo=0.5");
    expect(atempoChain(3)).toBe("atempo=2,atempo=1.5");
    expect(atempoChain(1)).toBe("atempo=1");
    expect(speedArgs({ input: "i", output: "o", factor: 2 })).toContain(
      "[0:v]setpts=PTS/2[v];[0:a]atempo=2[a]",
    );
  });

  it("overlay image with time window and video starting at t", () => {
    expect(overlayFilter({ x: "W-w-20", y: "20", start: 1, end: 4, isVideo: false })).toBe(
      "[0:v][1:v]overlay=x=W-w-20:y=20:enable='between(t,1,4)'[v]",
    );
    expect(
      overlayFilter({ x: "W-w-24", y: "H-h-24", start: 2, isVideo: true, scaleWidth: 320 }),
    ).toBe(
      "[1:v]scale=320:-2,setpts=PTS-STARTPTS+2/TB[ov];[0:v][ov]overlay=x=W-w-24:y=H-h-24:eof_action=pass[v]",
    );
  });

  it("picture-in-picture with corner, frame and delayed audio", () => {
    const args = pipArgs({
      base: "a.mp4",
      overlay: "b.mp4",
      output: "o.mp4",
      corner: "top-left",
      start: 2,
      border: 4,
      overlayHasAudio: true,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain(
      "[1:v]scale=320:-2,pad=iw+8:ih+8:4:4:color=white,setpts=PTS-STARTPTS+2/TB[ov]",
    );
    expect(graph).toContain("overlay=x=24:y=24:eof_action=pass[v]");
    expect(graph).toContain("[1:a]adelay=2000|2000[oa]");
    expect(cornerPosition("bottom-right")).toEqual({ x: "W-w-24", y: "H-h-24" });
  });

  it("fades compute st = duration - d", () => {
    expect(fadeFilters({ duration: 6, fadeIn: 1, fadeOut: 1 })).toEqual({
      video: "fade=t=in:st=0:d=1,fade=t=out:st=5:d=1",
      audio: "afade=t=in:st=0:d=1,afade=t=out:st=5:d=1",
    });
    expect(fadeFilters({ duration: 4 })).toEqual({ video: "null", audio: "anull" });
  });

  it("xfade offsets and graph", () => {
    expect(xfadeOffsets([6, 5, 4], 1)).toEqual([5, 9]);
    const g = xfadeFilter({
      durations: [6, 5],
      transition: "fade",
      duration: 1,
      size: { width: 1280, height: 720 },
      fps: 30,
      withAudio: true,
    });
    expect(g).toContain("settb=AVTB[v0]");
    expect(g).toContain("[v0][v1]xfade=transition=fade:duration=1:offset=5[v]");
    expect(g).toContain("[0:a][1:a]acrossfade=d=1[a]");
    expect(xfadeTransitionName("wipe")).toBe("wipeleft");
  });

  it("audio mix uses adelay per channel and normalize=0", () => {
    expect(
      audioMixFilter([{ input: "a" }, { input: "b", delaySec: 2, volume: 0.5 }], "first"),
    ).toBe(
      "[0:a]volume=1[a0];[1:a]adelay=2000|2000,volume=0.5[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
    );
    expect(audioMixArgs({ inputs: [{ input: "a" }], output: "o.wav" }).slice(-3)).toEqual([
      "-ar",
      "48000",
      "o.wav",
    ]);
  });

  it("media derivatives", () => {
    expect(thumbnailArgs({ input: "i.mp4", output: "t.jpg", atSec: 2 }).join(" ")).toBe(
      "-ss 2 -i i.mp4 -frames:v 1 -vf scale=320:-2 -q:v 3 t.jpg",
    );
    const plan = planSprite(6);
    expect(plan).toMatchObject({ intervalSec: 1, count: 6, columns: 6, rows: 1 });
    expect(spriteArgs({ input: "i.mp4", output: "s.jpg", plan }).join(" ")).toBe(
      "-i i.mp4 -vf fps=1,scale=160:-2,tile=6x1 -frames:v 1 -q:v 4 s.jpg",
    );
    expect(planSprite(3600)).toMatchObject({ intervalSec: 36, count: 100, columns: 10, rows: 10 });
    expect(proxyArgs({ input: "i", output: "p.mp4" }).join(" ")).toContain(
      "-vf scale=-2:360 -c:v libx264 -preset veryfast -crf 28 -g 15 -keyint_min 15 -sc_threshold 0",
    );
  });

  it("ASS colours are BGR", () => {
    expect(hexToAssColour("#FF8800")).toBe("&H000088FF");
    expect(hexToAssColour("#ff000080")).toBe("&H7F0000FF");
  });
});

describe("voice effect chains (fuentes-audio §4)", () => {
  it("pitch preserves tempo with asetrate/atempo or rubberband", () => {
    expect(pitchChain(4)).toBe(
      "aresample=48000,asetrate=48000*1.259921,aresample=48000,atempo=0.793701",
    );
    expect(pitchChain(-4)).toBe(
      "aresample=48000,asetrate=48000*0.793701,aresample=48000,atempo=1.259921",
    );
    expect(pitchChain(4, { rubberband: true })).toBe("rubberband=pitch=1.259921:formant=preserved");
    expect(pitchChain(-12)).toContain("asetrate=48000*0.500000");
  });

  it("chipmunk / deep / telephone / echo / reverb / denoise / robot", () => {
    expect(fx({ type: "chipmunk" })).toBe(
      "[in]aresample=48000,asetrate=48000*1.5,aresample=48000,atempo=0.666667[out]",
    );
    expect(fx({ type: "chipmunk" }, true)).toBe("[in]rubberband=pitch=1.6:formant=preserved[out]");
    expect(fx({ type: "deep" })).toBe(
      "[in]aresample=48000,asetrate=48000*0.75,aresample=48000,atempo=1.333333,lowpass=f=6000[out]",
    );
    expect(fx({ type: "deep" }, true)).toBe(
      "[in]rubberband=pitch=0.7:formant=shifted,lowpass=f=7000[out]",
    );
    expect(fx({ type: "telephone" })).toBe(
      "[in]highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4,volume=1.5[out]",
    );
    expect(fx({ type: "echo", delayMs: 60, decay: 0.4 })).toBe("[in]aecho=0.8:0.88:60:0.4[out]");
    expect(fx({ type: "reverb", roomSize: 0.5, wet: 0.3 })).toBe(
      "[in]aecho=0.8:0.7:20|40|60|80:0.4|0.3|0.2|0.1[out]",
    );
    expect(fx({ type: "denoise", reductionDb: 12, noiseFloorDb: -25 })).toBe(
      "[in]highpass=f=80,afftdn=nr=12:nf=-25:tn=1[out]",
    );
    expect(fx({ type: "robot", intensity: 1 })).toBe(
      "[in]aresample=48000,afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,volume=1.5[out]",
    );
    const mixed = fx({ type: "robot", intensity: 0.7 });
    expect(mixed).toContain("asplit=2[pd][pw]");
    expect(mixed).toContain("amix=inputs=2:weights='0.3 0.7':normalize=0[out]");
  });

  it("loudnorm two-pass filters", () => {
    const e = { integrated: -16, truePeak: -1.5, lra: 11 };
    expect(loudnormFilter(e, "measure")).toBe("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-16.65",\n\t"input_tp" : "-2.97",\n\t"input_lra" : "0.50",\n\t"input_thresh" : "-26.65",\n\t"output_i" : "-16.0",\n\t"target_offset" : "0.04"\n}\n`;
    const measured = parseLoudnormJson(stderr);
    expect(loudnormFilter(e, { measured })).toBe(
      "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-16.65:measured_TP=-2.97:measured_LRA=0.50:measured_thresh=-26.65:offset=0.04:linear=true:print_format=summary",
    );
  });

  it("ducking via sidechaincompress", () => {
    expect(
      duckingFragment(
        {
          type: "ducking",
          musicAssetId: "m",
          threshold: 0.05,
          ratio: 8,
          attackMs: 20,
          releaseMs: 400,
          musicVolume: 1,
        },
        "voice",
        "1:a",
        "out",
        "d",
      ),
    ).toBe(
      "[voice]asplit=2[dsc][dvo];[dsc]apad[dscp];[1:a]aresample=48000[dm];[dm][dscp]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=1[dduck];[dduck][dvo]amix=inputs=2:duration=longest:normalize=0[out]",
    );
  });

  it("graph chains effects and isolates two-pass/ducking in standalone mode", () => {
    const effects = [
      { type: "pitch" as const, semitones: 4 },
      { type: "loudnorm" as const, integrated: -16, truePeak: -1.5, lra: 11, twoPass: true },
      { type: "telephone" as const },
    ];
    const standalone = buildAudioFxGraph(effects, "0:a", "o", { mode: "standalone" });
    expect(standalone.loudnorm).toBeDefined();
    expect(standalone.graph).toBe(
      "[0:a]aresample=48000,asetrate=48000*1.259921,aresample=48000,atempo=0.793701[fx0];[fx0]highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4,volume=1.5[fx1];[fx1]anull[o]",
    );
    const timeline = buildAudioFxGraph(effects, "a", "b", { mode: "timeline" });
    expect(timeline.loudnorm).toBeUndefined();
    expect(timeline.graph).toContain("loudnorm=I=-16:TP=-1.5:LRA=11[fx2]");
  });
});

describe("encoders", () => {
  it("probe command is a real tiny encode", () => {
    expect(encoderProbeArgs("h264_nvenc").join(" ")).toBe(
      "-hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:d=0.2 -c:v h264_nvenc -f null -",
    );
  });

  it("maps quality to each encoder", () => {
    expect(h264EncoderArgs("libx264", { crf: 20 })).toEqual([
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-profile:v",
      "high",
    ]);
    expect(h264EncoderArgs("h264_nvenc", { crf: 20 })).toContain("-cq");
    expect(h264EncoderArgs("h264_qsv", { crf: 20 })).toContain("-global_quality");
    expect(h264EncoderArgs("h264_amf", { crf: 20 })).toContain("-qp_i");
  });

  it("maps presets (YouTube, Reels, GIF, WebM alpha)", () => {
    const yt = presetEncoding(toExportPresetExt(DEFAULT_EXPORT_PRESETS[0]!));
    expect(yt.extension).toBe("mp4");
    expect(yt.video).toEqual(
      expect.arrayContaining(["libx264", "-crf", "20", "-pix_fmt", "yuv420p"]),
    );
    expect(yt.audio).toEqual(["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]);
    expect(yt.container).toEqual(["-movflags", "+faststart"]);
    const gif = presetEncoding(EXTRA_EXPORT_PRESETS.find((p) => p.id === "gif-480")!);
    expect(gif).toMatchObject({ extension: "gif", audio: ["-an"], container: ["-loop", "0"] });
    const webm = presetEncoding(EXTRA_EXPORT_PRESETS.find((p) => p.id === "webm-alpha")!);
    expect(webm.alpha).toBe(true);
    expect(webm.video).toEqual(
      expect.arrayContaining(["libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"]),
    );
    expect(webm.audio[1]).toBe("libopus");
  });
});
