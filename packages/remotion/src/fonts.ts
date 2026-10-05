// Google Fonts for compositions (browser side only). Font metadata/URLs come from
// @remotion/google-fonts (`getInfo()`); loading is done here so that a missing network
// (offline PC) degrades to the system fallback font instead of failing the render.
import * as Anton from "@remotion/google-fonts/Anton";
import * as ArchivoBlack from "@remotion/google-fonts/ArchivoBlack";
import * as Bangers from "@remotion/google-fonts/Bangers";
import * as BebasNeue from "@remotion/google-fonts/BebasNeue";
import * as Inter from "@remotion/google-fonts/Inter";
import * as Montserrat from "@remotion/google-fonts/Montserrat";
import * as Oswald from "@remotion/google-fonts/Oswald";
import * as PlayfairDisplay from "@remotion/google-fonts/PlayfairDisplay";
import * as Poppins from "@remotion/google-fonts/Poppins";
import * as Roboto from "@remotion/google-fonts/Roboto";
import { continueRender, delayRender, getInputProps } from "remotion";
import type { FontFamily, RenderMetaProps } from "./schemas/common.js";

interface FontInfo {
  fontFamily: string;
  fonts: Record<string, Record<string, Record<string, string>>>;
  unicodeRanges: Record<string, string>;
}

const INFO: Record<FontFamily, () => FontInfo> = {
  Inter: Inter.getInfo,
  Montserrat: Montserrat.getInfo,
  Poppins: Poppins.getInfo,
  Roboto: Roboto.getInfo,
  Oswald: Oswald.getInfo,
  "Playfair Display": PlayfairDisplay.getInfo,
  "Bebas Neue": BebasNeue.getInfo,
  Anton: Anton.getInfo,
  "Archivo Black": ArchivoBlack.getInfo,
  Bangers: Bangers.getInfo,
};

const WEIGHTS = ["400", "700", "900"];
const SUBSETS = ["latin", "latin-ext"];
const FALLBACK = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const TIMEOUT_MS = 15_000;
const stacks = new Map<FontFamily, string>();

function fontMode(): "google" | "system" {
  try {
    return (getInputProps() as RenderMetaProps).__fontMode === "system" ? "system" : "google";
  } catch {
    return "google";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function load(info: FontInfo): void {
  const normal = info.fonts.normal ?? {};
  const faces: FontFace[] = [];
  for (const weight of WEIGHTS) {
    for (const subset of SUBSETS) {
      const url = normal[weight]?.[subset];
      if (!url) continue;
      const range = info.unicodeRanges[subset];
      faces.push(
        new FontFace(info.fontFamily, `url(${url}) format('woff2')`, {
          weight,
          style: "normal",
          ...(range && { unicodeRange: range }),
        }),
      );
    }
  }
  if (faces.length === 0) return;
  const handle = delayRender(`Cargando fuente ${info.fontFamily}`);
  void Promise.allSettled(
    faces.map((face) =>
      withTimeout(face.load(), TIMEOUT_MS).then((loaded) => document.fonts.add(loaded)),
    ),
  ).then((results) => {
    if (results.some((r) => r.status === "rejected"))
      console.warn(`Fuente ${info.fontFamily}: sin conexión, se usa la fuente del sistema`);
    continueRender(handle);
  });
}

/**
 * CSS font-family stack for `family`; downloads it from Google Fonts the first time.
 * With `__fontMode: "system"` nothing is downloaded. Failures fall back to system fonts.
 */
export function fontStack(family: FontFamily): string {
  const cached = stacks.get(family);
  if (cached) return cached;
  const info = INFO[family]();
  const stack = `'${info.fontFamily}', ${FALLBACK}`;
  stacks.set(family, stack);
  if (fontMode() === "google" && typeof FontFace !== "undefined") load(info);
  return stack;
}
