import { describe, expect, it } from "vitest";
import {
  API_ROUTES,
  ApplyCutsRequestSchema,
  BrandKitSchema,
  BrandKitUpdateSchema,
  BUNDLED_FONT_FAMILIES,
  CaptionStyleSchema,
  ClipSchema,
  DEFAULT_BRAND_KIT,
  DEFAULT_DESIGN_TOKENS,
  DESIGN_RULE_IDS,
  DESIGN_RULES,
  DesignCheckRequestSchema,
  DesignCheckResultSchema,
  DesignTokensSchema,
  EditOpSchema,
  FILLER_LEXICON_ES,
  FitDurationPreviewSchema,
  FitDurationRequestSchema,
  formatErrorEs,
  GLOSSARY_ES,
  HexColorSchema,
  HOTKEYS,
  ImportAnalysisSchema,
  ImportSuggestionSchema,
  JobTypeSchema,
  MotionStillRequestSchema,
  ProjectSettingsSchema,
  SCRIPT_HOTKEYS,
  SCRIPT_INTERCEPTED_KEYS,
  ScriptCutsRequestSchema,
  ScriptSchema,
  ScriptTranscribeRequestSchema,
  SPRINT6_ERRORS,
  SPRINT6_MODULES,
  StylePresetDraftSchema,
  SubtitleWordSchema,
  SUGGESTION_THRESHOLDS,
  SuggestionSettingsSchema,
  UI_ENGLISH_DENYLIST,
  validateEditPlan,
  WORKER_TASK_ROUTES,
  WordSchema,
  WorkerSttWordsRequestSchema,
  WorkerSttWordsResultSchema,
  WorkerSuggestAnalyzeRequestSchema,
  WorkerSuggestAnalyzeResultSchema,
} from "../src/index.js";

const NOW = "2026-10-18T12:00:00.000Z";
const plan = (ops: unknown[]) => ({ version: 1, summary_es: "Plan", ops });

describe("sprint 6: design tokens and brand kit (M2)", () => {
  it("defaults are valid and follow the agreed hard rules", () => {
    expect(DesignTokensSchema.parse(DEFAULT_DESIGN_TOKENS)).toEqual(DEFAULT_DESIGN_TOKENS);
    const c = DEFAULT_DESIGN_TOKENS.caption;
    expect(c.max_lines).toBe(2);
    expect(c.max_chars_line).toEqual({ "9:16": 30, "1:1": 34, "16:9": 42 });
    expect(c.min_size_pct_short_side).toBe(4.5);
    expect(c.size_pct_short_side).toBe(6);
    expect(c.min_contrast).toBe(7);
    expect(DEFAULT_DESIGN_TOKENS.safe_zone["9:16"]).toEqual({
      top: 15,
      bottom: 35,
      left: 11,
      right: 11,
    });
    expect(BrandKitSchema.parse(DEFAULT_BRAND_KIT).logo_position).toBe("top-right");
  });

  it("rejects fonts that are not bundled, bad colors and extra fields", () => {
    const bad = structuredClone(DEFAULT_DESIGN_TOKENS) as unknown as {
      font: { title: { family: string } };
    };
    bad.font.title.family = "Comic Sans";
    expect(DesignTokensSchema.safeParse(bad).success).toBe(false);
    expect(HexColorSchema.safeParse("#FFD400").success).toBe(true);
    expect(HexColorSchema.safeParse("#000000B3").success).toBe(true);
    expect(HexColorSchema.safeParse("red").success).toBe(false);
    expect(DesignTokensSchema.safeParse({ ...DEFAULT_DESIGN_TOKENS, extra: 1 }).success).toBe(
      false,
    );
    expect(BUNDLED_FONT_FAMILIES).toHaveLength(10);
  });

  it("kit update is partial and strict; the checklist has exactly 10 rules", () => {
    expect(BrandKitUpdateSchema.parse({ name: "Canal" })).toEqual({ name: "Canal" });
    expect(BrandKitUpdateSchema.safeParse({ id: "default" }).success).toBe(false);
    expect(DESIGN_RULE_IDS).toHaveLength(10);
    expect(DESIGN_RULES.map((r) => r.id)).toEqual([...DESIGN_RULE_IDS]);
    expect(DESIGN_RULES.filter((r) => r.severity === "hard")).toHaveLength(8);
    expect(DesignCheckRequestSchema.parse({ projectId: "p1" }).fix).toBe(false);
    const rules = DESIGN_RULE_IDS.map((id) => ({ id, passed: true, issues: 0 }));
    expect(
      DesignCheckResultSchema.parse({
        aspect: "9:16",
        rules,
        passed: 10,
        issues: [],
        fixed: 0,
        checkedAt: NOW,
      }).passed,
    ).toBe(10);
    expect(
      DesignCheckResultSchema.safeParse({
        aspect: "9:16",
        rules: rules.slice(1),
        passed: 9,
        issues: [],
        fixed: 0,
        checkedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("still requests, caption style tokens and style presets", () => {
    const r = MotionStillRequestSchema.parse({ template: "title-card", width: 1080, height: 1920 });
    expect(r.format).toBe("png");
    expect(r.brand).toBe(true);
    expect(
      MotionStillRequestSchema.safeParse({ template: "x", width: 9000, height: 10 }).success,
    ).toBe(false);
    const base = {
      id: "x",
      name: "X",
      fontFamily: "Inter",
      fontSize: 60,
      color: "#fff",
      background: "",
      highlightColor: "#fff",
      position: "bottom",
      uppercase: false,
      animation: "none",
    };
    expect(CaptionStyleSchema.parse(base).fromBrandKit).toBeUndefined();
    expect(CaptionStyleSchema.safeParse({ ...base, maxLines: 3 }).success).toBe(false);
    expect(StylePresetDraftSchema.shape.use_brand_kit).toBeDefined();
  });
});

describe("sprint 6: script (M1)", () => {
  const word = { id: "0:1", text: "eh,", norm: "eh", start: 1, end: 1.2, segment: 0 };

  it("words, script view and requests", () => {
    expect(WordSchema.parse(word).id).toBe("0:1");
    expect(WordSchema.safeParse({ ...word, id: "w1" }).success).toBe(false);
    expect(WordSchema.safeParse({ ...word, end: 0.5 }).success).toBe(false);
    const s = ScriptSchema.parse({
      version: 1,
      projectId: "p1",
      language: "es",
      words: [
        {
          ...word,
          filler: { category: "vocalization", level: "safe", confidence: 0.9, reason_es: "x" },
        },
      ],
      pauses: [{ kind: "pause", after: "0:1", start: 1.2, end: 2, long: true }],
      stats: {
        words: 1,
        duration_s: 2,
        long_pauses: 1,
        fillers: { safe: 1, probable: 0, doubtful: 0 },
      },
    });
    expect(s.stale).toBe(false);
    expect(ScriptTranscribeRequestSchema.parse({ clipId: "c1" })).toMatchObject({
      language: "es",
      keepFillers: true,
    });
    expect(ScriptCutsRequestSchema.safeParse({}).success).toBe(false);
    expect(ScriptCutsRequestSchema.parse({ fillers: "safe" }).avoidHarsh).toBe(true);
    expect(FitDurationRequestSchema.parse({ target_s: 45 })).toMatchObject({
      tolerance_s: 0.5,
      allow_speedup: false,
      allow_sentences: false,
    });
    expect(
      FitDurationPreviewSchema.parse({ from_s: 62, to_s: 45, reached: true, groups: [], cuts: [] })
        .reached,
    ).toBe(true);
    expect(
      SubtitleWordSchema.parse({ start: 0, end: 1, word: "x", corrected: true }).corrected,
    ).toBe(true);
    expect(FILLER_LEXICON_ES.filter((f) => f.level === "safe").length).toBeGreaterThanOrEqual(5);
    // Audit S6 E3: «ah» can be an answer («Ah, entendí»): never safe.
    expect(FILLER_LEXICON_ES.find((f) => f.text === "ah")?.level).toBe("probable");
    for (const f of FILLER_LEXICON_ES) expect(f.text).toBe(f.text.toLowerCase());
  });

  it("worker stt.words contract", () => {
    const req = WorkerSttWordsRequestSchema.parse({
      input_path: "media/a.mp4",
      output_base: "renders/j1",
    });
    expect(req.hallucination_silence_threshold).toBe(2);
    const res = WorkerSttWordsResultSchema.parse({
      transcript: { language: "es", durationSec: 3, segments: [] },
      audio: {
        noise_floor_db: -55,
        window_ms: 5,
        rms_db_path: "renders/j1/script-rms.f32",
        gaps: [{ start: 1, end: 1.4, rms_db: -30, voiced: true }],
      },
    });
    expect(res.audio.gaps[0]!.voiced).toBe(true);
  });

  it("new EditPlan ops validate (and need some target)", () => {
    expect(
      validateEditPlan(
        plan([
          { op: "delete_words", ranges: [{ start: 1, end: 1.4 }] },
          { op: "fit_duration", target_s: 45, allow_sentences: true },
          { op: "fix_text", find: "haber", replace: "a ver", at: 12 },
        ]),
      ).ok,
    ).toBe(true);
    const empty = validateEditPlan(plan([{ op: "delete_words" }]));
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(" ")).toMatch(/ranges, text, fillers o long_pauses/);
    expect(
      validateEditPlan(plan([{ op: "delete_words", ranges: [{ start: 2, end: 1 }] }])).ok,
    ).toBe(false);
    expect(validateEditPlan(plan([{ op: "fit_duration", target_s: 1 }])).ok).toBe(false);
    expect(EditOpSchema.safeParse({ op: "fix_text", find: "", replace: "x" }).success).toBe(false);
  });

  it("apply-cuts timeline mode and clip audio fades", () => {
    const r = ApplyCutsRequestSchema.parse({
      projectId: "p",
      clipId: "c",
      cuts: [{ start: 1, end: 2 }],
    });
    expect(r.mode).toBe("clip");
    expect(
      ApplyCutsRequestSchema.safeParse({ ...r, mode: "timeline", joinFadeMs: 40 }).success,
    ).toBe(false);
    const clip = ClipSchema.parse({
      id: "c",
      trackId: "t",
      start: 0,
      out: 3,
      audioFade: { inMs: 12, outMs: 12 },
    });
    expect(clip.audioFade).toEqual({ inMs: 12, outMs: 12 });
  });

  it("script hotkeys live in their own scope", () => {
    expect(HOTKEYS).toHaveLength(32);
    const ids = SCRIPT_HOTKEYS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const editorKeys = new Set(HOTKEYS.map((h) => h.keys.toLowerCase()));
    for (const h of SCRIPT_HOTKEYS) {
      expect(h.scope).toBe("script");
      expect(h.help_es.length).toBeGreaterThan(8);
      if (editorKeys.has(h.keys.toLowerCase())) expect(SCRIPT_INTERCEPTED_KEYS).toContain(h.keys);
    }
  });
});

describe("sprint 6: suggestions (M3)", () => {
  const suggestion = {
    id: "s1",
    projectId: "p1",
    assetId: "a1",
    clipIds: ["c1"],
    kind: "silences",
    status: "open",
    title_es: "3 silencios largos = 3,5 s de 0:12",
    detail_es: "",
    impact: { seconds_saved: 3.5, count: 3 },
    plan: plan([{ op: "cut_silences", clip: { id: "c1" }, min_silence_ms: 500 }]),
    params_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };

  it("suggestion, analysis and settings", () => {
    expect(ImportSuggestionSchema.parse(suggestion).kind).toBe("silences");
    expect(ImportSuggestionSchema.safeParse({ ...suggestion, kind: "scenes" }).success).toBe(false);
    expect(ImportSuggestionSchema.safeParse({ ...suggestion, plan: plan([]) }).success).toBe(false);
    expect(
      ImportAnalysisSchema.parse({
        assetId: "a1",
        params_version: SUGGESTION_THRESHOLDS.params_version,
        file_sig: { size: 10, mtime_ms: 1 },
        duration_s: 12,
        noise_floor_db: -60,
        silence_threshold_db: -50,
        silences: [{ start: 3, end: 6.5 }],
        lufs_i: -30,
        lra: 5,
        true_peak_db: -6,
        analyzed_at: NOW,
      }).lufs_i,
    ).toBe(-30);
    expect(SuggestionSettingsSchema.parse({})).toEqual({ enabled: true, mutedKinds: [] });
    expect(SUGGESTION_THRESHOLDS.background_priority).toBeLessThan(0);
  });

  it("worker suggest.analyze contract", () => {
    expect(WorkerSuggestAnalyzeRequestSchema.parse({ input_path: "media/a.mp4" })).toMatchObject({
      silence_min_ms: 500,
      silence_rel_db: 9,
      priority: 5,
    });
    expect(
      WorkerSuggestAnalyzeResultSchema.parse({
        duration_s: 12,
        noise_floor_db: -60,
        silence_threshold_db: -50,
        silences: [[3, 6.5]],
        lufs_i: null,
        lra: null,
        true_peak_db: null,
      }).silences,
    ).toEqual([[3, 6.5]]);
  });
});

describe("sprint 6: shared plumbing", () => {
  it("jobs, routes, worker task areas and errors", () => {
    expect(JobTypeSchema.options).toContain("script.transcribe");
    expect(JobTypeSchema.options).toContain("suggest.analyze");
    expect(API_ROUTES.scriptCuts).toBe("/api/projects/:id/script/cuts");
    expect(API_ROUTES.brandKit).toBe("/api/brand-kit");
    expect(API_ROUTES.suggestionPlan).toBe("/api/projects/:id/suggestions/:sid/plan");
    expect(WORKER_TASK_ROUTES.transcribe).toBe("/transcribe/tasks/:id");
    expect(WORKER_TASK_ROUTES.analyze).toBe("/analyze/tasks/:id");
    expect(SPRINT6_ERRORS.NOT_IMPLEMENTED.status).toBe(501);
    expect(formatErrorEs("NOT_IMPLEMENTED", { modulo: SPRINT6_MODULES.M2 })).toBe(
      "Todavía no está disponible (M2 Sistema de diseño).",
    );
    expect(formatErrorEs("FONT_NOT_BUNDLED", { familia: "Arial" })).toMatch(/«Arial»/);
    expect(formatErrorEs("DESIGN_AUTOFIXED", { n: 3 })).toMatch(/^Ajusté 3 /);
  });

  it("canvas max (MEJORAS B7), glossary and deny list", () => {
    expect(ProjectSettingsSchema.safeParse({ width: 20000, height: 20000 }).success).toBe(false);
    expect(ProjectSettingsSchema.parse({ width: 1080, height: 1920 }).height).toBe(1920);
    expect(GLOSSARY_ES.settings.packs).toBe("Paquetes de IA");
    expect(GLOSSARY_ES.panels.script).toBe("Guion");
    expect(UI_ENGLISH_DENYLIST).toContain("bottom-left");
  });
});
