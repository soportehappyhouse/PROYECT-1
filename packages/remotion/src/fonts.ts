// Fonts for compositions (browser side only). Sprint 6 M2 (decision 9): every family is bundled
// as static OFL TTFs in public/fonts/<Family>/ and loaded with FontFace + staticFile(), so no
// render ever touches the network (no Google Fonts). A face that fails to load degrades to the
// system fallback instead of failing the render.
import { continueRender, delayRender, staticFile } from "remotion";
import { BUNDLED_FONT_FILES, bundledFontPath, type BundledWeight } from "./font-files.js";
import type { FontFamily } from "./schemas/common.js";

const WEIGHTS: BundledWeight[] = ["400", "700", "900"];
const FALLBACK = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const TIMEOUT_MS = 15_000;
const stacks = new Map<FontFamily, string>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function load(family: FontFamily): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  const faces = WEIGHTS.map(
    (weight) =>
      new FontFace(
        family,
        `url(${staticFile(bundledFontPath(family, weight))}) format('truetype')`,
        {
          weight,
          style: "normal",
        },
      ),
  );
  const handle = delayRender(`Cargando fuente ${family}`);
  void Promise.allSettled(
    faces.map((face) =>
      withTimeout(face.load(), TIMEOUT_MS).then((loaded) => document.fonts.add(loaded)),
    ),
  ).then((results) => {
    if (results.some((r) => r.status === "rejected"))
      console.warn(`Fuente ${family}: no se pudo cargar, se usa la fuente del sistema`);
    continueRender(handle);
  });
}

/** CSS font-family stack for `family`; registers the bundled faces the first time. */
export function fontStack(family: FontFamily): string {
  const cached = stacks.get(family);
  if (cached) return cached;
  const known = family in BUNDLED_FONT_FILES;
  const stack = known ? `'${family}', ${FALLBACK}` : FALLBACK;
  stacks.set(family, stack);
  if (known) load(family);
  return stack;
}
