import { DEFAULT_BRAND_KIT, ProjectSchema } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { exportDesignSummary } from "../src/jobs/handlers/project-export.js";

/** Audit S6 E11: the export tells the hard design issues nothing fixes (DESIGN_UNFIXED). */
const project = (subtitles: unknown[], captionStyle?: unknown) =>
  ProjectSchema.parse({
    id: "p",
    name: "x",
    settings: { width: 1080, height: 1920, fps: 30 },
    tracks: [],
    subtitles,
    ...(captionStyle !== undefined && { captionStyle }),
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  });

describe("exportDesignSummary", () => {
  it("a page read too fast (no room to stretch) is counted as unfixed", () => {
    const fast = [
      { start: 0, end: 0.9, text: "esto se lee rapidísimo y no hay lugar" },
      { start: 0.9, end: 1.8, text: "para estirarlo porque viene otro enseguida" },
    ];
    const s = exportDesignSummary(project(fast), DEFAULT_BRAND_KIT, "9:16");
    expect(s.designUnfixed).toBeGreaterThan(0);
  });

  it("a small caption is fixed by the generation (designFixed), nothing left unfixed", () => {
    const ok = [{ start: 0, end: 3, text: "Hola, ¿cómo andás?" }];
    const small = {
      id: "x",
      name: "x",
      fontFamily: "Inter",
      fontSize: 20,
      color: "#ffffff",
      background: "",
      highlightColor: "#ffd60a",
      position: "bottom",
      uppercase: false,
      animation: "none",
      fromBrandKit: false,
    };
    const s = exportDesignSummary(project(ok, small), DEFAULT_BRAND_KIT, "9:16");
    expect(s.designFixed).toBeGreaterThan(0);
    expect(s.designUnfixed).toBe(0);
  });
});
