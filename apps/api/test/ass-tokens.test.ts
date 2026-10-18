import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CAPTION_STYLE_PRESETS,
  DEFAULT_DESIGN_TOKENS,
  DEFAULT_EXPORT_PRESETS,
  DesignTokensSchema,
  ExportPresetSchema,
  ProjectSchema,
} from "@studio/shared";
import { BUNDLED_FONTS_DIR } from "@studio/remotion";
import { afterEach, describe, expect, it } from "vitest";
import { assSubtitlesFilter, buildAss, setAssDesign } from "../src/services/ffmpeg/ass.js";
import { ensureAssFontsDir } from "../src/services/design/fonts.js";
import { compileExport, type TimelineAsset } from "../src/services/ffmpeg/timeline.js";
import { tempStorage } from "./helpers.js";

const SPEECH = [
  {
    start: 0.2,
    end: 3.6,
    text: "Hola, hoy te muestro cómo lavar el auto en casa sin gastar de más ni perder tiempo.",
  },
];

const styleLine = (ass: string) =>
  ass
    .split("\n")
    .find((l) => l.startsWith("Style: "))!
    .slice(7)
    .split(",");
const events = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue: "));

describe("ASS from the design tokens (Sprint 6 M2)", () => {
  afterEach(() => setAssDesign({ tokens: () => DEFAULT_DESIGN_TOKENS, fontsDir: null }));

  it("9:16 kit style: Fontname, Fontsize = 6 % of the short side, Outline 8 %, safe-zone margins", () => {
    const ass = buildAss(SPEECH, { canvas: { width: 1080, height: 1920 } });
    const s = styleLine(ass);
    expect(s[1]).toBe("Inter");
    expect(Number(s[2])).toBe(65);
    expect(s[7]).toBe("900");
    expect(Number(s[16])).toBe(5);
    expect(s.slice(19, 22).map(Number)).toEqual([119, 119, 672]);
    expect(ass).toContain("WrapStyle: 2");
    expect(ass).toContain("ScaledBorderAndShadow: yes");
    for (const e of events(ass)) {
      const text = e.split(",,").at(-1)!;
      const lines = text.split("\\N");
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
      expect(text).not.toMatch(/ el\\N/);
    }
  });

  it("16:9: 42 characters per line and the 16:9 safe zone (10 % bottom)", () => {
    const ass = buildAss(SPEECH, {
      canvas: { width: 1920, height: 1080 },
      style: CAPTION_STYLE_PRESETS[0],
    });
    const s = styleLine(ass);
    expect(Number(s[2])).toBe(54);
    expect(Number(s[21])).toBe(108);
    // Box style (clásico): BorderStyle 3.
    expect(s[15]).toBe("3");
    for (const e of events(ass))
      for (const l of e.split(",,").at(-1)!.split("\\N")) expect(l.length).toBeLessThanOrEqual(42);
  });

  it("hard rules are auto-fixed on generation (30 px without outline)", () => {
    const bad = {
      ...CAPTION_STYLE_PRESETS[2]!,
      fontSize: 30,
      outlineWidth: 0,
      fromBrandKit: false,
    };
    const s = styleLine(buildAss(SPEECH, { canvas: { width: 1080, height: 1920 }, style: bad }));
    expect(Number(s[2])).toBeGreaterThanOrEqual(49);
    expect(Number(s[16])).toBeGreaterThan(0);
  });

  it("tokens of the registered kit drive the style", () => {
    const tokens = DesignTokensSchema.parse({
      ...DEFAULT_DESIGN_TOKENS,
      font: { ...DEFAULT_DESIGN_TOKENS.font, caption: { family: "Poppins", weight: 700 } },
      caption: { ...DEFAULT_DESIGN_TOKENS.caption, size_pct_short_side: 7 },
    });
    setAssDesign({ tokens: () => tokens });
    const s = styleLine(buildAss(SPEECH, { canvas: { width: 1080, height: 1920 } }));
    expect(s[1]).toBe("Poppins");
    expect(s[7]).toBe("700");
    expect(Number(s[2])).toBe(76);
  });

  it("subtitles filter carries fontsdir with an escaped absolute path (spaces, tildes, C:)", () => {
    expect(assSubtitlesFilter("subs.ass", null)).toBe("subtitles=subs.ass");
    expect(assSubtitlesFilter("subs.ass", "C:\\Users\\José Pérez\\Studio\\tmp\\fonts-ass")).toBe(
      "subtitles=subs.ass:fontsdir='C\\:/Users/José Pérez/Studio/tmp/fonts-ass'",
    );
  });

  it("the export graph burns with fontsdir", () => {
    const dir = ensureAssFontsDir(tempStorage());
    expect(dir).toBeTruthy();
    setAssDesign({ fontsDir: dir });
    const preset = ExportPresetSchema.parse(
      DEFAULT_EXPORT_PRESETS.find((p) => p.id === "reels-tiktok")!,
    );
    const assets = new Map<string, TimelineAsset>([
      [
        "v1",
        {
          id: "v1",
          absPath: "/s/v1.mp4",
          kind: "video",
          hasVideo: true,
          hasAudio: true,
          durationSec: 5,
        },
      ],
    ]);
    const project = ProjectSchema.parse({
      id: "p1",
      name: "p",
      settings: { width: 1080, height: 1920 },
      tracks: [
        {
          id: "t1",
          kind: "video",
          name: "V",
          clips: [{ id: "c1", trackId: "t1", assetId: "v1", start: 0, in: 0, out: 4 }],
        },
      ],
      subtitles: SPEECH,
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
    });
    const c = compileExport({ project, preset, assets, output: "/s/out.mp4" });
    expect(c.graph).toMatch(/subtitles=subs\.ass:fontsdir='[^']*fonts-ass'/);
    expect(c.files.find((f) => f.name === "subs.ass")!.content).toContain(
      "Style: Default,Inter,65",
    );
  });

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("libass draws the bundled family from fontsdir (no system font)", () => {
    const work = tempStorage("studio-ass-");
    const fontsDir = ensureAssFontsDir(work)!;
    const render = (family: string, withDir: boolean) => {
      const d = path.join(work, `${family.replace(/ /g, "")}-${withDir}`);
      mkdirSync(d, { recursive: true });
      const tokens = DesignTokensSchema.parse({
        ...DEFAULT_DESIGN_TOKENS,
        font: { ...DEFAULT_DESIGN_TOKENS.font, caption: { family, weight: 400 } },
      });
      writeFileSync(
        path.join(d, "subs.ass"),
        buildAss([{ start: 0, end: 2, text: "Hola mundo" }], {
          canvas: { width: 540, height: 960 },
          tokens,
        }),
      );
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=gray:s=540x960:d=1",
          "-vf",
          assSubtitlesFilter("subs.ass", withDir ? fontsDir : null),
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
          "out.raw",
        ],
        { cwd: d },
      );
      return readFileSync(path.join(d, "out.raw"));
    };
    const diff = (a: Buffer, b: Buffer) =>
      a.reduce((n, v, i) => n + (Math.abs(v - b[i]!) > 40 ? 1 : 0), 0);
    // Bangers is not a system font: with fontsdir it renders differently than the fallback.
    expect(diff(render("Bangers", true), render("Bangers", false))).toBeGreaterThan(200);
    // Two bundled families differ from each other through fontsdir.
    expect(diff(render("Bangers", true), render("Playfair Display", true))).toBeGreaterThan(200);
    expect(BUNDLED_FONTS_DIR).toMatch(/public[\\/]fonts$/);
  });
});
