import type { CaptionStyle, SubtitleSegment, SubtitleWord } from "@studio/shared";

function srtTime(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(segments: readonly SubtitleSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
    .join("\n");
}

/** Time span covered by the segments. */
export function subtitlesSpan(
  segments: readonly SubtitleSegment[],
): { start: number; end: number } | undefined {
  if (segments.length === 0) return undefined;
  let start = Infinity;
  let end = 0;
  for (const s of segments) {
    start = Math.min(start, s.start);
    end = Math.max(end, s.end);
  }
  return end > start ? { start, end } : undefined;
}

/** Fonts bundled by @studio/remotion (packages/remotion/src/schemas/common.ts FONT_FAMILIES). */
const REMOTION_FONTS = [
  "Inter",
  "Montserrat",
  "Poppins",
  "Roboto",
  "Oswald",
  "Playfair Display",
  "Bebas Neue",
  "Anton",
  "Archivo Black",
  "Bangers",
];

const ANIMATION_TO_TEMPLATE_STYLE: Record<CaptionStyle["animation"], string> = {
  none: "highlight",
  fade: "highlight",
  pop: "pop",
  karaoke: "karaoke",
};

/** Words of a segment: Whisper's when present, else the text split on whitespace, evenly timed. */
export function segmentWords(seg: SubtitleSegment): SubtitleWord[] {
  if (seg.words?.some((w) => w.word.trim())) return seg.words;
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  const step = (seg.end - seg.start) / Math.max(1, tokens.length);
  return tokens.map((t, i) => ({
    start: seg.start + i * step,
    end: i === tokens.length - 1 ? seg.end : seg.start + (i + 1) * step,
    word: ` ${t}`,
  }));
}

/**
 * Props for the Remotion `animated-captions` template from the project subtitles: a word-level
 * `transcript` relative to the first segment, plus the caption style mapped to template props.
 */
export function animatedCaptionsProps(
  segments: readonly SubtitleSegment[],
  style: CaptionStyle,
  language?: string,
): { props: Record<string, unknown>; start: number; durationSec: number } | undefined {
  const span = subtitlesSpan(segments);
  if (!span) return undefined;
  const shift = (t: number) => Math.max(0, t - span.start);
  const transcript = {
    ...(language && { language }),
    durationSec: span.end - span.start,
    segments: segments.map((s) => ({
      start: shift(s.start),
      end: shift(s.end),
      text: s.text,
      words: segmentWords(s).map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) })),
    })),
  };
  const props: Record<string, unknown> = {
    transcript,
    style: ANIMATION_TO_TEMPLATE_STYLE[style.animation] ?? "highlight",
    position: style.position,
    fontSize: Math.min(300, Math.max(16, style.fontSize)),
    uppercase: style.uppercase,
    textColor: style.color,
    highlightColor: style.highlightColor,
    ...(REMOTION_FONTS.includes(style.fontFamily) && { fontFamily: style.fontFamily }),
    ...(style.background.trim() && { boxColor: style.background.trim() }),
  };
  return { props, start: span.start, durationSec: span.end - span.start };
}
