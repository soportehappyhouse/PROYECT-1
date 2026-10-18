import type { FitDurationPreview } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { fitPlanFor, fitShownTotal, toggleFitChoice } from "@/lib/script";

/** Audit S6 E14: «acelerar» is only applied with every cut group; the total follows the boxes. */
const preview = {
  from_s: 60,
  to_s: 40,
  reached: true,
  groups: [
    { level: "pauses", removed_s: 8, count: 4, label_es: "4 pausas" },
    { level: "fillers_safe", removed_s: 2, count: 5, label_es: "5 muletillas" },
    { level: "speed", removed_s: 10, count: 1, label_es: "Acelerar ×1,2" },
  ],
  cuts: [
    { start: 1, end: 5, reason: "pause", wordIds: [] },
    { start: 10, end: 14, reason: "pause", wordIds: [] },
    { start: 20, end: 22, reason: "filler", wordIds: [] },
  ],
  speed: 1.2,
  plan: {
    version: 1,
    summary_es: "Dejalo en 40 s",
    ops: [{ op: "fit_duration", target_s: 40, allow_speedup: true }],
  },
} as unknown as FitDurationPreview;

describe("fit choices", () => {
  const all = ["pause", "filler", "speed"] as const;
  it("unchecking a cut group unchecks «acelerar»; checking it brings everything back", () => {
    const off = toggleFitChoice(preview, [...all], "filler", false);
    expect(off).toEqual(["pause"]);
    expect(toggleFitChoice(preview, off, "speed", true)).toEqual([...all]);
    // «acelerar» alone can be unchecked.
    expect(toggleFitChoice(preview, [...all], "speed", false)).toEqual(["pause", "filler"]);
  });

  it("what it shows is what it applies", () => {
    const some = new Set(toggleFitChoice(preview, [...all], "filler", false));
    expect(fitShownTotal(preview, some)).toBe(52);
    const plan = fitPlanFor(preview, some, { target_s: 40 })!;
    expect(JSON.stringify(plan)).not.toContain("allow_speedup");
    expect(fitShownTotal(preview, new Set(all))).toBe(40);
  });
});
