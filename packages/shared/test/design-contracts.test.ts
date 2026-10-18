import { describe, expect, it } from "vitest";
import {
  BrandKitSchema,
  BrandKitUpdateSchema,
  BUNDLED_FONT_FAMILIES,
  DEFAULT_BRAND_KIT,
  DEFAULT_DESIGN_TOKENS,
  DESIGN_RULE_IDS,
  DESIGN_RULES,
  DesignTokensSchema,
  FontTokenSchema,
  contrastRatio,
} from "../src/index.js";

describe("design contracts (M2)", () => {
  it("DEFAULT_BRAND_KIT and DEFAULT_DESIGN_TOKENS are valid", () => {
    expect(BrandKitSchema.parse(DEFAULT_BRAND_KIT)).toEqual(DEFAULT_BRAND_KIT);
    expect(DesignTokensSchema.parse(DEFAULT_DESIGN_TOKENS)).toEqual(DEFAULT_DESIGN_TOKENS);
    expect(DEFAULT_BRAND_KIT.name).toBe("Mi canal");
  });

  it("kit fonts are bundled families; unknown families are rejected", () => {
    for (const f of Object.values(DEFAULT_DESIGN_TOKENS.font))
      expect(BUNDLED_FONT_FAMILIES).toContain(f.family);
    expect(FontTokenSchema.safeParse({ family: "Comic Sans MS", weight: 400 }).success).toBe(false);
    expect(FontTokenSchema.safeParse({ family: "Inter", weight: 500 }).success).toBe(false);
  });

  it("10 rules: 8 hard + 2 guide, same order as DESIGN_RULE_IDS", () => {
    expect(DESIGN_RULES.map((r) => r.id)).toEqual([...DESIGN_RULE_IDS]);
    expect(DESIGN_RULES.filter((r) => r.severity === "hard")).toHaveLength(8);
  });

  it("default colors pass their own contrast rule", () => {
    const c = DEFAULT_DESIGN_TOKENS.color;
    expect(contrastRatio(c.text, c.text_outline)).toBeGreaterThanOrEqual(
      DEFAULT_DESIGN_TOKENS.caption.min_contrast,
    );
  });

  it("PUT payload is partial and strict", () => {
    expect(BrandKitUpdateSchema.parse({ name: "Canal" })).toEqual({ name: "Canal" });
    expect(BrandKitUpdateSchema.safeParse({ nombre: "x" }).success).toBe(false);
  });
});
