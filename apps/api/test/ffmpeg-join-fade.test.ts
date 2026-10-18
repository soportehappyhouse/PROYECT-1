import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cutTimeline,
  DEFAULT_EXPORT_PRESETS,
  ExportPresetSchema,
  type Clip,
  type Project,
} from "@studio/shared";
import { describe, expect, it } from "vitest";
import {
  compileExport,
  joinFadeFilters,
  type TimelineAsset,
} from "../src/services/ffmpeg/timeline.js";

/** Sprint 6 M1: script cuts put 12 ms `qsin` fades at each join, without changing the duration. */
const clip = (id: string, start: number, inS: number, out: number): Clip =>
  ({
    id,
    trackId: "t1",
    assetId: "a",
    start,
    in: inS,
    out,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
  }) as Clip;

const project = (clips: Clip[]): Project =>
  ({
    id: "p",
    name: "p",
    settings: { width: 320, height: 180, fps: 25 },
    subtitles: [],
    createdAt: "2026-10-18T00:00:00Z",
    updatedAt: "2026-10-18T00:00:00Z",
    tracks: [
      { id: "t1", kind: "audio", name: "A", muted: false, hidden: false, locked: false, clips },
    ],
  }) as unknown as Project;

const assets = new Map<string, TimelineAsset>([
  [
    "a",
    {
      id: "a",
      absPath: "/m/a.wav",
      kind: "audio",
      hasVideo: false,
      hasAudio: true,
      durationSec: 5,
    },
  ],
]);
const preset = ExportPresetSchema.parse(
  DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p"),
);

describe("join fades (Clip.audioFade)", () => {
  it("joinFadeFilters: qsin of 12 ms inside the clip, skipped where a transition fades", () => {
    const f = joinFadeFilters({ audioFade: { inMs: 12, outMs: 12 } }, 2);
    expect(f).toEqual([
      "afade=t=in:st=0:d=0.012:curve=qsin",
      "afade=t=out:st=1.988:d=0.012:curve=qsin",
    ]);
    expect(joinFadeFilters({ audioFade: { inMs: 12, outMs: 0 } }, 2, 0.5)).toEqual([]);
    expect(joinFadeFilters({}, 2)).toEqual([]);
  });

  it("a script cut compiles to afade qsin 12 ms on both sides of the join; same duration", () => {
    const base = project([clip("c1", 0, 0, 4)]);
    const cut = cutTimeline(base, [{ start: 1, end: 1.5 }], { newId: () => "c2" }).project;
    const before = compileExport({
      project: base,
      preset,
      assets,
      output: "o.mp4",
      audioOnly: true,
    });
    const after = compileExport({ project: cut, preset, assets, output: "o.mp4", audioOnly: true });
    expect(before.graph).not.toContain("curve=qsin");
    const fades = after.graph.match(/afade=t=(in|out):st=[\d.]+:d=0\.012:curve=qsin/g) ?? [];
    expect(fades).toHaveLength(2); // out of the first piece, in of the second
    expect(after.durationSec).toBeCloseTo(before.durationSec - 0.5, 3);
    const [a, b] = cut.tracks[0]!.clips;
    expect(a!.out - a!.in + (b!.out - b!.in)).toBeCloseTo(3.5, 6);
  });

  it.skipIf(!hasFfmpeg())("the fade itself keeps the sample count (ffmpeg)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "joinfade-"));
    const out = path.join(dir, "o.wav");
    const f = joinFadeFilters({ audioFade: { inMs: 12, outMs: 12 } }, 1).join(",");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:d=1:sample_rate=48000",
      "-af",
      f,
      out,
    ]);
    const probe = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=duration_ts",
      "-of",
      "csv=p=0",
      out,
    ])
      .toString()
      .trim();
    expect(Number(probe)).toBe(48000);
    writeFileSync(path.join(dir, "ok"), "1");
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
