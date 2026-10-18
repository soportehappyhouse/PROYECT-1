import {
  DEFAULT_DESIGN_TOKENS,
  DesignTokensSchema,
  MotionSpecSchema,
  templateDesign,
} from "@studio/shared";
import { describe, expect, it } from "vitest";
import { applyDesign, TOKEN_PROPS } from "../src/lib/design.js";
import { animatedCaptionPages, buildInputProps } from "../src/props.js";
import type { DesignMeta } from "../src/schemas/common.js";
import { REMOTION_TEMPLATES, validateRemotionProps } from "../src/templates.js";

const kit = DesignTokensSchema.parse({
  ...DEFAULT_DESIGN_TOKENS,
  color: { ...DEFAULT_DESIGN_TOKENS.color, accent: "#00AAFF", text: "#FAFAFA" },
  font: { ...DEFAULT_DESIGN_TOKENS.font, title: { family: "Oswald", weight: 700 } },
});
const design = templateDesign(kit, "9:16") as DesignMeta;

/** Values each template had before Sprint 6 (no kit = same result as before). */
const LEGACY: Record<string, Record<string, unknown>> = {
  "title-card": { fontFamily: "Montserrat", titleColor: "#ffffff", accentColor: "#e13238" },
  "lower-third": {
    fontFamily: "Inter",
    textColor: "#ffffff",
    accentColor: "#e13238",
    inSec: 0.6,
    outSec: 0.5,
  },
  "animated-captions": {
    fontFamily: "Montserrat",
    textColor: "#ffffff",
    highlightColor: "#ffd400",
    strokeColor: "#000000",
  },
  "end-screen": { fontFamily: "Poppins", textColor: "#ffffff", accentColor: "#e13238" },
  "kinetic-typography": { fontFamily: "Bebas Neue" },
};

describe("templates read the brand-kit tokens", () => {
  it.each(REMOTION_TEMPLATES.map((t) => t.id))("%s accepts the __design meta prop", (id) => {
    const v = validateRemotionProps(id, { __design: design });
    expect(v.ok).toBe(true);
  });

  it.each(Object.keys(LEGACY))("%s without tokens = the pre-Sprint 6 defaults", (id) => {
    const v = validateRemotionProps(id, {});
    if (!v.ok) throw new Error(v.errors.join());
    expect(applyDesign(id, v.props)).toMatchObject(LEGACY[id]!);
  });

  it("title-card with the kit: kit font and colors; explicit props still win", () => {
    const v = validateRemotionProps("title-card", {});
    if (!v.ok) throw new Error();
    expect(applyDesign("title-card", v.props, design)).toMatchObject({
      fontFamily: "Oswald",
      titleColor: "#FAFAFA",
      accentColor: "#00AAFF",
    });
    const e = validateRemotionProps("title-card", { accentColor: "#123456" });
    if (!e.ok) throw new Error();
    expect(applyDesign("title-card", e.props, design).accentColor).toBe("#123456");
  });

  it("lower-third timings come from the motion tokens; captions get the 9:16 safe zone", () => {
    const lt = validateRemotionProps("lower-third", {});
    if (!lt.ok) throw new Error();
    expect(applyDesign("lower-third", lt.props, design)).toMatchObject({
      inSec: 0.35,
      outSec: 0.25,
    });
    const ac = validateRemotionProps("animated-captions", {});
    if (!ac.ok) throw new Error();
    expect(applyDesign("animated-captions", ac.props, design).safeArea).toEqual({
      top: 15,
      bottom: 35,
      left: 11,
      right: 11,
    });
  });

  it("every token-backed prop is optional in the schema (absent = kit)", () => {
    for (const [id, map] of Object.entries(TOKEN_PROPS)) {
      const info = REMOTION_TEMPLATES.find((t) => t.id === id)!;
      for (const key of Object.keys(map))
        expect(info.defaultProps[key], `${id}.${key}`).toBeUndefined();
    }
  });

  it("buildInputProps injects __design and design-rule caption pages (≤ 2 lines)", async () => {
    const spec = MotionSpecSchema.parse({
      template: "animated-captions",
      durationSec: 5,
      width: 1080,
      height: 1920,
      props: {},
    });
    const props = await buildInputProps(spec, {
      storageDir: "/tmp",
      mediaBaseUrl: "http://127.0.0.1:3001/files/",
      tokens: kit,
    });
    expect(props.__design?.safe_zone).toEqual({ top: 15, bottom: 35, left: 11, right: 11 });
    expect(props.__pages?.length).toBeGreaterThan(0);
    for (const p of props.__pages!) {
      expect(p.lines.length).toBeLessThanOrEqual(2);
      expect(p.lines.reduce((a, b) => a + b, 0)).toBe(p.tokens.length);
    }
    const none = await buildInputProps(spec, {
      storageDir: "/tmp",
      mediaBaseUrl: "http://x/",
      tokens: null,
    });
    expect(none.__design).toBeUndefined();
    expect(none.__pages).toBeUndefined();
  });

  it("animatedCaptionPages never splits «el auto» and never shows 3 lines", () => {
    const words = "Mañana te muestro cómo lavar el auto en casa sin gastar de más".split(" ");
    const transcript = {
      segments: [
        {
          start: 0,
          end: words.length * 0.35,
          text: words.join(" "),
          words: words.map((w, i) => ({ word: w, start: i * 0.35, end: i * 0.35 + 0.3 })),
        },
      ],
    };
    const pages = animatedCaptionPages({ transcript, fontSize: 88, uppercase: true }, 1080, 1920);
    for (const p of pages) {
      expect(p.lines.length).toBeLessThanOrEqual(2);
      const lineEnd = p.tokens[p.lines[0]! - 1]!.text;
      if (p.lines.length > 1) expect(lineEnd).not.toBe("el");
    }
  });
});
