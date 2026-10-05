import { describe, expect, it } from "vitest";
import { parseProbe, parseRate, type FfprobeOutput } from "../src/services/ffmpeg/probe.js";
import { ProgressParser, progressRatio } from "../src/services/ffmpeg/progress.js";
import { parseRange } from "../src/lib/range.js";
import { PeakAccumulator, bucketsPerSecondFor } from "../src/services/ffmpeg/peaks.js";

const phoneVideo: FfprobeOutput = {
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30000/1001",
      side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
    },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.345000" },
};

describe("ffprobe parsing", () => {
  it("parses frame rates", () => {
    expect(parseRate("30/1")).toBe(30);
    expect(parseRate("30000/1001")).toBe(29.97);
    expect(parseRate("0/0")).toBeUndefined();
    expect(parseRate(undefined)).toBeUndefined();
  });

  it("reads a rotated phone video with audio", () => {
    expect(parseProbe(phoneVideo)).toMatchObject({
      kind: "video",
      durationSec: 12.345,
      width: 1080,
      height: 1920,
      fps: 29.97,
      sampleRate: 48000,
      channels: 2,
      hasVideo: true,
      hasAudio: true,
      hasAlpha: false,
      rotation: -90,
      videoCodec: "h264",
      audioCodec: "aac",
    });
  });

  it("detects audio-only files (cover art is not video)", () => {
    const info = parseProbe({
      streams: [
        { codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 },
        {
          codec_type: "video",
          codec_name: "mjpeg",
          width: 500,
          height: 500,
          disposition: { attached_pic: 1 },
        },
      ],
      format: { format_name: "mp3", duration: "180.5" },
    });
    expect(info).toMatchObject({
      kind: "audio",
      durationSec: 180.5,
      hasVideo: false,
      hasAudio: true,
    });
    expect(info.width).toBeUndefined();
  });

  it("detects still images", () => {
    const info = parseProbe({
      streams: [
        { codec_type: "video", codec_name: "png", width: 800, height: 600, pix_fmt: "rgba" },
      ],
      format: { format_name: "png_pipe" },
    });
    expect(info).toMatchObject({ kind: "image", width: 800, height: 600, hasAlpha: true });
    expect(info.durationSec).toBeUndefined();
  });

  it("detects VP9 alpha (alpha_mode tag)", () => {
    const info = parseProbe({
      streams: [
        {
          codec_type: "video",
          codec_name: "vp9",
          width: 1920,
          height: 1080,
          pix_fmt: "yuv420p",
          avg_frame_rate: "30/1",
          tags: { alpha_mode: "1" },
        },
      ],
      format: { format_name: "matroska,webm", duration: "3.000000" },
    });
    expect(info).toMatchObject({ kind: "video", hasAlpha: true, hasAudio: false, fps: 30 });
  });
});

describe("-progress parsing", () => {
  it("parses blocks across chunk boundaries", () => {
    const p = new ProgressParser();
    expect(p.push("frame=10\nfps=25.0\nout_time_us=15000")).toEqual([]);
    const blocks = p.push(
      "00\nout_time=00:00:01.500000\nspeed=2.5x\nprogress=continue\nout_time_us=N/A\nout_time=00:00:03.000000\nprogress=end\n",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ outTimeSec: 1.5, frame: 10, fps: 25, speed: 2.5, done: false });
    expect(blocks[1]).toMatchObject({ outTimeSec: 3, done: true });
    expect(progressRatio(blocks[0]!, 6)).toBe(0.25);
    expect(progressRatio(blocks[1]!, 6)).toBe(1);
    expect(progressRatio({ done: false }, 6)).toBe(0);
  });
});

describe("HTTP Range parsing", () => {
  it("handles start-end, open and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=500-5000", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeUndefined();
    expect(parseRange(undefined, 1000)).toBeUndefined();
  });
});

describe("waveform peaks", () => {
  it("computes max-abs peaks per bucket (WaveformPeaks v1)", () => {
    const acc = new PeakAccumulator(8, 2); // 4 samples per bucket
    const buf = Buffer.alloc(16);
    [0, 16384, -32768, 100, 10, -20, 30, -40].forEach((v, i) => buf.writeInt16LE(v, i * 2));
    acc.push(buf.subarray(0, 5));
    acc.push(buf.subarray(5));
    expect(acc.result()).toEqual({
      version: 1,
      durationSec: 1,
      bucketsPerSecond: 2,
      peaks: [1, 0.001],
    });
    expect(bucketsPerSecondFor(3600)).toBe(16);
    expect(bucketsPerSecondFor(10)).toBe(100);
  });
});
