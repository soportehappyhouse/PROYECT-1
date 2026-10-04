import { MotionTemplateInfoSchema, REMOTION_TEMPLATE_IDS } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DEFS } from "../src/catalog.js";
import { REMOTION_TEMPLATES, validateRemotionProps } from "../src/templates.js";

describe("remotion template catalog", () => {
  it("starts with the shared REMOTION_TEMPLATE_IDS contract and adds the rest", () => {
    const ids = REMOTION_TEMPLATES.map((t) => t.id);
    expect(ids.slice(0, REMOTION_TEMPLATE_IDS.length)).toEqual([...REMOTION_TEMPLATE_IDS]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "audio-visualizer",
        "lottie-overlay",
        "end-screen",
        "progress-bar",
        "kinetic-typography",
      ]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(REMOTION_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s is a valid MotionTemplateInfo with JSON schema, defaults and thumbnail",
    (_id, t) => {
      expect(() => MotionTemplateInfoSchema.parse(t)).not.toThrow();
      expect(t.engine).toBe("remotion");
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name.length).toBeGreaterThan(0);
      const schema = t.propsSchema as { type: string; properties: Record<string, unknown> };
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
      // Defaults are themselves valid props.
      expect(validateRemotionProps(t.id, t.defaultProps)).toMatchObject({ ok: true });
      expect(t.thumbnail.compositionId).toBe(`${t.id}-thumb`);
      expect(t.thumbnail.frame).toBeLessThan(t.defaultDurationSec * 30);
    },
  );

  it("exposes colors as JSON Schema format=color (dashboard color pickers)", () => {
    const title = REMOTION_TEMPLATES.find((t) => t.id === "title-card");
    const props = (title?.propsSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.titleColor).toMatchObject({
      type: "string",
      format: "color",
      title: expect.any(String),
    });
    expect(props.style).toMatchObject({ enum: ["fade-up", "pop", "slide", "typewriter", "boxed"] });
    // Input schema: defaulted props are optional.
    expect((title?.propsSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  it("catalog defs and template infos stay aligned", () => {
    expect(TEMPLATE_DEFS.map((d) => d.id)).toEqual(REMOTION_TEMPLATES.map((t) => t.id));
  });

  it("uses Spanish defaults", () => {
    const byId = Object.fromEntries(REMOTION_TEMPLATES.map((t) => [t.id, t.defaultProps]));
    expect(byId["title-card"]).toMatchObject({ title: "Mi título" });
    expect(byId["lower-third"]).toMatchObject({ name: "Nombre Apellido" });
    expect(byId["end-screen"]).toMatchObject({ title: "¡Gracias por ver!", ctaText: "Suscríbete" });
  });
});
