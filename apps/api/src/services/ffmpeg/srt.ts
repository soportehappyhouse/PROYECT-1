import type { SubtitleSegment } from "@studio/shared";

/** 3725.5 -> "01:02:05,500" */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** Serialize subtitle segments (optionally shifted by -offset) to SRT. */
export function toSrt(segments: readonly SubtitleSegment[], offsetSec = 0): string {
  return segments
    .filter((s) => s.end > s.start && s.text.trim() !== "")
    .map((s, i) => {
      const text = s.text.replace(/\r/g, "").trim();
      return `${i + 1}\n${srtTime(s.start - offsetSec)} --> ${srtTime(s.end - offsetSec)}\n${text}\n`;
    })
    .join("\n");
}
