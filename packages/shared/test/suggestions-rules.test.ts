import { describe, expect, it } from "vitest";
import {
  clipsSignature,
  EditPlanSchema,
  fmtDurEs,
  ImportSuggestionSchema,
  ProjectSchema,
  suggestionsFromAnalysis,
  visibleSuggestions,
  type ImportAnalysis,
  type Project,
} from "../src/index.js";

const now = "2026-10-18T12:00:00.000Z";

function project(clips: Record<string, unknown>[], extra: Record<string, unknown> = {}): Project {
  return ProjectSchema.parse({
    id: "p1",
    name: "Proyecto",
    settings: { width: 1080, height: 1920, fps: 30 },
    createdAt: now,
    updatedAt: now,
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "Video",
        clips: clips.map((c, i) => ({ id: `c${i}`, trackId: "v", assetId: "a1", ...c })),
        ...extra,
      },
    ],
  });
}

function analysis(over: Partial<ImportAnalysis> = {}): ImportAnalysis {
  return {
    assetId: "a1",
    params_version: 1,
    file_sig: { size: 100, mtime_ms: 1 },
    duration_s: 12,
    noise_floor_db: -90,
    silence_threshold_db: -50,
    silences: [],
    lufs_i: -16,
    lra: 3,
    true_peak_db: -6,
    analyzed_at: now,
    ...over,
  };
}

const asset = { id: "a1", name: "clip.mp4" };
const full = { start: 0, in: 0, out: 12 };

function complete(d: ReturnType<typeof suggestionsFromAnalysis>[number], i = 0) {
  return ImportSuggestionSchema.parse({
    ...d,
    id: `s${i}`,
    status: "open",
    created_at: now,
    updated_at: now,
  });
}

describe("suggestionsFromAnalysis — silences", () => {
  it("3.5 s of silence in 12 s (29 %) → one silences card with a valid cut_silences plan", () => {
    const sil = [
      { start: 2, end: 3.5 },
      { start: 5.5, end: 6.5 },
      { start: 8.5, end: 9.5 },
    ];
    const out = suggestionsFromAnalysis(analysis({ silences: sil }), project([full]), asset);
    expect(out.map((s) => s.kind)).toEqual(["silences"]);
    const s = out[0]!;
    expect(s.title_es).toBe("3 silencios largos = 3,5 s de 12 s");
    expect(s.impact).toEqual({ seconds_saved: 3.5, count: 3 });
    expect(s.evidence?.ranges).toEqual(sil);
    expect(s.clipIds).toEqual(["c0"]);
    expect(EditPlanSchema.parse(s.plan).ops).toEqual([
      { op: "cut_silences", clip: { id: "c0" }, min_silence_ms: 500, fillers: false },
    ]);
    expect(() => complete(s)).not.toThrow();
  });

  it("2 s in 60 s with 2 silences → nothing (under 8 % and under 5 s / 3 silences)", () => {
    const out = suggestionsFromAnalysis(
      analysis({
        duration_s: 60,
        silences: [
          { start: 10, end: 11 },
          { start: 30, end: 31 },
        ],
      }),
      project([{ start: 0, in: 0, out: 60 }]),
      asset,
    );
    expect(out).toEqual([]);
  });

  it("≥ 5 s in ≥ 3 silences is offered even under 8 % of a long clip", () => {
    const sil = [0, 1, 2].map((k) => ({ start: 100 + k * 100, end: 102 + k * 100 }));
    const out = suggestionsFromAnalysis(
      analysis({ duration_s: 600, silences: sil }),
      project([{ start: 0, in: 0, out: 600 }]),
      asset,
    );
    expect(out[0]?.kind).toBe("silences");
    expect(out[0]?.title_es).toBe("3 silencios largos = 6 s de 10:00");
  });

  it("maps silences to the clip's timeline range (trimmed and sped-up clips)", () => {
    const out = suggestionsFromAnalysis(
      analysis({ silences: [{ start: 2, end: 6 }] }),
      project([{ start: 10, in: 4, out: 12, speed: 2 }]),
      asset,
    );
    // inside the clip: 4..6 source → 10..11 timeline (speed 2); 2 s of 4 s = 50 %
    expect(out[0]?.evidence?.ranges).toEqual([{ start: 10, end: 11 }]);
  });

  it("muted kinds and projects without the asset give nothing", () => {
    const a = analysis({ silences: [{ start: 2, end: 6 }] });
    expect(suggestionsFromAnalysis(a, project([full]), asset, ["silences"])).toEqual([]);
    expect(suggestionsFromAnalysis(a, project([full]), { id: "other", name: "x" })).toEqual([]);
    expect(suggestionsFromAnalysis(a, project([full], { muted: true }), asset)).toEqual([]);
  });
});

describe("suggestionsFromAnalysis — loudness", () => {
  it("−30 LUFS → +16 dB wanted, limited by the true peak (−10 dBTP → +9 dB)", () => {
    const out = suggestionsFromAnalysis(
      analysis({ lufs_i: -30, true_peak_db: -10 }),
      project([full]),
      asset,
    );
    expect(out.map((s) => s.kind)).toEqual(["low_voice"]);
    const s = out[0]!;
    expect(s.impact.gain_db).toBe(9);
    expect(s.impact.true_peak_db).toBe(-1);
    expect(s.plan.ops).toEqual([{ op: "set_volume", clip: { id: "c0" }, volume_db: 9 }]);
    expect(s.title_es).toBe("La voz está baja (-30 LUFS)");
    expect(() => complete(s)).not.toThrow();
  });

  it("−30 LUFS with room in the peak → +16 dB to −14 LUFS; capped at +12 dB by the op", () => {
    const a = suggestionsFromAnalysis(
      analysis({ lufs_i: -30, true_peak_db: -20 }),
      project([full]),
      asset,
    )[0]!;
    expect(a.plan.ops[0]).toMatchObject({ volume_db: 12 });
    const b = suggestionsFromAnalysis(
      analysis({ lufs_i: -26, true_peak_db: -20 }),
      project([full]),
      asset,
    )[0]!;
    expect(b.plan.ops[0]).toMatchObject({ volume_db: 12 });
    expect(b.impact.target_lufs).toBe(-14);
  });

  it("a clip already turned up (volume) does not repeat the suggestion", () => {
    const a = analysis({ lufs_i: -30, true_peak_db: -20 });
    const out = suggestionsFromAnalysis(a, project([{ ...full, volume: 3.98 }]), asset);
    expect(out).toEqual([]);
  });

  it("−1.0 dBTP does not clip, −0.5 does (set_volume down to −1 dBTP)", () => {
    expect(suggestionsFromAnalysis(analysis({ true_peak_db: -1 }), project([full]), asset)).toEqual(
      [],
    );
    const out = suggestionsFromAnalysis(analysis({ true_peak_db: -0.5 }), project([full]), asset);
    expect(out.map((s) => s.kind)).toEqual(["clipping"]);
    expect(out[0]!.plan.ops).toEqual([{ op: "set_volume", clip: { id: "c0" }, volume_db: -0.5 }]);
    expect(out[0]!.title_es).toBe("El audio satura (pico de -0,5 dBTP)");
  });

  it("silent file (no LUFS) gives no loudness card", () => {
    expect(
      suggestionsFromAnalysis(
        analysis({ lufs_i: null, true_peak_db: null }),
        project([full]),
        asset,
      ),
    ).toEqual([]);
  });
});

describe("stale signature and visible cards", () => {
  it("clipsSignature changes when the clip is trimmed, sped up, its volume changes or it is gone", () => {
    const p = project([full]);
    const sig = clipsSignature(p, ["c0"]);
    expect(clipsSignature(project([full]), ["c0"])).toBe(sig);
    expect(clipsSignature(project([{ ...full, out: 11 }]), ["c0"])).not.toBe(sig);
    expect(clipsSignature(project([{ ...full, speed: 1.5 }]), ["c0"])).not.toBe(sig);
    expect(clipsSignature(project([{ ...full, volume: 2 }]), ["c0"])).not.toBe(sig);
    expect(clipsSignature(project([]), ["c0"])).toBe("c0:gone");
  });

  it("at most 4 cards, open before stale, ranked by impact; applied/dismissed hidden", () => {
    const mk = (kind: "silences" | "low_voice" | "clipping", status: string, saved = 0) => ({
      kind,
      status: status as "open",
      impact: { seconds_saved: saved, gain_db: 6 },
    });
    const list = [
      mk("low_voice", "open"),
      mk("silences", "open", 3),
      mk("silences", "stale", 30),
      mk("silences", "open", 10),
      mk("clipping", "open"),
      mk("silences", "dismissed", 99),
      mk("silences", "applied", 99),
    ];
    const vis = visibleSuggestions(list);
    expect(vis).toHaveLength(4);
    expect(vis.map((v) => `${v.kind}:${v.status}`)).toEqual([
      "clipping:open",
      "silences:open",
      "silences:open",
      "low_voice:open",
    ]);
    expect(visibleSuggestions(list, 10).at(-1)?.status).toBe("stale");
  });

  it("formats durations in Spanish", () => {
    expect(fmtDurEs(12)).toBe("12 s");
    expect(fmtDurEs(3.5)).toBe("3,5 s");
    expect(fmtDurEs(185)).toBe("3:05");
  });
});
