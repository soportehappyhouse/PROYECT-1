// Pure caption helpers (browser + Node). Ported in spirit from remotion-dev/template-tiktok,
// rewritten for the Studio transcript format (faster-whisper words in seconds).
import { type Caption, createTikTokStyleCaptions, type TikTokPage } from "@remotion/captions";
import type { SafeArea } from "../schemas/common.js";
import type { TranscriptLike } from "../schemas/animated-captions.js";

const withLeadingSpace = (s: string) => (s.startsWith(" ") ? s : ` ${s}`);
const ms = (sec: number) => Math.round(sec * 1000);

/**
 * Transcript (seconds, optional word timestamps) -> Remotion Caption[] (ms, one per word).
 * Segments without `words` are split on whitespace and timed evenly.
 */
export function transcriptToCaptions(transcript: TranscriptLike): Caption[] {
  const out: Caption[] = [];
  for (const seg of transcript.segments) {
    const words = seg.words?.filter((w) => w.word.trim() !== "");
    if (words && words.length > 0) {
      for (const w of words) {
        out.push({
          text: withLeadingSpace(w.word.trim()),
          startMs: ms(w.start),
          endMs: ms(Math.max(w.end, w.start)),
          timestampMs: ms((w.start + w.end) / 2),
          confidence: w.probability ?? null,
        });
      }
      continue;
    }
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const step = tokens.length > 0 ? (seg.end - seg.start) / tokens.length : 0;
    tokens.forEach((token, i) => {
      const start = seg.start + i * step;
      out.push({
        text: withLeadingSpace(token),
        startMs: ms(start),
        endMs: ms(start + step),
        timestampMs: ms(start + step / 2),
        confidence: null,
      });
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Group word captions into pages (several words shown together). */
export function buildCaptionPages(captions: Caption[], combineWithinMs: number): TikTokPage[] {
  if (captions.length === 0) return [];
  return createTikTokStyleCaptions({
    captions: captions.map((c) => ({ ...c, text: withLeadingSpace(c.text.trimEnd()) })),
    combineTokensWithinMilliseconds: combineWithinMs,
  }).pages;
}

/**
 * End of page i: its own end, or the next page start when the gap is short (< 400 ms, avoids
 * flicker) or the pages overlap. Never past `totalMs`.
 */
export function pageEndMs(pages: TikTokPage[], i: number, totalMs: number): number {
  const page = pages[i];
  if (!page) return totalMs;
  const own = page.startMs + page.durationMs;
  const next = pages[i + 1];
  const end = next && next.startMs - own < 400 ? next.startMs : own;
  return Math.min(end, totalMs);
}

/** Index of the token being spoken at `timeMs` (last token already started), -1 before the first. */
export function activeTokenIndex(page: TikTokPage, timeMs: number): number {
  let idx = -1;
  page.tokens.forEach((t, i) => {
    if (t.fromMs <= timeMs) idx = i;
  });
  return idx;
}

/**
 * Default safe areas (% of frame) by aspect ratio. 9:16 keeps text clear of the TikTok/Reels/Shorts
 * UI (captions, buttons); 16:9 uses the classic title-safe margins.
 */
export function autoSafeArea(width: number, height: number): SafeArea {
  const ratio = width / height;
  if (ratio < 0.7) return { top: 12, bottom: 24, left: 8, right: 14 }; // 9:16
  if (ratio < 1.2) return { top: 8, bottom: 14, left: 6, right: 6 }; // 1:1, 4:5
  return { top: 6, bottom: 10, left: 6, right: 6 }; // 16:9
}
