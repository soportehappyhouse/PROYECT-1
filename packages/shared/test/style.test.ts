import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_CONFIRM_OPS,
  DEFAULT_STYLE_PRESET,
  EditPlanSchema,
  StyleAnalysisSchema,
  StylePresetSchema,
  canvasAspect,
  compileStylePreset,
  stylePlanNotes,
  stylePresetJsonSchema,
  validateStylePreset,
  type Project,
  type StylePresetDraft,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const REELS: StylePresetDraft = {
  name: "Reels dinámico",
  canvas: "9:16",
  cut_rhythm: { target_shot_s: 1.8, remove_silences: true, min_silence_ms: 300 },
  captions: { style: "reels", animated: true, position: "center" },
  titles: { template: "title-card", params: { title: "Hola", style: "pop" }, duration_s: 2 },
  lower_third: { params: { name: "Ana", role: "Chef" } },
  transitions: { type: "slide", every_n_cuts: 3 },
  music: { duck: true, volume_db: -16 },
  zoom_punch_in: { every_s: 4, scale: 1.2 },
  ai_label: true,
  export_preset: "reels-tiktok",
  notes_es: "Cortes rápidos, subtítulos grandes al centro y música de fondo.",
};

function project(over: Partial<Project> = {}): Project {
  const now = "2026-10-06T00:00:00.000Z";
  return {
    id: "p1",
    name: "Demo",
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48_000 },
    tracks: [
      {
        id: "tv",
        kind: "video",
        name: "Video",
        muted: false,
        locked: false,
        hidden: false,
        clips: [
          {
            id: "c1",
            trackId: "tv",
            assetId: "a1",
            start: 0,
            in: 0,
            out: 20,
            speed: 1,
            volume: 1,
            opacity: 1,
            voiceEffects: [],
          },
        ],
      },
      {
        id: "ta",
        kind: "audio",
        name: "Música",
        muted: false,
        locked: false,
        hidden: false,
        clips: [
          {
            id: "m2",
            trackId: "ta",
            assetId: "a3",
            start: 8,
            in: 0,
            out: 10,
            speed: 1,
            volume: 1,
            opacity: 1,
            voiceEffects: [],
          },
          {
            id: "m1",
            trackId: "ta",
            assetId: "a2",
            start: 0,
            in: 0,
            out: 8,
            speed: 1,
            volume: 1,
            opacity: 1,
            voiceEffects: [],
          },
        ],
      },
    ],
    subtitles: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Project;
}

describe("StylePreset schema", () => {
  it("accepts the reference preset and the default; rejects bad values in Spanish", () => {
    expect(validateStylePreset(REELS).ok).toBe(true);
    expect(validateStylePreset(DEFAULT_STYLE_PRESET).ok).toBe(true);
    const bad = validateStylePreset({ ...REELS, canvas: "4:3", cut_rhythm: { target_shot_s: 0 } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/canvas/);
    expect(bad.errors.join(" ")).toMatch(/cut_rhythm/);
    expect(StylePresetSchema.safeParse({ ...REELS, id: "s1" }).success).toBe(true);
    expect(StylePresetSchema.safeParse({ ...REELS }).success).toBe(false); // id required
  });

  it("JSON Schema for Ollama has no id and lists the required fields", () => {
    const schema = stylePresetJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(props.id).toBeUndefined();
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["canvas", "cut_rhythm", "captions", "titles", "export_preset"]),
    );
    expect(schema.required).toEqual(
      expect.arrayContaining(["name", "canvas", "cut_rhythm", "music", "notes_es"]),
    );
    expect(JSON.stringify(schema)).not.toContain("$ref");
  });

  it("the exported workers schema is in sync (pnpm --filter @studio/shared export-schemas)", () => {
    const file = path.resolve(
      here,
      "../../../apps/workers/studio_workers/style/stylepreset.schema.json",
    );
    const exported = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const { $id: _id, title: _t, ...rest } = exported;
    expect(rest).toEqual(JSON.parse(JSON.stringify(stylePresetJsonSchema())));
  });

  it("StyleAnalysis parses a minimal workers answer", () => {
    const a = StyleAnalysisSchema.parse({
      duration_s: 10,
      fps: 25,
      canvas: { w: 640, h: 360, aspect: "16:9" },
      scenes: [{ start: 0, end: 10 }],
      shot_stats: { count: 1, mean_s: 10, median_s: 10, cuts_per_min: 0, histogram: [] },
      motion: {
        zoom_events: [],
        pan_estimate: { moving_ratio: 0, mean_speed: 0, level: "static" },
      },
      audio: {
        has_audio: false,
        loudness_lufs: null,
        speech_ratio: null,
        music_detected: null,
        silence_ratio: null,
        // what the workers send for a video without an audio stream (style/audio.py)
        speech_method: null,
        music_method: null,
      },
      contact_sheet_path: "renders/style/x/contact_sheet.png",
      thumbnails: [],
      extra_field: 1,
    });
    expect(a.version).toBe(1);
    expect(a.warnings).toEqual([]);
  });
});

describe("compileStylePreset", () => {
  it("music volume only touches music clips, never the voice track or voice assets", () => {
    const base = project();
    const music = base.tracks[1]!;
    const audioTrack = (id: string, name: string, clipId: string, assetId: string) => ({
      ...music,
      id,
      name,
      clips: [{ ...music.clips[0]!, id: clipId, trackId: id, assetId, start: 0 }],
    });
    const p = project({
      tracks: [
        base.tracks[0]!,
        audioTrack("tvoz", "Voz", "v1", "a9"),
        audioTrack("tm", "Música", "mus", "lib1"),
        audioTrack("tx", "Audio 2", "tts", "a10"),
      ],
    });
    const names: Record<string, string> = { a9: "Entrevista (voz)", a10: "Voz (es): hola" };
    const plan = compileStylePreset(REELS, p, { asset: (id) => ({ name: names[id] ?? id }) });
    const vols = plan.ops.filter((o) => o.op === "set_volume");
    expect(vols).toEqual([expect.objectContaining({ clip: { id: "mus" }, volume_db: -16 })]);

    // No «Música» track: any audio clip that is not voice (by track name, asset id or name).
    const q = project({
      tracks: [
        base.tracks[0]!,
        audioTrack("t1", "Locución", "l1", "a1"),
        audioTrack("t2", "Audio 1", "s1", "stem-vocals-1"),
        audioTrack("t3", "Audio 2", "r1", "a11"),
        audioTrack("t4", "Audio 3", "bg", "a12"),
      ],
    });
    const qn: Record<string, string> = { a11: "Toma 3 (RVC luis)", a12: "Pista lofi" };
    const qplan = compileStylePreset(REELS, q, { asset: (id) => ({ name: qn[id] ?? id }) });
    expect(qplan.ops.filter((o) => o.op === "set_volume").map((o) => o.clip)).toEqual([
      { id: "bg" },
    ]);
  });

  it("maps every preset section to ops in a fixed order", () => {
    const plan = compileStylePreset(REELS, project(), { scenes: [0, 6.5, 13] });
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.ops.map((o) => o.op)).toEqual([
      "set_canvas",
      "cut_silences",
      "detect_scenes",
      "add_captions",
      "add_motion",
      "add_motion",
      "set_volume",
      "set_volume",
      "set_publish",
      "export",
    ]);
    const [canvas, cut, scenes, caps, title, lower, vol1, vol2, publish, exp] = plan.ops;
    expect(canvas).toMatchObject({ op: "set_canvas", preset: "9:16" });
    expect(cut).toMatchObject({ min_silence_ms: 300, padding_ms: 80, fillers: true });
    expect(scenes).toMatchObject({ op: "detect_scenes", split: true });
    expect(scenes!.note_es).toMatch(/1\.8 s/);
    expect(scenes!.note_es).toMatch(/deslizamiento cada 3 cortes/);
    expect(scenes!.note_es).toMatch(/×1\.2/);
    expect(scenes!.note_es!.length).toBeLessThanOrEqual(300);
    expect(caps).toMatchObject({ style: "reels", animated: true, language: "es" });
    expect(caps!.note_es).toMatch(/centro/);
    expect(title).toMatchObject({
      template: "title-card",
      t: 0,
      duration_s: 2,
      params: { title: "Hola", style: "pop" },
    });
    expect(lower).toMatchObject({ template: "lower-third", t: 6.5, params: { name: "Ana" } });
    // audio clips sorted by start (m1 at 0 s, then m2 at 8 s)
    expect(vol1).toMatchObject({ op: "set_volume", clip: { id: "m1" }, volume_db: -16 });
    expect(vol2).toMatchObject({ clip: { id: "m2" } });
    expect(publish).toMatchObject({ for_social: true, ai_label: true });
    expect(exp).toMatchObject({
      preset: "reels-tiktok",
      confirm: true,
      name: "estilo-reels-dinamico",
    });
    expect(ALWAYS_CONFIRM_OPS).toContain(exp!.op);
    expect(plan.summary_es).toMatch(/^Aplico el estilo «Reels dinámico»/);
    expect(stylePlanNotes(plan).length).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic", () => {
    const a = compileStylePreset(REELS, project(), { scenes: [13, 0, 6.5] });
    const b = compileStylePreset(REELS, project(), { scenes: [0, 6.5, 13] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("skips what does not apply: same canvas, no silences, no captions/title, no music", () => {
    const plan = compileStylePreset(
      {
        ...DEFAULT_STYLE_PRESET,
        cut_rhythm: {
          ...DEFAULT_STYLE_PRESET.cut_rhythm,
          remove_silences: false,
          target_shot_s: 8,
        },
        captions: { ...DEFAULT_STYLE_PRESET.captions, enabled: false },
        titles: { ...DEFAULT_STYLE_PRESET.titles, enabled: false },
      },
      project({
        tracks: project().tracks.filter((t) => t.kind === "video"),
      }),
    );
    expect(plan.ops.map((o) => o.op)).toEqual(["detect_scenes", "export"]);
    expect(plan.ops[0]).toMatchObject({ split: false });
    // music wanted but the project has none: the note says how to add it
    expect(plan.ops[0]!.note_es).toMatch(/Biblioteca/);
  });

  it("lower third without scenes goes at 2 s with a note; empty project -> export only", () => {
    const plan = compileStylePreset({ ...REELS, canvas: "16:9" }, project());
    const lower = plan.ops.find((o) => o.op === "add_motion" && o.template === "lower-third");
    expect(lower).toMatchObject({ t: 2 });
    expect(lower!.note_es).toMatch(/2 s/);
    const empty = compileStylePreset(
      { ...DEFAULT_STYLE_PRESET, music: { duck: false, volume_db: 0 } },
      project({ tracks: [] }),
    );
    expect(empty.ops.map((o) => o.op)).toEqual(["add_motion", "export"]);
  });

  it("canvasAspect", () => {
    expect(canvasAspect(1920, 1080)).toBe("16:9");
    expect(canvasAspect(1080, 1920)).toBe("9:16");
    expect(canvasAspect(1080, 1080)).toBe("1:1");
    expect(canvasAspect(1080, 1350)).toBeNull();
  });
});
