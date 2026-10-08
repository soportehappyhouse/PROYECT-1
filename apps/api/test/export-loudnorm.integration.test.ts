import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOCIAL_LOUDNESS, type Project } from "@studio/shared";
import { measureEbur128 } from "../src/services/export/loudness.js";
import { clip, gen, harness, hasFfmpeg, type Harness } from "./export-harness.js";
import { tempStorage } from "./helpers.js";

/**
 * Sprint 5 (M3): the export mix is normalized with a two-pass loudnorm to the preset target
 * (reels-tiktok: −14 LUFS / −1 dBTP), measured afterwards with ffprobe + ebur128.
 */
describe.skipIf(!hasFfmpeg)("export loudnorm (ffprobe ebur128)", { timeout: 300_000 }, () => {
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    h = await harness("studio-loud-");
    // Voice: 1 kHz tone, amplitude-modulated (speech-like envelope), quiet (≈ −30 LUFS).
    gen([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=6",
      "-af",
      "tremolo=f=3:d=0.7,volume=-27dB",
      "-ac",
      "2",
      h.file("voice.wav"),
    ]);
    // Music: 220 Hz tone (≈ −20 LUFS).
    gen([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000:duration=6",
      "-af",
      "volume=-17dB",
      "-ac",
      "2",
      h.file("music.wav"),
    ]);
    const voice = await h.upload(h.file("voice.wav"), "audio/wav");
    const music = await h.upload(h.file("music.wav"), "audio/wav");
    await h.idle();
    const p = await h.create("Sonoridad", 180, 320);
    const audio = p.tracks.find((t) => t.kind === "audio")!;
    project = await h.save({
      ...p,
      tracks: [
        ...p.tracks.filter((t) => t.kind !== "audio"),
        { ...audio, role: "voice", clips: [clip(audio.id, "v1", voice.id, 0, 6)] } as never,
        {
          ...audio,
          id: "music-track",
          name: "Música",
          role: "music",
          clips: [clip("music-track", "m1", music.id, 0, 6)],
        } as never,
      ],
    });
  }, 120_000);
  afterAll(() => h?.app.close());

  it("reels-tiktok measures −14 ± 1 LUFS and TP ≤ −0.8 dBTP", async () => {
    const { result, abs } = await h.exportNow(project.id, { presetId: "reels-tiktok" });
    const m = await measureEbur128("ffprobe", abs);
    expect(Math.abs(m.integrated - SOCIAL_LOUDNESS.integrated)).toBeLessThanOrEqual(1);
    expect(m.truePeak).toBeLessThanOrEqual(-0.8);
    // result.loudness agrees with the measurement
    expect(result.loudness).toBeDefined();
    expect(result.loudness!.input_i).toBeLessThan(-17);
    expect(Math.abs(result.loudness!.output_i - m.integrated)).toBeLessThanOrEqual(1);
    expect(result.durationS).toBeCloseTo(6, 0);
    expect(result.sizeBytes).toBeGreaterThan(1000);
    expect(result.warnings).toBeUndefined();
  });

  it("a stored built-in preset without `loudness` (database seeded before Sprint 5) still normalizes", async () => {
    const stored = h.app.ctx.repos.presets.get("reels-tiktok")!;
    const { loudness: _drop, ...old } = stored;
    h.app.ctx.db
      .prepare("UPDATE export_presets SET data = ? WHERE id = ?")
      .run(JSON.stringify(old), "reels-tiktok");
    expect(h.app.ctx.repos.presets.get("reels-tiktok")!.loudness).toBeUndefined();
    const { result, abs } = await h.exportNow(project.id, {
      presetId: "reels-tiktok",
      range: { start: 0, end: 4 },
    });
    expect(result.loudness).toBeDefined();
    const m = await measureEbur128("ffprobe", abs);
    expect(Math.abs(m.integrated - SOCIAL_LOUDNESS.integrated)).toBeLessThanOrEqual(1);
  });

  it("normalizeLoudness:false leaves the mix as it was", async () => {
    const { result, abs } = await h.exportNow(project.id, {
      presetId: "reels-tiktok",
      normalizeLoudness: false,
    });
    const m = await measureEbur128("ffprobe", abs);
    expect(result.loudness).toBeUndefined();
    expect(m.integrated).toBeLessThan(SOCIAL_LOUDNESS.integrated - 3);
  });
});

/** ffmpeg wrapper whose loudnorm measurement pass fails (POSIX shell: skipped on Windows). */
describe.skipIf(!hasFfmpeg || process.platform === "win32")(
  "export loudnorm: failed measurement",
  { timeout: 300_000 },
  () => {
    let h: Harness;
    beforeAll(async () => {
      const dir = tempStorage("studio-loudfail-bin-");
      const wrapper = path.join(dir, "ffmpeg");
      writeFileSync(
        wrapper,
        '#!/bin/sh\ncase "$*" in *print_format=json*"-f null"*) echo "boom" >&2; exit 1;; esac\nexec ffmpeg "$@"\n',
      );
      chmodSync(wrapper, 0o755);
      h = await harness("studio-loudfail-", wrapper);
    }, 120_000);
    afterAll(() => h?.app.close());

    it("exports without normalizing and warns LOUDNESS_MEASURE_FAILED", async () => {
      gen([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=500:sample_rate=48000:duration=2",
        "-ac",
        "2",
        h.file("tone.wav"),
      ]);
      const tone = await h.upload(h.file("tone.wav"), "audio/wav");
      await h.idle();
      const p = await h.create("Falla", 180, 320);
      const audio = p.tracks.find((t) => t.kind === "audio")!;
      const saved = await h.save({
        ...p,
        tracks: p.tracks.map((t) =>
          t.id === audio.id ? ({ ...t, clips: [clip(t.id, "a1", tone.id, 0, 2)] } as never) : t,
        ),
      });
      const { result, log } = await h.exportNow(saved.id, { presetId: "reels-tiktok" });
      expect(result.warnings).toEqual(["LOUDNESS_MEASURE_FAILED"]);
      expect(result.loudness).toBeUndefined();
      expect(log.join("\n")).toContain("LOUDNESS_MEASURE_FAILED");
    });
  },
);
