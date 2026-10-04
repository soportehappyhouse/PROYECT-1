import { MotionTemplateInfoSchema, REMOTION_TEMPLATE_IDS } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { REMOTION_TEMPLATES } from "../src/templates.js";

describe("remotion template catalog", () => {
  it("matches the shared template id list", () => {
    expect(REMOTION_TEMPLATES.map((t) => t.id)).toEqual([...REMOTION_TEMPLATE_IDS]);
  });

  it("entries are valid MotionTemplateInfo", () => {
    for (const t of REMOTION_TEMPLATES)
      expect(() => MotionTemplateInfoSchema.parse(t)).not.toThrow();
  });
});
