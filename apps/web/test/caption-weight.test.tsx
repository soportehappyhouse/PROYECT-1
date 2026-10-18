import {
  CAPTION_STYLE_PRESETS,
  DEFAULT_DESIGN_TOKENS,
  DesignTokensSchema,
  type DesignTokens,
} from "@studio/shared";
import { describe, expect, it } from "vitest";
import { drawComposition, type Composition } from "@/lib/compositor";

/** Audit S6 E1: the preview draws the captions with the burn-in face (kit family + real weight). */

function fontsDrawn(tokens: DesignTokens | undefined, style = CAPTION_STYLE_PRESETS[1]) {
  const fonts: string[] = [];
  const ctx = new Proxy(
    { measureText: (t: string) => ({ width: t.length * 10 }) } as Record<string, unknown>,
    {
      get: (o, k) => (k in o ? o[k as string] : () => undefined),
      set: (o, k, v) => {
        if (k === "font") fonts.push(String(v));
        o[k as string] = v;
        return true;
      },
    },
  );
  const comp = {
    layers: [],
    subtitle: {
      segment: { start: 0, end: 2, text: "Hola mundo" },
      rect: { x: 0, y: 0, width: 1080, height: 1920 },
    },
  } as unknown as Composition;
  drawComposition(
    ctx as never,
    comp,
    {} as never,
    { width: 1080, height: 1920 },
    style,
    tokens ? { tokens } : {},
  );
  return fonts;
}

const kit = (family: string, weight: 400 | 700 | 900) =>
  DesignTokensSchema.parse({
    ...DEFAULT_DESIGN_TOKENS,
    font: { ...DEFAULT_DESIGN_TOKENS.font, caption: { family, weight } },
  });

describe("caption weight in the player preview", () => {
  it("uses the kit caption family and weight (Black = 900)", () => {
    expect(fontsDrawn(kit("Inter", 900))[0]).toMatch(/^900 \d+px "Inter"/);
    expect(fontsDrawn(kit("Poppins", 400))[0]).toMatch(/^400 \d+px "Poppins"/);
  });
  it("single-weight families stay at their face (no fake bold)", () => {
    expect(fontsDrawn(kit("Bangers", 900))[0]).toMatch(/^400 \d+px "Bangers"/);
  });
  it("without tokens keeps the old look (600)", () => {
    expect(fontsDrawn(undefined)[0]).toMatch(/^600 /);
  });
});
