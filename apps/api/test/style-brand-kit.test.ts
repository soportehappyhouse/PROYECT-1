import { describe, expect, it } from "vitest";
import type { EditPlan } from "@studio/shared";
import { withBrandKit } from "../src/routes/style.js";

const plan: EditPlan = {
  version: 1,
  summary_es: "Perfil",
  ops: [
    {
      op: "add_motion",
      template: "title-card",
      t: 0,
      params: { title: "Hola", fontFamily: "Anton", accentColor: "#ff0000", style: "pop" },
    },
    { op: "add_captions", style: "reels", animated: true },
  ],
} as EditPlan;

describe("StylePreset ↔ brand kit (Sprint 6 M2)", () => {
  it("use_brand_kit (default yes): motion ops lose fonts and colors, the kit fills them", () => {
    const out = withBrandKit(plan, true);
    const op = out.ops[0] as { params: Record<string, unknown> };
    expect(op.params).toEqual({ title: "Hola", style: "pop" });
    expect(out.ops[1]).toEqual(plan.ops[1]);
  });
  it("use_brand_kit: false keeps the reference look", () => {
    expect(withBrandKit(plan, false)).toBe(plan);
  });
});
