// FFmpeg filtergraph escaping helpers (two levels: graph parser, then option parser).
// See docs/trabajo/fuentes-motion.md §4: inside a quoted option value commas are written `\,`
// and Windows drive colons `C\:/...`.

/** Path for a filter option (fontfile / textfile): forward slashes, escaped `:` and `'`, quoted. */
export function filterPath(p: string): string {
  const posix = p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
  return `'${posix}'`;
}

/** Expression for a quoted option value: escapes commas for the option parser. */
export function filterExpr(expr: string): string {
  return `'${expr.replace(/,/g, "\\,")}'`;
}

/** ffmpeg color syntax: names, #RRGGBB[AA] / 0xRRGGBB[AA], optional @alpha. */
export const FFMPEG_COLOR =
  /^(?:(?:#|0x)[0-9a-f]{6}(?:[0-9a-f]{2})?|[a-z]+)(?:@(?:0(?:\.\d+)?|1(?:\.0+)?))?$/i;

/** Numbers printed for filter expressions (no exponent, max 3 decimals). */
export const num = (n: number): string => String(Math.round(n * 1000) / 1000);
