import { describe, expect, it } from "vitest";
import {
  bundledFontWeight,
  captionFontWeight,
  autofixCaptionStyle,
  balanceLines,
  BrandKitSchema,
  CAPTION_STYLE_PRESETS,
  captionLayout,
  captionMaxChars,
  captionStyleFromTokens,
  checkDesign,
  checkDesignWithFix,
  contrastRatio,
  DEFAULT_BRAND_KIT,
  DEFAULT_DESIGN_TOKENS,
  DesignTokensSchema,
  DESIGN_RULE_IDS,
  DesignCheckResultSchema,
  paginateCaptions,
  paginateSegments,
  ProjectSchema,
  resolveDesign,
  titleMinDuration,
  toDtcg,
  type CaptionStyle,
  type DesignAspect,
  type Project,
  type SubtitleSegment,
} from "../src/index.js";

const rules = DEFAULT_DESIGN_TOKENS.caption;

/** Natural Spanish speech: ~2.6 words/s, short pauses between sentences. */
const SENTENCES = [
  "Hola, hoy te muestro cómo editar un video para redes sin perder tiempo.",
  "Primero cortamos los silencios largos del principio.",
  "Después agregamos subtítulos grandes y fáciles de leer en el teléfono.",
  "Y al final exportamos en vertical para Reels y TikTok.",
];

function speech(sentences = SENTENCES, wps = 2.6, gap = 0.45): SubtitleSegment[] {
  let t = 0.3;
  return sentences.map((s) => {
    const words = s.split(" ").map((w) => {
      const d = (1 / wps) * Math.max(0.6, Math.min(1.6, w.length / 5));
      const word = { word: w, start: t, end: t + d * 0.9 };
      t += d;
      return word;
    });
    const seg = { start: words[0]!.start, end: words.at(-1)!.end, text: s, words };
    t += gap;
    return seg;
  });
}

function project(aspect: DesignAspect, extra: Partial<Project> = {}): Project {
  const [w, h] = aspect === "9:16" ? [1080, 1920] : aspect === "1:1" ? [1080, 1080] : [1920, 1080];
  return ProjectSchema.parse({
    id: "prj_test",
    name: "Prueba",
    settings: { width: w, height: h, fps: 30 },
    tracks: [
      {
        id: "trk_v",
        kind: "video",
        name: "Video",
        clips: [{ id: "clp_v", trackId: "trk_v", assetId: "ast_1", start: 0, in: 0, out: 15 }],
      },
      {
        id: "trk_m",
        kind: "motion",
        name: "Motion",
        clips: [
          {
            id: "clp_title",
            trackId: "trk_m",
            start: 0,
            in: 0,
            out: 3,
            motion: {
              template: "title-card",
              props: { title: "Editá más rápido", subtitle: "Tres pasos" },
              durationSec: 3,
            },
          },
          {
            id: "clp_lt",
            trackId: "trk_m",
            start: 4,
            in: 0,
            out: 4,
            motion: {
              template: "lower-third",
              props: { name: "Luis", role: "Happy House" },
              durationSec: 4,
            },
          },
        ],
      },
    ],
    subtitles: speech(),
    captionStyle: CAPTION_STYLE_PRESETS.find((p) => p.id === "reels"),
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...extra,
  });
}

describe("contrast (WCAG)", () => {
  it("known cases", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(contrastRatio("rgba(0,0,0,0.6)", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("resolveDesign", () => {
  it("1080×1920: caption 65 px, minimum 49 px, safe zone in px", () => {
    const r = resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1080, h: 1920 });
    expect(r.aspect).toBe("9:16");
    expect(r.caption_px.size).toBe(65);
    expect(r.caption_px.min_size).toBe(49);
    expect(r.caption_px.outline).toBe(5);
    expect(r.caption_px.max_chars_line).toBe(30);
    expect(r.safe_zone_px).toEqual({ top: 288, bottom: 672, left: 119, right: 119 });
  });
  it("aspects: 16:9 and 1:1", () => {
    expect(
      resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1920, h: 1080 }).caption_px.max_chars_line,
    ).toBe(42);
    expect(
      resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1080, h: 1080 }).caption_px.max_chars_line,
    ).toBe(34);
    expect(resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1920, h: 1080 }).safe_zone_px.bottom).toBe(
      108,
    );
  });
});

describe("paginateCaptions", () => {
  const words = speech([
    "Este es un texto bastante largo que tiene que partirse en varias páginas de subtítulos sin pasar nunca de dos líneas por página aunque la persona hable sin parar durante mucho rato.",
  ])[0]!.words!;

  it.each([
    ["9:16", 30],
    ["1:1", 34],
    ["16:9", 42],
  ] as const)("%s: never 3 lines, ≤ %i characters per line", (aspect, max) => {
    const pages = paginateCaptions(words, rules, aspect);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.lines.length).toBeLessThanOrEqual(2);
      for (const l of p.lines) expect(l.length).toBeLessThanOrEqual(max);
    }
    // Every word appears once, in order.
    expect(pages.map((p) => p.text).join(" ")).toBe(words.map((w) => w.word).join(" "));
  });

  it("does not split «el auto» across lines", () => {
    const lines = balanceLines(
      "Ayer compré el auto nuevo".split(" ").map((text) => ({ text })),
      14,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith(" el")).toBe(false);
    const preps = balanceLines(
      "Fuimos con la familia de vacaciones".split(" ").map((text) => ({ text })),
      20,
    );
    expect(preps[0]).not.toMatch(/ (con|la|de)$/);
  });

  it("does not leave a weak word at the end of a page", () => {
    for (const aspect of ["9:16", "16:9"] as const)
      for (const p of paginateCaptions(words, rules, aspect))
        expect(
          p.words.length === 1 || !/^(el|la|de|y|en|que|un|sin)$/i.test(p.words.at(-1)!.text),
        ).toBe(true);
  });

  it("cuts on a pause ≥ 300 ms", () => {
    const w = [
      { word: "Hola", start: 0, end: 0.4 },
      { word: "qué", start: 0.45, end: 0.7 },
      { word: "tal", start: 1.2, end: 1.5 },
    ];
    const pages = paginateCaptions(w, rules, "16:9");
    expect(pages.map((p) => p.text)).toEqual(["Hola qué", "tal"]);
  });

  it("cuts at the end of a sentence", () => {
    const pages = paginateCaptions(speech(["Uno dos. Tres cuatro."])[0]!.words!, rules, "16:9");
    expect(pages.map((p) => p.text)).toEqual(["Uno dos.", "Tres cuatro."]);
  });

  it("pages last 0.83–7 s and ≤ 17 cps (except karaoke)", () => {
    const segs = speech();
    for (const aspect of ["9:16", "16:9"] as const) {
      const pages = paginateSegments(segs, rules, aspect);
      for (const p of pages) {
        const d = p.end - p.start;
        expect(d).toBeGreaterThanOrEqual(0.83 - 1e-9);
        expect(d).toBeLessThanOrEqual(7);
        expect(p.text.length / d).toBeLessThanOrEqual(17 + 1e-6);
      }
    }
    // Karaoke keeps the measured word timings (no reading-speed stretch).
    const fast = [{ word: "supercalifragilístico", start: 0, end: 0.9 }];
    const k = paginateCaptions(fast, rules, "16:9", { karaoke: true, limitEnd: 10 });
    expect(k[0]!.end).toBeCloseTo(0.9);
    const n = paginateCaptions(fast, rules, "16:9", { limitEnd: 10 });
    expect(n[0]!.text.length / (n[0]!.end - n[0]!.start)).toBeLessThanOrEqual(17 + 1e-6);
  });

  it("never stretches over the next page", () => {
    const w = [
      { word: "Sí.", start: 0, end: 0.2 },
      { word: "No.", start: 0.5, end: 0.7 },
    ];
    const pages = paginateCaptions(w, rules, "16:9");
    expect(pages[0]!.end).toBeLessThanOrEqual(pages[1]!.start);
  });
});

describe("caption style from tokens", () => {
  it("kit mode: family of the kit, size never below the minimum, outline 8 %", () => {
    const minimal = CAPTION_STYLE_PRESETS.find((p) => p.id === "minimal")!;
    const eff = captionStyleFromTokens(DEFAULT_DESIGN_TOKENS, minimal);
    expect(eff.fontFamily).toBe("Inter");
    expect(eff.fontSize).toBeCloseTo(48.6);
    expect(eff.outlineWidth).toBeCloseTo(3.9);
    expect(eff.outlineColor).toBe("#000000");
  });
  it("max chars shrink to fit the safe width at the style size", () => {
    const r = resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1080, h: 1920 });
    const reels = captionStyleFromTokens(DEFAULT_DESIGN_TOKENS, CAPTION_STYLE_PRESETS[1]);
    const n = captionMaxChars(reels, r);
    expect(n).toBeLessThan(30);
    expect(n).toBeGreaterThanOrEqual(12);
    const lay = captionLayout(reels, r, 2);
    expect(lay.blockTop).toBeGreaterThanOrEqual(r.safe_zone_px.top);
    expect(lay.blockBottom).toBeLessThanOrEqual(1920 - r.safe_zone_px.bottom);
  });
});

describe("checkDesign", () => {
  it("returns exactly the 10 rules and validates against the schema", () => {
    const res = checkDesign(project("9:16"), DEFAULT_BRAND_KIT);
    expect(res.rules.map((r) => r.id)).toEqual([...DESIGN_RULE_IDS]);
    expect(res.rules).toHaveLength(10);
    expect(() => DesignCheckResultSchema.parse(res)).not.toThrow();
  });

  it.each(["9:16", "16:9"] as const)("default project %s = 10/10", (aspect) => {
    const res = checkDesign(project(aspect), DEFAULT_BRAND_KIT);
    expect(res.issues).toEqual([]);
    expect(res.passed).toBe(10);
  });

  it.each(
    CAPTION_STYLE_PRESETS.flatMap((p) =>
      (["9:16", "16:9"] as const).map((a) => [p.id, a] as const),
    ),
  )("preset %s passes in %s without changes", (id, aspect) => {
    const style = CAPTION_STYLE_PRESETS.find((p) => p.id === id)!;
    const res = checkDesign(project(aspect, { captionStyle: style }), DEFAULT_BRAND_KIT);
    expect(res.issues).toEqual([]);
    expect(res.passed).toBe(10);
  });

  it("a 30 px style without outline fails 2 rules and autofix repairs them", () => {
    const bad: CaptionStyle = {
      ...CAPTION_STYLE_PRESETS[0]!,
      fontSize: 30,
      background: "",
      outlineWidth: 0,
      fromBrandKit: false,
    };
    const p = project("9:16", { captionStyle: bad });
    const res = checkDesign(p, DEFAULT_BRAND_KIT);
    expect(
      res.rules
        .filter((r) => !r.passed)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["caption.min_size", "caption.outline_or_box"]);
    expect(res.passed).toBe(8);
    expect(res.issues.every((i) => i.autofix && i.severity === "hard")).toBe(true);
    const { fixed, fixedCount } = checkDesignWithFix(p, DEFAULT_BRAND_KIT);
    expect(fixedCount).toBe(2);
    expect(checkDesign(fixed, DEFAULT_BRAND_KIT).passed).toBe(10);
    // autofixCaptionStyle alone does the same.
    const r = resolveDesign(DEFAULT_DESIGN_TOKENS, { w: 1080, h: 1920 });
    const f = autofixCaptionStyle(bad, r);
    expect(f.fontSize).toBeGreaterThanOrEqual(49);
    expect(f.outlineWidth).toBeGreaterThan(0);
  });

  it("low contrast and an unbundled font are reported", () => {
    const bad: CaptionStyle = {
      ...CAPTION_STYLE_PRESETS[0]!,
      fontFamily: "Comic Sans MS",
      color: "#777777",
      background: "#666666",
      fromBrandKit: false,
    };
    const res = checkDesign(project("16:9", { captionStyle: bad }), DEFAULT_BRAND_KIT);
    const failed = res.rules.filter((r) => !r.passed).map((r) => r.id);
    expect(failed).toContain("caption.contrast");
    expect(failed).toContain("brand.consistency");
    const fix = checkDesignWithFix(project("16:9", { captionStyle: bad }), DEFAULT_BRAND_KIT);
    const again = checkDesign(fix.fixed, DEFAULT_BRAND_KIT);
    expect(again.rules.find((r) => r.id === "caption.contrast")!.passed).toBe(true);
  });

  it("a lower-third with an explicit margin under the safe zone fails title.safe_zone (fixable)", () => {
    const p = project("9:16");
    const lt = p.tracks[1]!.clips[1]!;
    lt.motion!.props = { ...lt.motion!.props, marginPct: 6 };
    const res = checkDesign(p, DEFAULT_BRAND_KIT);
    expect(res.rules.find((r) => r.id === "title.safe_zone")!.passed).toBe(false);
    const { fixed } = checkDesignWithFix(p, DEFAULT_BRAND_KIT);
    expect(checkDesign(fixed, DEFAULT_BRAND_KIT).passed).toBe(10);
    // The same margin in 16:9 (5 % / 10 %) also fails: bottom needs 10 %.
    expect(
      checkDesign(p, DEFAULT_BRAND_KIT, "16:9").rules.find((r) => r.id === "title.safe_zone")!
        .passed,
    ).toBe(false);
  });

  it("title.duration is a guide: a 0.8 s title is reported, not fixed", () => {
    const p = project("16:9");
    const title = p.tracks[1]!.clips[0]!;
    title.out = 0.8;
    const res = checkDesign(p, DEFAULT_BRAND_KIT);
    const iss = res.issues.filter((i) => i.rule === "title.duration");
    expect(iss).toHaveLength(1);
    expect(iss[0]!.severity).toBe("guide");
    expect(iss[0]!.autofix).toBe(false);
    expect(titleMinDuration("Editá más rápido Tres pasos", DEFAULT_DESIGN_TOKENS)).toBeCloseTo(
      2.45,
    );
  });

  it("a kinetic title adds a third family (guide)", () => {
    const p = project("9:16");
    p.tracks[1]!.clips.push({
      ...p.tracks[1]!.clips[0]!,
      id: "clp_kin",
      start: 9,
      motion: {
        ...p.tracks[1]!.clips[0]!.motion!,
        template: "kinetic-typography",
        props: { text: "Uno dos tres" },
      },
    });
    const res = checkDesign(p, DEFAULT_BRAND_KIT);
    expect(res.rules.find((r) => r.id === "brand.consistency")!.passed).toBe(false);
  });

  it("a kit with other tokens changes the verdict (tokens, not constants)", () => {
    const kit = BrandKitSchema.parse({
      ...DEFAULT_BRAND_KIT,
      tokens: {
        ...DEFAULT_DESIGN_TOKENS,
        caption: { ...DEFAULT_DESIGN_TOKENS.caption, min_size_pct_short_side: 8 },
      },
    });
    const bad = { ...CAPTION_STYLE_PRESETS[0]!, fromBrandKit: false };
    expect(
      checkDesign(project("9:16", { captionStyle: bad }), kit).rules.find(
        (r) => r.id === "caption.min_size",
      )!.passed,
    ).toBe(false);
  });
});

describe("toDtcg", () => {
  it("exports colors and fonts", () => {
    const d = toDtcg(DEFAULT_DESIGN_TOKENS) as { color: { accent: { $value: string } } };
    expect(d.color.accent.$value).toBe("#FFD400");
  });
});

describe("caption font weight (audit S6 E1)", () => {
  const withCaption = (family: string, weight: 400 | 700 | 900) =>
    DesignTokensSchema.parse({
      ...DEFAULT_DESIGN_TOKENS,
      font: { ...DEFAULT_DESIGN_TOKENS.font, caption: { family, weight } },
    });
  it("maps a weight to a face that exists (no synthetic bold)", () => {
    expect(bundledFontWeight("Inter", 900)).toBe(900);
    expect(bundledFontWeight("Oswald", 900)).toBe(700);
    expect(bundledFontWeight("Bangers", 900)).toBe(400);
    expect(bundledFontWeight("Anton", 700)).toBe(400);
    expect(bundledFontWeight("Arial", 900)).toBe(900);
  });
  it("kit style → kit weight; own style (fromBrandKit:false) → bold of its family", () => {
    expect(captionFontWeight(withCaption("Inter", 900))).toBe(900);
    expect(captionFontWeight(withCaption("Inter", 400))).toBe(400);
    expect(captionFontWeight(withCaption("Bebas Neue", 900))).toBe(400);
    const own = { ...CAPTION_STYLE_PRESETS[0]!, fontFamily: "Bangers", fromBrandKit: false };
    expect(captionFontWeight(withCaption("Inter", 900), own)).toBe(400);
    expect(captionFontWeight(withCaption("Inter", 900), { ...own, fontFamily: "Roboto" })).toBe(
      700,
    );
  });
});

describe("caption timing at conversational speed (audit S6 E4)", () => {
  const lex = (
    "hola hoy vamos a ver cómo se hace esto porque la verdad es que mucha gente me pregunta " +
    "todos los días cómo editar un video sin perder tiempo y entonces decidí mostrarlo paso por " +
    "paso con un ejemplo real"
  ).split(" ");
  /** 40 s of speech at `wps` words/s, sentences of 12 words, 0,35 s pauses. */
  function speech(wps: number) {
    let t = 0.3;
    let i = 0;
    const segs: SubtitleSegment[] = [];
    while (t < 40) {
      const words = [];
      for (let k = 0; k < 12; k++) {
        const w = lex[i++ % lex.length]!;
        const d = (1 / wps) * Math.max(0.6, Math.min(1.6, w.length / 5));
        words.push({
          word: w + (k === 11 ? "." : ""),
          start: +t.toFixed(3),
          end: +(t + d * 0.9).toFixed(3),
        });
        t += d;
      }
      segs.push({
        start: words[0]!.start,
        end: words.at(-1)!.end,
        text: words.map((w) => w.word).join(" "),
        words,
      });
      t += 0.35;
    }
    return segs;
  }
  const projectWith = (subtitles: SubtitleSegment[]) =>
    ({
      id: "p",
      name: "x",
      settings: { width: 1080, height: 1920, fps: 30 },
      tracks: [],
      subtitles,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as Project;

  it("3 words/s passes caption.timing (pages borrow time from their neighbours)", () => {
    for (const wps of [2.6, 3]) {
      const c = checkDesignWithFix(projectWith(speech(wps)), DEFAULT_BRAND_KIT, "9:16");
      expect(
        c.result.issues.filter((x) => x.rule === "caption.timing"),
        `${wps}`,
      ).toEqual([]);
    }
  });

  it("rebalanced pages never overlap and stay near their words", () => {
    const pages = paginateSegments(speech(3), DEFAULT_DESIGN_TOKENS.caption, "9:16", {
      maxChars: 22,
    });
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k]!;
      if (k) expect(p.start).toBeGreaterThanOrEqual(pages[k - 1]!.end - 1e-6);
      expect(p.start).toBeGreaterThanOrEqual(p.words[0]!.start - 0.5 - 1e-6);
      expect(p.start).toBeLessThanOrEqual(p.words[0]!.start + 0.3 + 1e-6);
      expect(p.text.length / (p.end - p.start)).toBeLessThanOrEqual(17.05);
    }
  });
});
