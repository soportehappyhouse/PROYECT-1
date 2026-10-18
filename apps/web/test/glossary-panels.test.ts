import { GLOSSARY_ES } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { PANELS } from "@/lib/layout";

/**
 * Integration S6: the glossary (Ajustes, mensajes «Media → Analizar») and the dock tabs use the
 * same panel names. M2's glossary said «Medios» / «Voz» while the tabs said «Media» / «Voz y audio».
 */
describe("GLOSSARY_ES.panels = títulos de los paneles", () => {
  it("every glossary panel exists with the same title", () => {
    const ids: Record<string, string> = {
      script: "script",
      subtitles: "subtitles",
      motion: "motion",
      inspector: "inspector",
      assistant: "assistant",
      voice: "voice",
      media: "media",
      export: "export",
      jobs: "jobs",
      console: "console",
      style: "style",
    };
    for (const [key, name] of Object.entries(GLOSSARY_ES.panels)) {
      if (key === "suggestions") continue; // a section of the Asistente, not a panel
      const panel = PANELS.find((p) => p.id === ids[key]);
      expect(panel?.title, key).toBe(name);
    }
  });
});
