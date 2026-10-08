import { describe, expect, it } from "vitest";
import { HOTKEYS, hotkeyById } from "../src/index.js";

const norm = (k: string) =>
  k
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .sort()
    .join("+");

describe("HOTKEYS registry (Sprint 5 M2)", () => {
  it("has unique ids and 32 entries", () => {
    const ids = HOTKEYS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(32);
    expect(hotkeyById("timeline.rippleDelete")?.keys).toBe("Shift+Delete");
  });

  it("never repeats keys inside the same scope (global keys also clash with editor ones)", () => {
    const seen = new Map<string, string>();
    for (const h of HOTKEYS) {
      const k = norm(h.keys);
      expect(seen.get(k), `${h.id} vs ${seen.get(k)}`).toBeUndefined();
      seen.set(k, h.id);
    }
  });

  it("documents every shortcut and keeps arrows off the ruler", () => {
    for (const h of HOTKEYS) {
      expect(h.help_es.length, h.id).toBeGreaterThan(8);
      expect(h.label_es.length, h.id).toBeGreaterThan(2);
      if (/Arrow/.test(h.keys)) expect(h.onSlider, h.id).toBe(false);
    }
    const inForms = HOTKEYS.filter((h) => h.inTextFields).map((h) => h.id);
    expect(inForms.sort()).toEqual(
      ["assistant.open", "palette.open", "project.export", "project.save"].sort(),
    );
  });

  it("does not use the shortcuts Chrome/Edge reserve", () => {
    for (const h of HOTKEYS) expect(["ctrl+n", "ctrl+t", "ctrl+w"]).not.toContain(norm(h.keys));
  });
});
