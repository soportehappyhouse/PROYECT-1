import type { SubtitleSegment } from "@studio/shared";

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
