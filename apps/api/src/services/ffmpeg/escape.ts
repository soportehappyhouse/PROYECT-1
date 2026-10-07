/**
 * FFmpeg filtergraph escaping (see "Notes on filtergraph escaping" in ffmpeg-filters docs).
 * Level 1: a filter option value — `\`, `'` and `:` are escaped with a backslash.
 * Level 2: the filtergraph description — the value is wrapped in single quotes; a literal `'`
 *          closes the quote, is emitted as `\'` and the quote is reopened.
 * Level 3 (shell) never applies: ffmpeg is spawned without a shell, one argv entry per token.
 */

/** Level-1 escape of an option value. */
export function escapeOptionValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

/** Level-2 quoting of an (already level-1 escaped) value for use inside a filtergraph. */
export function quoteFilterArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Windows `C:\dir\file` -> `C:/dir/file`; posix paths are unchanged. */
export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Escape a file path used as a filter option (subtitles=, ass=, fontfile=, textfile=, arnndn m=).
 * `C:\Users\Usuario\it's.srt` -> `'C\:/Users/Usuario/it\'\''s.srt'`.
 * Prefer running ffmpeg with `cwd` = job dir and simple relative names; this is the fallback.
 */
export function escapeFilterPath(p: string): string {
  return quoteFilterArg(escapeOptionValue(toForwardSlashes(p)));
}

/**
 * Escape literal text for drawtext `text=` (level 1 + level 2). With `expansion=none` `%` is
 * literal; otherwise it is escaped too. Prefer `textfile=` for user text.
 */
export function escapeDrawtextText(text: string, expansion = false): string {
  let v = escapeOptionValue(text.replace(/\r?\n/g, "\n"));
  if (expansion) v = v.replace(/%/g, "\\%");
  return quoteFilterArg(v);
}

/** Format seconds for filter expressions (max 6 decimals, no exponent). */
export function sec(n: number): string {
  const v = Math.round(n * 1e6) / 1e6;
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
