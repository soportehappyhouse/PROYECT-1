import type { SubtitleSegment } from "@studio/shared";

/**
 * Sprint 6 M1 test fixture: 10 sentences «fraseK [eh] importanteK.» with a 1.5 s pause between
 * them (9 long pauses) and an «eh» in the first 8 (8 safe fillers). Timeline = source seconds.
 */
export function scriptSegments(): SubtitleSegment[] {
  const segs: SubtitleSegment[] = [];
  let t = 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  for (let k = 0; k < 10; k++) {
    const words: { word: string; start: number; end: number; probability: number }[] = [];
    words.push({ word: `frase${k}`, start: r(t), end: r(t + 1), probability: 0.9 });
    t += 1.2;
    if (k < 8) {
      words.push({ word: "eh", start: r(t), end: r(t + 0.4), probability: 0.9 });
      t += 0.6;
    }
    words.push({ word: `importante${k}.`, start: r(t), end: r(t + 2), probability: 0.9 });
    t += 2;
    segs.push({
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((w) => w.word).join(" "),
      words,
    });
    if (k < 9) t += 1.5;
  }
  return segs;
}
