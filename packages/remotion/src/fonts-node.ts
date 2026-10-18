// Node-side paths of the bundled fonts (api: GET /fonts/*, libass fontsdir). Never bundled by
// Remotion's webpack (not imported by any composition).
import path from "node:path";
import { PACKAGE_DIR } from "./browser.js";
import { BUNDLED_FONT_FILES, type BundledWeight } from "./font-files.js";
import { FONT_FAMILIES, type FontFamily } from "./schemas/common.js";

/** Absolute packages/remotion/public/fonts (= shared FONTS_DIR_REL from the repo root). */
export const BUNDLED_FONTS_DIR = path.join(PACKAGE_DIR, "public", "fonts");

/** Absolute paths of the distinct TTF files of `families` (all families when omitted). */
export function fontFilesFor(families: readonly string[] = FONT_FAMILIES): string[] {
  const out = new Set<string>();
  for (const f of families) {
    const files = BUNDLED_FONT_FILES[f as FontFamily];
    if (!files) continue;
    for (const w of Object.keys(files) as BundledWeight[])
      out.add(path.join(BUNDLED_FONTS_DIR, f, files[w]));
  }
  return [...out];
}
