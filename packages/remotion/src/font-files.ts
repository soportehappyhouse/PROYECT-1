// Bundled OFL fonts (Sprint 6 M2, decision 9): files under packages/remotion/public/fonts/<Family>/,
// produced by scripts/fetch-fonts.py and committed (no render downloads fonts). Browser-safe: no
// node:* imports. Single-weight display families map their three weights to the one file, so the
// browser never synthesizes a fake bold. Kept equal to public/fonts/manifest.json by a test.
import type { FontFamily } from "./schemas/common.js";

export type BundledWeight = "400" | "700" | "900";

export const BUNDLED_FONT_FILES: Record<FontFamily, Record<BundledWeight, string>> = {
  Inter: { "400": "Inter-400.ttf", "700": "Inter-700.ttf", "900": "Inter-900.ttf" },
  Montserrat: {
    "400": "Montserrat-400.ttf",
    "700": "Montserrat-700.ttf",
    "900": "Montserrat-900.ttf",
  },
  Poppins: { "400": "Poppins-400.ttf", "700": "Poppins-700.ttf", "900": "Poppins-900.ttf" },
  Roboto: { "400": "Roboto-400.ttf", "700": "Roboto-700.ttf", "900": "Roboto-900.ttf" },
  // Oswald's variable axis stops at 700: 900 uses the 700 face.
  Oswald: { "400": "Oswald-400.ttf", "700": "Oswald-700.ttf", "900": "Oswald-700.ttf" },
  "Playfair Display": {
    "400": "PlayfairDisplay-400.ttf",
    "700": "PlayfairDisplay-700.ttf",
    "900": "PlayfairDisplay-900.ttf",
  },
  "Bebas Neue": {
    "400": "BebasNeue-400.ttf",
    "700": "BebasNeue-400.ttf",
    "900": "BebasNeue-400.ttf",
  },
  Anton: { "400": "Anton-400.ttf", "700": "Anton-400.ttf", "900": "Anton-400.ttf" },
  "Archivo Black": {
    "400": "ArchivoBlack-400.ttf",
    "700": "ArchivoBlack-400.ttf",
    "900": "ArchivoBlack-400.ttf",
  },
  Bangers: { "400": "Bangers-400.ttf", "700": "Bangers-400.ttf", "900": "Bangers-400.ttf" },
};

/** Path of a bundled font relative to the public dir (`staticFile()` / GET /fonts/*). */
export function bundledFontPath(family: FontFamily, weight: BundledWeight): string {
  return `fonts/${family}/${BUNDLED_FONT_FILES[family][weight]}`;
}
