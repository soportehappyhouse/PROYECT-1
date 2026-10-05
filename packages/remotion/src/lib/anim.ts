// Small pure animation helpers shared by compositions.

export const secToFrames = (sec: number, fps: number): number => Math.max(1, Math.round(sec * fps));

/** Size multiplier relative to a 1080p reference (shorter side). */
export const unitScale = (width: number, height: number): number => Math.min(width, height) / 1080;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Enter/exit progress for an element visible during the whole composition:
 * enter goes 0->1 over the first `inFrames`, exit goes 0->1 over the last `outFrames`.
 */
export function inOut(
  frame: number,
  durationInFrames: number,
  inFrames: number,
  outFrames: number,
): { enter: number; exit: number } {
  const enter = clamp01(frame / Math.max(1, inFrames));
  const exitStart = durationInFrames - outFrames;
  const exit = outFrames <= 0 ? 0 : clamp01((frame - exitStart) / Math.max(1, outFrames));
  return { enter, exit };
}

/** Split text for kinetic typography. */
export function splitKinetic(text: string, by: "word" | "phrase"): string[] {
  const parts =
    by === "word" ? text.split(/\s+/) : text.split(/(?<=[.!?¡¿…])\s+|\n+/).map((p) => p.trim());
  return parts.filter((p) => p.length > 0);
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

/** True if the URL/path points to a still image (by extension). */
export function isImageSrc(src: string): boolean {
  return IMAGE_EXT.test(src.split(/[?#]/)[0] ?? "");
}
