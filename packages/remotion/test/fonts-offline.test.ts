import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_FONT_FAMILIES,
  BUNDLED_FONT_WEIGHTS,
  DEFAULT_BRAND_KIT,
  FONTS_DIR_REL,
} from "@studio/shared";
import { describe, expect, it } from "vitest";
import { BUNDLED_FONT_FILES } from "../src/font-files.js";
import { BUNDLED_FONTS_DIR, fontFilesFor } from "../src/fonts-node.js";
import { FONT_FAMILIES } from "../src/schemas/common.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(PKG, "src");
const REPO = path.resolve(PKG, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Sprint 6 M2 (C4): no render depends on the network. */
describe("bundled fonts, offline", () => {
  it("no source of the compositions references Google Fonts or a remote URL", () => {
    for (const file of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/googleapis|gstatic|@remotion\/google-fonts/);
      // Only comments may mention a URL; code never loads one (fonts come from staticFile()).
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/);
    }
  });

  it("fonts.ts registers FontFace from staticFile() only", () => {
    const fonts = readFileSync(path.join(SRC, "fonts.ts"), "utf8");
    expect(fonts).toMatch(/new FontFace\(/);
    expect(fonts).toMatch(/staticFile\(bundledFontPath\(/);
    expect(fonts).not.toMatch(/https?:/);
  });

  it("the family list equals the shared BUNDLED_FONT_FAMILIES (and the kit fonts are in it)", () => {
    expect([...FONT_FAMILIES]).toEqual([...BUNDLED_FONT_FAMILIES]);
    expect(Object.keys(BUNDLED_FONT_FILES)).toEqual([...BUNDLED_FONT_FAMILIES]);
    for (const f of Object.values(DEFAULT_BRAND_KIT.tokens.font))
      expect(BUNDLED_FONT_FAMILIES).toContain(f.family);
  });

  it("every family has its 3 weights and OFL.txt, matching manifest.json", () => {
    expect(path.resolve(REPO, FONTS_DIR_REL)).toBe(path.resolve(BUNDLED_FONTS_DIR));
    const manifest = JSON.parse(
      readFileSync(path.join(BUNDLED_FONTS_DIR, "manifest.json"), "utf8"),
    );
    for (const family of BUNDLED_FONT_FAMILIES) {
      const dir = path.join(BUNDLED_FONTS_DIR, family);
      const ofl = readFileSync(path.join(dir, "OFL.txt"), "utf8");
      expect(ofl, family).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
      for (const w of BUNDLED_FONT_WEIGHTS) {
        const file = BUNDLED_FONT_FILES[family][String(w) as "400"];
        expect(manifest[family].weights[String(w)], `${family} ${w}`).toBe(file);
        const abs = path.join(dir, file);
        expect(existsSync(abs), abs).toBe(true);
        // TrueType magic 0x00010000.
        expect(readFileSync(abs).readUInt32BE(0)).toBe(0x00010000);
      }
    }
  });

  it("stays within the size budget (≤ 8 MB)", () => {
    const total = walk(BUNDLED_FONTS_DIR).reduce((n, f) => n + statSync(f).size, 0);
    expect(total).toBeLessThan(8 * 1024 * 1024);
    expect(fontFilesFor(["Inter"]).length).toBe(3);
    expect(fontFilesFor(["Anton"]).length).toBe(1);
    expect(fontFilesFor().length).toBe(21);
  });
});
