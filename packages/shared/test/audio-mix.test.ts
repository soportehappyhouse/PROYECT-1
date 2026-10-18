import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  duckRatioFor,
  duckSidechainGain,
  formatLufsEs,
  duckingGapEs,
  hasMusicName,
  inferTrackRole,
  libraryRole,
  loudnessFor,
  loudnessOk,
  SOCIAL_LOUDNESS,
  type Clip,
  type MediaAsset,
} from "../src/index.js";

const clip = (assetId: string) => ({ id: `c-${assetId}`, assetId }) as unknown as Clip;

describe("music-like names and the ducking note (audit D7)", () => {
  const of = (id: string) =>
    ({
      lofi: { kind: "audio", name: "Música de fondo lofi.mp3" },
      bed: { kind: "audio", name: "background_MUSIC.wav" },
      talk: { kind: "audio", name: "entrevista.wav" },
    })[id] as Pick<MediaAsset, "kind" | "name"> | undefined;

  it("an imported audio track named like music is music", () => {
    expect(hasMusicName("Música")).toBe(true);
    expect(hasMusicName("musica_fondo")).toBe(true);
    expect(hasMusicName("Fondo")).toBe(true);
    expect(hasMusicName("Audio 1")).toBe(false);
    expect(hasMusicName("transfondos")).toBe(false);
    expect(inferTrackRole({ kind: "audio", name: "Audio 1", clips: [clip("lofi")] }, of)).toBe(
      "music",
    );
    expect(inferTrackRole({ kind: "audio", name: "Audio 1", clips: [clip("bed")] }, of)).toBe(
      "music",
    );
    expect(inferTrackRole({ kind: "audio", name: "Música", clips: [clip("talk")] }, of)).toBe(
      "music",
    );
    expect(
      inferTrackRole({ kind: "audio", name: "Audio 1", clips: [clip("lofi"), clip("talk")] }, of),
    ).toBe("other");
    // Video tracks stay voice whatever their name.
    expect(inferTrackRole({ kind: "video", name: "Fondo", clips: [] }, of)).toBe("voice");
  });

  it("explains when «Bajar la música» has nothing to do", () => {
    expect(duckingGapEs(["voice", "music"])).toBeNull();
    expect(duckingGapEs(["voice", "other"])).toMatch(/Música/);
    expect(duckingGapEs(["music"])).toMatch(/Voz/);
    expect(duckingGapEs(["other"])).toMatch(/ni de Música/);
  });
});

describe("inferTrackRole", () => {
  const assets: Record<string, Pick<MediaAsset, "kind" | "aiProvenance">> = {
    tts: {
      kind: "audio",
      aiProvenance: {
        kind: "voice-synthetic",
        tool: "piper es",
        createdAt: "2026-10-08T00:00:00Z",
      },
    },
    ref: { kind: "voice-ref" },
    song: { kind: "audio" },
  };
  const of = (id: string) => assets[id];

  it("keeps an explicit role", () => {
    expect(inferTrackRole({ kind: "audio", role: "music", clips: [clip("tts")] }, of)).toBe(
      "music",
    );
  });
  it("video tracks are voice", () => {
    expect(inferTrackRole({ kind: "video", clips: [] }, of)).toBe("voice");
  });
  it("audio tracks of TTS / own voice are voice", () => {
    expect(inferTrackRole({ kind: "audio", clips: [clip("tts"), clip("ref")] }, of)).toBe("voice");
  });
  it("doubtful audio is other (never ducked)", () => {
    expect(inferTrackRole({ kind: "audio", clips: [clip("song")] }, of)).toBe("other");
    expect(inferTrackRole({ kind: "audio", clips: [clip("tts"), clip("song")] }, of)).toBe("other");
    expect(inferTrackRole({ kind: "audio", clips: [] }, of)).toBe("other");
    expect(inferTrackRole({ kind: "text", clips: [] }, of)).toBe("other");
  });
  it("library sounds: music/ambience -> music, the rest sfx", () => {
    expect(libraryRole("music")).toBe("music");
    expect(libraryRole("ambience")).toBe("music");
    expect(libraryRole("sfx")).toBe("sfx");
    expect(libraryRole(undefined)).toBe("sfx");
  });
});

describe("loudnessFor", () => {
  it("built-in presets: −14 LUFS / −1 dBTP / LRA 11; gif and alpha: null", () => {
    for (const p of DEFAULT_EXPORT_PRESETS) expect(loudnessFor(p)).toEqual(SOCIAL_LOUDNESS);
    expect(loudnessFor({ id: "gif-480", loudness: null })).toBeNull();
    expect(loudnessFor({ id: "webm-alpha" })).toBeNull();
  });
  it("falls back to the catalogue when a stored built-in lacks the field (old databases)", () => {
    expect(loudnessFor({ id: "reels-tiktok" })).toEqual(SOCIAL_LOUDNESS);
    expect(loudnessFor({ id: "youtube-4k", loudness: undefined })).toEqual(SOCIAL_LOUDNESS);
  });
  it("custom presets: their own value, or null when absent", () => {
    expect(loudnessFor({ id: "mine" })).toBeNull();
    const t = { integrated: -16, truePeak: -1.5, lra: 9 };
    expect(loudnessFor({ id: "mine", loudness: t })).toEqual(t);
    expect(loudnessFor({ id: "reels-tiktok", loudness: null })).toBeNull();
  });
});

describe("ducking ratio and loudness checks", () => {
  it("−12 dB gives a ratio near AUTO_DUCK.ratio, clamped to 1..20", () => {
    expect(duckRatioFor(-12)).toBeGreaterThan(5);
    expect(duckRatioFor(-12)).toBeLessThan(9);
    expect(duckRatioFor(0)).toBe(1);
    expect(duckRatioFor(-30)).toBe(20);
    expect(duckRatioFor(-6)).toBeLessThan(duckRatioFor(-12));
  });
  it("sidechain gain brings the voice to −18 LUFS (+6 dB), clamped", () => {
    expect(duckSidechainGain(-18)).toBe(2);
    expect(duckSidechainGain(-30)).toBeCloseTo(2 * 10 ** (12 / 20), 2);
    expect(duckSidechainGain(undefined)).toBe(2);
    expect(duckSidechainGain(-80)).toBe(2);
    expect(duckSidechainGain(-120 + 70)).toBeLessThanOrEqual(64);
    expect(duckSidechainGain(30)).toBeGreaterThanOrEqual(1 / 64);
  });
  it("loudnessOk: ± 1 LU and true peak ≤ target + 0.2", () => {
    expect(loudnessOk({ integrated: -14.6, truePeak: -1.1 }, SOCIAL_LOUDNESS)).toBe(true);
    expect(loudnessOk({ integrated: -15.2, truePeak: -2 }, SOCIAL_LOUDNESS)).toBe(false);
    expect(loudnessOk({ integrated: -14, truePeak: -0.5 }, SOCIAL_LOUDNESS)).toBe(false);
  });
  it("formats LUFS in Spanish", () => {
    expect(formatLufsEs(-14)).toBe("−14,0 LUFS");
    expect(formatLufsEs(-9.94)).toBe("−9,9 LUFS");
  });
});
