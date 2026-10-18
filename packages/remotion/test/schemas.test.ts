import { TranscriptSchema } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { isColor } from "../src/schemas/common.js";
import { DEMO_TRANSCRIPT } from "../src/schemas/animated-captions.js";
import { validateRemotionProps } from "../src/templates.js";
import { findTemplateDef } from "../src/catalog.js";

describe("template props validation", () => {
  it("accepts valid props and applies defaults", () => {
    const v = validateRemotionProps("title-card", { title: "Hola", style: "pop" });
    expect(v).toMatchObject({ ok: true, props: { title: "Hola", style: "pop", align: "center" } });
  });

  it("title-card overlays the video by default but keeps the opaque card selectable (B6)", () => {
    expect(validateRemotionProps("title-card", {})).toMatchObject({
      ok: true,
      props: { background: "transparent" },
    });
    expect(validateRemotionProps("title-card", { background: "#111111" })).toMatchObject({
      ok: true,
      props: { background: "#111111" },
    });
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

describe("media props never point to internet (audit S6 E21)", () => {
  const lottie = (lottieSrc: string) =>
    findTemplateDef("lottie-overlay")!.schema.safeParse({ lottieSrc }).success;
  it("accepts Studio's own files (loopback / LAN api, relative, data:) and rejects external URLs", () => {
    expect(lottie("http://127.0.0.1:3001/files/media/a.json")).toBe(true);
    expect(lottie("http://localhost:3001/files/media/a.json")).toBe(true);
    expect(lottie("http://192.168.0.10:3001/files/media/a.json")).toBe(true);
    expect(lottie("media/a.json")).toBe(true);
    expect(lottie("data:application/json;base64,e30=")).toBe(true);
    expect(lottie("https://example.com/anim.json")).toBe(false);
    expect(lottie("http://8.8.8.8/a.json")).toBe(false);
    expect(lottie("//example.com/a.json")).toBe(false);
  });
});
