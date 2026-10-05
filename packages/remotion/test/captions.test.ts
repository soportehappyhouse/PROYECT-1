import { describe, expect, it } from "vitest";
import {
  activeTokenIndex,
  autoSafeArea,
  buildCaptionPages,
  pageEndMs,
  transcriptToCaptions,
} from "../src/lib/captions.js";
import { isImageSrc, splitKinetic } from "../src/lib/anim.js";

describe("captions", () => {
  it("maps word timestamps (seconds) to Caption[] (ms) with leading spaces", () => {
    const captions = transcriptToCaptions({
      segments: [
        {
          start: 0,
          end: 1,
          text: "Hola mundo",
          words: [
            { start: 0, end: 0.4, word: "Hola", probability: 0.9 },
            { start: 0.5, end: 1, word: " mundo" },
          ],
        },
      ],
    });
    expect(captions).toEqual([
      { text: " Hola", startMs: 0, endMs: 400, timestampMs: 200, confidence: 0.9 },
      { text: " mundo", startMs: 500, endMs: 1000, timestampMs: 750, confidence: null },
    ]);
  });

  it("splits segments without words evenly", () => {
    const captions = transcriptToCaptions({
      segments: [{ start: 1, end: 2, text: "uno dos" }],
    });
    expect(captions.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      [" uno", 1000, 1500],
      [" dos", 1500, 2000],
    ]);
  });

  it("groups words into pages and finds the active token", () => {
    const captions = transcriptToCaptions({
      segments: [{ start: 0, end: 4, text: "a b c d" }],
    });
    const pages = buildCaptionPages(captions, 1500);
    expect(pages.length).toBeGreaterThan(1);
    const first = pages[0]!;
    expect(activeTokenIndex(first, -1)).toBe(-1);
    expect(activeTokenIndex(first, 0)).toBe(0);
    expect(activeTokenIndex(first, first.tokens.at(-1)!.fromMs + 1)).toBe(first.tokens.length - 1);
    expect(pageEndMs(pages, 0, 10_000)).toBe(pages[1]!.startMs);
    expect(pageEndMs(pages, pages.length - 1, 3_000)).toBeLessThanOrEqual(3_000);
    expect(buildCaptionPages([], 500)).toEqual([]);
  });

  it("safe areas depend on the aspect ratio", () => {
    expect(autoSafeArea(1080, 1920).bottom).toBeGreaterThan(autoSafeArea(1920, 1080).bottom);
    expect(autoSafeArea(1920, 1080)).toEqual({ top: 6, bottom: 10, left: 6, right: 6 });
  });
});

describe("anim helpers", () => {
  it("splits kinetic text by word or phrase", () => {
    expect(splitKinetic("Crea. Edita. Comparte.", "word")).toEqual([
      "Crea.",
      "Edita.",
      "Comparte.",
    ]);
    expect(splitKinetic("Hola mundo. ¿Qué tal? Bien", "phrase")).toEqual([
      "Hola mundo.",
      "¿Qué tal?",
      "Bien",
    ]);
  });

  it("detects images by extension", () => {
    expect(isImageSrc("http://x/files/media/a.JPG?v=1")).toBe(true);
    expect(isImageSrc("http://x/files/media/a.mp4")).toBe(false);
  });
});
