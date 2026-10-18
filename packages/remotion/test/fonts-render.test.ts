// Sprint 6 M2 (C4): real renderStill with the bundled fonts (no network). Needs Chrome Headless
// Shell (REMOTION_BROWSER_EXECUTABLE or `browser:ensure`); skipped without it.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DESIGN_TOKENS } from "@studio/shared";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBrowserExecutable } from "../src/browser.js";
import { renderTemplateStill } from "../src/still.js";

function browserPresent(): boolean {
  try {
    return resolveBrowserExecutable() !== null;
  } catch {
    return false;
  }
}

/** Decoded PNG is not needed: different glyphs change the compressed bytes a lot. */
function differs(a: Buffer, b: Buffer): boolean {
  return a.length !== b.length || a.compare(b) !== 0;
}

describe.skipIf(!browserPresent())("bundled fonts in Remotion (integration, offline)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "title-card and animated-captions render with the requested bundled family, no font warnings",
    { timeout: 300_000 },
    async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "studio-fonts-"));
      const logs: string[] = [];
      const still = async (name: string, template: string, props: Record<string, unknown>) => {
        const output = path.join(dir, `${name}.png`);
        await renderTemplateStill({
          template,
          props,
          width: 540,
          height: 960,
          format: "png",
          output,
          storageDir: dir,
          mediaBaseUrl: "http://127.0.0.1:9/files/",
          tokens: DEFAULT_DESIGN_TOKENS,
          onBrowserLog: (t) => logs.push(t),
        });
        return readFileSync(output);
      };
      const t0 = Date.now();
      const bangers = await still("bangers", "title-card", {
        title: "Hola Studio",
        fontFamily: "Bangers",
      });
      const firstMs = Date.now() - t0;
      const anton = await still("anton", "title-card", {
        title: "Hola Studio",
        fontFamily: "Anton",
      });
      const playfair = await still("playfair", "title-card", {
        title: "Hola Studio",
        fontFamily: "Playfair Display",
      });
      expect(differs(bangers, anton)).toBe(true);
      expect(differs(anton, playfair)).toBe(true);
      const caps = await still("caps", "animated-captions", { fontFamily: "Bebas Neue" });
      expect(caps.length).toBeGreaterThan(1000);
      expect(
        logs.filter((l) => /no se pudo cargar|Failed to load|googleapis|gstatic/i.test(l)),
      ).toEqual([]);
      // 1080×1920 «< 5 s» is measured by the api e2e; here only a sanity bound for the first still.
      expect(firstMs).toBeLessThan(120_000);
    },
  );

  it(
    "the kit weight of each role reaches the templates (audit S6 E12)",
    { timeout: 300_000 },
    async () => {
      const d = await mkdtemp(path.join(os.tmpdir(), "studio-weights-"));
      const still = async (
        name: string,
        template: string,
        role: "title" | "caption",
        family: string,
        weight: 400 | 700 | 900,
        props: Record<string, unknown> = {},
      ) => {
        const output = path.join(d, `${name}.png`);
        await renderTemplateStill({
          template,
          props: { title: "Hola Studio", ...props },
          width: 540,
          height: 960,
          format: "png",
          output,
          storageDir: d,
          mediaBaseUrl: "http://127.0.0.1:9/files/",
          tokens: {
            ...DEFAULT_DESIGN_TOKENS,
            font: { ...DEFAULT_DESIGN_TOKENS.font, [role]: { family, weight } },
          } as typeof DEFAULT_DESIGN_TOKENS,
        });
        return readFileSync(output);
      };
      try {
        const t400 = await still("t400", "title-card", "title", "Inter", 400);
        const t900 = await still("t900", "title-card", "title", "Inter", 900);
        expect(differs(t400, t900)).toBe(true);
        // Single-weight family: same face at 400 and 900 (no synthetic bold).
        const b400 = await still("b400", "title-card", "title", "Bangers", 400);
        const b900 = await still("b900", "title-card", "title", "Bangers", 900);
        expect(differs(b400, b900)).toBe(false);
        const c400 = await still("c400", "animated-captions", "caption", "Inter", 400);
        const c900 = await still("c900", "animated-captions", "caption", "Inter", 900);
        expect(differs(c400, c900)).toBe(true);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    },
  );
});
