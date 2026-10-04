import { TranscriptSchema } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { isColor } from "../src/schemas/common.js";
import { DEMO_TRANSCRIPT } from "../src/schemas/animated-captions.js";
import { validateRemotionProps } from "../src/templates.js";

describe("template props validation", () => {
  it("accepts valid props and applies defaults", () => {
    const v = validateRemotionProps("title-card", { title: "Hola", style: "pop" });
    expect(v).toMatchObject({ ok: true, props: { title: "Hola", style: "pop", align: "center" } });
  });

  it.each([
    ["title-card", { style: "explode" }, "style"],
    ["title-card", { titleColor: "not a color!" }, "titleColor"],
    ["title-card", { titleSize: 5000 }, "titleSize"],
    ["lower-third", { position: "middle" }, "position"],
    ["lower-third", { inSec: 0 }, "inSec"],
    ["animated-captions", { style: "neon" }, "style"],
    ["animated-captions", { transcript: { segments: [{ start: 0 }] } }, "transcript"],
    ["animated-captions", { safeArea: { top: 80, bottom: 0, left: 0, right: 0 } }, "safeArea"],
    ["transition", { kind: "cube" }, "kind"],
    ["transition", { direction: "diagonal" }, "direction"],
    ["audio-visualizer", { bars: 3 }, "bars"],
    ["lottie-overlay", { size: 2 }, "size"],
    ["progress-bar", { chapters: [{ label: "x", startSec: -1 }] }, "chapters"],
    ["kinetic-typography", { colors: [] }, "colors"],
    ["end-screen", { layout: "tiktok" }, "layout"],
  ])("%s rejects %j", (template, props, path) => {
    const v = validateRemotionProps(template, props);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toContain(path);
  });

  it("rejects unknown templates", () => {
    expect(validateRemotionProps("nope", {})).toEqual({
      ok: false,
      errors: ["Plantilla Remotion desconocida: nope"],
    });
  });

  it("color validator", () => {
    for (const c of [
      "#fff",
      "#ffd400",
      "#ffd40080",
      "rgba(0,0,0,0.75)",
      "hsl(10, 50%, 40%)",
      "transparent",
      "white",
    ])
      expect(isColor(c), c).toBe(true);
    for (const c of ["", "#ggg", "rgb(", "url(x)", "#12345"]) expect(isColor(c), c).toBe(false);
  });

  it("demo transcript matches the shared Transcript contract (faster-whisper output)", () => {
    expect(() => TranscriptSchema.parse(DEMO_TRANSCRIPT)).not.toThrow();
  });
});
