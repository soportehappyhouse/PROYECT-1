import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  ExportPresetSchema,
  type ExportPreset,
  type Project,
} from "@studio/shared";
import { compileExport, type TimelineAsset } from "../src/services/ffmpeg/timeline.js";
import { exportAudioMix } from "../src/jobs/handlers/project-export.js";
import { clip, gen, harness, hasFfmpeg, rmsDb, type Harness } from "./export-harness.js";

/**
 * Sprint 5 (M3): automatic ducking by track role at export. The music (200 Hz) must drop under the
 * voice (1 kHz, 2–5 s) by ≥ 8 dB compared with autoDuck off; without a voice track the graph has
 * no sidechain at all.
 */
const MUSIC_BAND = "lowpass=f=300,lowpass=f=300,lowpass=f=300";

describe.skipIf(!hasFfmpeg)("export automatic ducking", { timeout: 300_000 }, () => {
  let h: Harness;
  let project: Project;
  let preset: ExportPreset;

  beforeAll(async () => {
    h = await harness("studio-duck-");
    gen([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=3",
      "-af",
      "volume=-9dB",
      "-ac",
      "2",
      h.file("voice.wav"),
    ]);
    gen([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=200:sample_rate=48000:duration=8",
      "-af",
      "volume=-12dB",
      "-ac",
      "2",
      h.file("music.wav"),
    ]);
    const voice = await h.upload(h.file("voice.wav"), "audio/wav");
    const music = await h.upload(h.file("music.wav"), "audio/wav");
    await h.idle();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/export-presets",
      payload: { name: "Test 180p", aspect: "16:9", width: 320, height: 180, fps: 25, crf: 30 },
    });
    expect(created.statusCode).toBe(201);
    preset = created.json<ExportPreset>();
    const p = await h.create("Ducking", 320, 180);
    const audio = p.tracks.find((t) => t.kind === "audio")!;
    project = await h.save({
      ...p,
      tracks: [
        ...p.tracks.filter((t) => t.kind !== "audio"),
        { ...audio, role: "voice", clips: [clip(audio.id, "v1", voice.id, 2, 3)] } as never,
        {
          ...audio,
          id: "music-track",
          name: "Música",
          role: "music",
          clips: [clip("music-track", "m1", music.id, 0, 8)],
        } as never,
      ],
    });
  }, 120_000);
  afterAll(() => h?.app.close());

  it("the music drops ≥ 8 dB under the voice (vs autoDuck off)", async () => {
    const on = await h.exportNow(project.id, { presetId: preset.id, autoDuck: true });
    const off = await h.exportNow(project.id, { presetId: preset.id, autoDuck: false });
    expect(on.result.ducked).toEqual({ voiceTracks: 1, musicTracks: 1 });
    expect(off.result.ducked).toBeUndefined();
    const duckedRms = rmsDb(on.abs, 3, 1.5, MUSIC_BAND);
    const plainRms = rmsDb(off.abs, 3, 1.5, MUSIC_BAND);
    expect(plainRms - duckedRms).toBeGreaterThanOrEqual(8);
    // Before the voice and well after it (release 600 ms) the music is back.
    expect(
      Math.abs(rmsDb(on.abs, 0.2, 1.5, MUSIC_BAND) - rmsDb(off.abs, 0.2, 1.5, MUSIC_BAND)),
    ).toBeLessThan(2);
    expect(
      Math.abs(rmsDb(on.abs, 6.5, 1, MUSIC_BAND) - rmsDb(off.abs, 6.5, 1, MUSIC_BAND)),
    ).toBeLessThan(3);
  });

  it("project.audioMix.autoDuck:false turns it off by default", async () => {
    const saved = await h.save({ ...project, audioMix: { autoDuck: false, duckDb: -12 } });
    const r = await h.exportNow(saved.id, { presetId: preset.id });
    expect(r.result.ducked).toBeUndefined();
    project = await h.save({ ...saved, audioMix: undefined } as Project);
  });
});

describe("automatic ducking graph", () => {
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
    [
      "b",
      {
        id: "b",
        absPath: "/m/b.wav",
        kind: "audio",
        hasVideo: false,
        hasAudio: true,
        durationSec: 5,
      },
    ],
  ]);
  const base = (roles: [string | undefined, string | undefined]): Project =>
    ({
      id: "p",
      name: "p",
      settings: { width: 320, height: 180, fps: 25 },
      subtitles: [],
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
      tracks: [
        {
          id: "t1",
          kind: "audio",
          name: "A",
          muted: false,
          hidden: false,
          locked: false,
          ...(roles[0] && { role: roles[0] }),
          clips: [clip("t1", "c1", "a", 0, 4)],
        },
        {
          id: "t2",
          kind: "audio",
          name: "B",
          muted: false,
          hidden: false,
          locked: false,
          ...(roles[1] && { role: roles[1] }),
          clips: [clip("t2", "c2", "b", 0, 4)],
        },
      ],
    }) as unknown as Project;
  const preset = ExportPresetSchema.parse(
    DEFAULT_EXPORT_PRESETS.find((p) => p.id === "youtube-1080p"),
  );
  const graphOf = (project: Project, autoDuck?: boolean) =>
    compileExport({
      project,
      preset,
      assets,
      output: "out.mp4",
      audioOnly: true,
      audioMix: exportAudioMix(project, () => undefined, autoDuck),
    }).graph;

  it("voice + music: sidechaincompress with the AUTO_DUCK timing", () => {
    const g = graphOf(base(["voice", "music"]));
    expect(g).toMatch(/sidechaincompress=threshold=0\.05:ratio=[\d.]+:attack=150:release=600/);
    expect(g).toContain("apad=whole_dur=");
  });
  it("no voice track (or autoDuck off, or unknown roles): no sidechain", () => {
    expect(graphOf(base(["music", "music"]))).not.toContain("sidechaincompress");
    expect(graphOf(base([undefined, undefined]))).not.toContain("sidechaincompress");
    expect(graphOf(base(["voice", "music"]), false)).not.toContain("sidechaincompress");
  });
});
