import {
  BUNDLED_FONT_FAMILIES,
  bundledFontWeight,
  DESIGN_RULE_IDS,
  DESIGN_RULES,
  type BrandKit,
  type CaptionRules,
  type DesignAspect,
  type DesignCheckResult,
  type DesignIssue,
  type DesignRuleId,
  type DesignTokens,
  type ResolvedDesign,
  type SafeZone,
} from "./design.js";
import type { CaptionStyle, SubtitleSegment } from "./subtitles.js";
import type { Clip, Project } from "./timeline.js";

/**
 * Sprint 6 M2 — design system logic (docs/trabajo/sprint6-contratos.md §M2, fuentes-sprint6.md §2).
 * Pure functions shared by the api (ASS burn-in, /api/design/check, export auto-fix), Remotion
 * (animated-captions pages and template tokens, computed node-side) and the web (Kit de marca).
 * Every number comes from DesignTokens: nothing here is a loose size, color or duration.
 */

// ---------------------------------------------------------------------------------------------
// Colors and contrast

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** "#rgb" | "#rgba" | "#rrggbb" | "#rrggbbaa" | "rgb(a)(…)" | "transparent" -> RGBA; else null. */
export function parseCssColor(input: string | undefined | null): Rgba | null {
  const v = (input ?? "").trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(v))) {
    const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h + h, 16)) as [
      number,
      number,
      number,
    ];
    return { r, g, b, a: m[4] ? parseInt(m[4] + m[4], 16) / 255 : 1 };
  }
  if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(v))) {
    const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16)) as [number, number, number];
    return { r, g, b, a: m[4] ? parseInt(m[4], 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const c = (x: string) => Math.min(255, Math.max(0, Math.round(Number(x))));
    let a = 1;
    if (m[4]) a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r: c(m[1]!), g: c(m[2]!), b: c(m[3]!), a: Math.min(1, Math.max(0, a)) };
  }
  if (v === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (v === "black") return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance (alpha ignored). */
export function relativeLuminance(color: string): number {
  const c = parseCssColor(color);
  if (!c) return 0;
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio 1..21 between two colors (alpha ignored). #FFF/#000 = 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean RGB distance (0..441). */
export function colorDistance(a: string, b: string): number {
  const x = parseCssColor(a);
  const y = parseCssColor(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
}

/** Grays (low chroma) go with any palette: the brand check ignores them. */
export function isNeutral(color: string): boolean {
  const c = parseCssColor(color);
  return Boolean(c) && Math.max(c!.r, c!.g, c!.b) - Math.min(c!.r, c!.g, c!.b) < 24;
}

/** Colors of the kit (text, outline, accent, plate and palette). */
export function kitColors(tokens: DesignTokens): string[] {
  const c = tokens.color;
  return [c.text, c.text_outline, c.accent, c.plate, ...c.palette];
}

// ---------------------------------------------------------------------------------------------
// Canvas, aspect and resolved tokens

/** 9:16 (portrait), 1:1 (around square, incl. 4:5) or 16:9 (landscape). */
export function aspectOfCanvas(width: number, height: number): DesignAspect {
  const r = width / Math.max(1, height);
  if (r < 0.8) return "9:16";
  if (r > 1.25) return "16:9";
  return "1:1";
}

/** Reference canvas of an aspect (export presets). */
export function canvasForAspect(aspect: DesignAspect): { w: number; h: number } {
  return aspect === "9:16"
    ? { w: 1080, h: 1920 }
    : aspect === "1:1"
      ? { w: 1080, h: 1080 }
      : { w: 1920, h: 1080 };
}

/** Tokens resolved to pixels for a canvas. 1080×1920 -> caption 65 px, minimum 49 px. */
export function resolveDesign(
  tokens: DesignTokens,
  canvas: { w: number; h: number },
  aspect: DesignAspect = aspectOfCanvas(canvas.w, canvas.h),
): ResolvedDesign {
  const short = Math.min(canvas.w, canvas.h);
  const sz = tokens.safe_zone[aspect];
  const size = Math.round((short * tokens.caption.size_pct_short_side) / 100);
  return {
    aspect,
    canvas: { w: canvas.w, h: canvas.h },
    tokens,
    safe_zone_px: {
      top: Math.round((canvas.h * sz.top) / 100),
      bottom: Math.round((canvas.h * sz.bottom) / 100),
      left: Math.round((canvas.w * sz.left) / 100),
      right: Math.round((canvas.w * sz.right) / 100),
    },
    caption_px: {
      size,
      min_size: Math.round((short * tokens.caption.min_size_pct_short_side) / 100),
      outline: Math.max(1, Math.round((size * tokens.caption.outline_pct_size) / 100)),
      max_chars_line: tokens.caption.max_chars_line[aspect],
      max_lines: tokens.caption.max_lines,
    },
  };
}

/** px per CaptionStyle unit (sizes are "pixels of a 1080-px short side"). */
export function captionUnit(resolved: Pick<ResolvedDesign, "canvas">): number {
  return Math.min(resolved.canvas.w, resolved.canvas.h) / 1080;
}

// ---------------------------------------------------------------------------------------------
// Caption style <- tokens

const BUNDLED = new Set<string>(BUNDLED_FONT_FAMILIES);

export function isBundledFamily(family: string | undefined): boolean {
  return Boolean(family && BUNDLED.has(family));
}

/** Font size (CaptionStyle units) of the hard minimum: 4.5 % of 1080 = 48.6. */
export function minCaptionUnits(tokens: DesignTokens): number {
  return (tokens.caption.min_size_pct_short_side * 1080) / 100;
}

/** Caption style of the kit alone (no preset). */
export function kitCaptionStyle(tokens: DesignTokens): CaptionStyle {
  const size = Math.round((tokens.caption.size_pct_short_side * 1080) / 100);
  return {
    id: "kit",
    name: "Kit de marca",
    fontFamily: tokens.font.caption.family,
    fontSize: size,
    color: tokens.color.text,
    background: "",
    highlightColor: tokens.color.accent,
    position: "bottom",
    uppercase: false,
    animation: "none",
    outlineColor: tokens.color.text_outline,
    outlineWidth: round1((size * tokens.caption.outline_pct_size) / 100),
    box: false,
    maxLines: tokens.caption.max_lines,
    fromBrandKit: true,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Effective caption style = what ASS and Remotion draw. With the kit (`fromBrandKit` absent or
 * true) the tokens rule: caption family of the kit, size never below the hard minimum, outline
 * color/width and line count from the tokens unless the style sets them. With
 * `fromBrandKit: false` the style is used as is (missing fields still come from the tokens) and
 * the checklist reports what breaks the rules (export fixes the hard ones).
 */
export function captionStyleFromTokens(tokens: DesignTokens, preset?: CaptionStyle): CaptionStyle {
  if (!preset) return kitCaptionStyle(tokens);
  const kit = preset.fromBrandKit !== false;
  const fontSize = kit ? Math.max(preset.fontSize, minCaptionUnits(tokens)) : preset.fontSize;
  const box = preset.box ?? Boolean(preset.background?.trim());
  return {
    ...preset,
    fontFamily: kit ? tokens.font.caption.family : preset.fontFamily,
    fontSize,
    color: preset.color || tokens.color.text,
    background: box ? preset.background?.trim() || tokens.color.plate : "",
    outlineColor: preset.outlineColor ?? tokens.color.text_outline,
    outlineWidth: preset.outlineWidth ?? round1((fontSize * tokens.caption.outline_pct_size) / 100),
    box,
    maxLines: Math.min(preset.maxLines ?? tokens.caption.max_lines, tokens.caption.max_lines) as
      1 | 2,
    fromBrandKit: kit,
  };
}

/**
 * Font weight of the burned / previewed captions (audit S6 E1): the kit caption weight when the
 * style follows the kit, bold (700) otherwise — mapped to a face that exists (bundledFontWeight).
 * The ASS burn-in, the player preview and the kit preview all use this number.
 */
export function captionFontWeight(tokens: DesignTokens, style?: CaptionStyle): number {
  const eff = captionStyleFromTokens(tokens, style);
  const requested = eff.fromBrandKit !== false ? tokens.font.caption.weight : 700;
  return bundledFontWeight(eff.fontFamily, requested);
}

/** Average glyph width in em (estimate for line fitting; heavy weights, Latin text). */
const CHAR_EM: Record<string, number> = {
  Inter: 0.56,
  Montserrat: 0.6,
  Poppins: 0.6,
  Roboto: 0.53,
  Oswald: 0.42,
  "Playfair Display": 0.52,
  "Bebas Neue": 0.4,
  Anton: 0.45,
  "Archivo Black": 0.64,
  Bangers: 0.5,
};
const CAPS_ONLY = new Set(["Bebas Neue", "Bangers"]);

export function charWidthEm(family: string, uppercase: boolean): number {
  const base = CHAR_EM[family] ?? 0.58;
  return uppercase && !CAPS_ONLY.has(family) ? base * 1.18 : base;
}

/**
 * Characters per line for a style on a canvas: the token limit (30/34/42), lowered when the
 * estimated line would not fit between the side safe margins at that size.
 */
export function captionMaxChars(style: CaptionStyle, resolved: ResolvedDesign): number {
  const sizePx = style.fontSize * captionUnit(resolved);
  const width =
    resolved.canvas.w -
    resolved.safe_zone_px.left -
    resolved.safe_zone_px.right -
    2 * captionBorderPx(style, resolved);
  const fit = Math.floor(
    width / Math.max(1, sizePx * charWidthEm(style.fontFamily, style.uppercase)),
  );
  return Math.max(8, Math.min(resolved.caption_px.max_chars_line, fit));
}

/** Line height factor used by ASS and the checklist (text + outline). */
export const CAPTION_LINE_HEIGHT = 1.2;

export interface CaptionLayout {
  /** ASS numpad alignment (2 = bottom center, 8 = top center). */
  align: 2 | 8;
  marginL: number;
  marginR: number;
  marginV: number;
  blockTop: number;
  blockBottom: number;
}

/**
 * Where a caption page of `lines` lines goes (canvas pixels), inside the safe zone: bottom = on
 * the bottom safe line, top = under the top safe line, center = centered in the safe area.
 */
export function captionLayout(
  style: Pick<CaptionStyle, "position" | "fontSize"> &
    Partial<Pick<CaptionStyle, "box" | "outlineWidth">>,
  resolved: ResolvedDesign,
  lines: number,
): CaptionLayout {
  const { h } = resolved.canvas;
  const sz = resolved.safe_zone_px;
  const sizePx = style.fontSize * captionUnit(resolved);
  const border = captionBorderPx(style, resolved);
  // Text block + the outline (or the box padding) on both sides: all of it inside the safe zone.
  const block = Math.max(1, lines) * sizePx * CAPTION_LINE_HEIGHT + 2 * border;
  const base = { marginL: sz.left + border, marginR: sz.right + border };
  if (style.position === "top")
    return {
      ...base,
      align: 8,
      marginV: sz.top + border,
      blockTop: sz.top,
      blockBottom: sz.top + block,
    };
  if (style.position === "center") {
    const cy = (sz.top + (h - sz.bottom)) / 2;
    const bottom = Math.round(cy + block / 2);
    return {
      ...base,
      align: 2,
      marginV: h - bottom + border,
      blockTop: bottom - block,
      blockBottom: bottom,
    };
  }
  const bottom = h - sz.bottom;
  return {
    ...base,
    align: 2,
    marginV: sz.bottom + border,
    blockTop: bottom - block,
    blockBottom: bottom,
  };
}

/** Pixels the outline (or the box padding, 18 % of the size) adds around the text. */
export function captionBorderPx(
  style: Pick<CaptionStyle, "fontSize"> & Partial<Pick<CaptionStyle, "box" | "outlineWidth">>,
  resolved: Pick<ResolvedDesign, "canvas">,
): number {
  const unit = captionUnit(resolved);
  const sizePx = style.fontSize * unit;
  return style.box
    ? Math.max(2, Math.round(sizePx * 0.18))
    : Math.max(0, Math.round((style.outlineWidth ?? 0) * unit));
}

// ---------------------------------------------------------------------------------------------
// Caption pagination (hard rules: ≤ 2 lines, chars per line, pauses, punctuation, balance)

export interface PaginateWord {
  word?: string;
  text?: string;
  start: number;
  end: number;
}

export interface CaptionPage {
  text: string;
  lines: [string] | [string, string];
  start: number;
  end: number;
  words: { text: string; start: number; end: number }[];
}

export interface PaginateOptions {
  /** Characters per line (default: the token for the aspect; see captionMaxChars). */
  maxChars?: number;
  /** Karaoke / word-by-word: the reading-speed limit (cps) does not apply. */
  karaoke?: boolean;
  /** Pages never extend past this time (next segment start, clip end). */
  limitEnd?: number;
  /** Pages never start before this time (end of the previous segment's last page; audit E4). */
  limitStart?: number;
}

/**
 * Spanish words that must not end a line (article + noun, preposition + term, conjunctions,
 * possessives): «el | auto» never splits.
 */
const WEAK_WORDS = new Set(
  (
    "el la los las un una unos unas lo al del a ante bajo con contra de desde en entre hacia hasta " +
    "para por según segun sin sobre tras durante mediante y e o u ni que mi tu su mis tus sus " +
    "nuestro nuestra nuestros nuestras este esta estos estas ese esa esos esas muy más mas se no"
  ).split(" "),
);

const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

export function isWeakWord(word: string): boolean {
  const n = norm(word);
  return n !== "" && WEAK_WORDS.has(n);
}

const SENTENCE_END = /[.!?…]["»”')\]]*$/;
const CLAUSE_END = /[,;:]["»”')\]]*$/;

const joinLen = (words: { text: string }[]) =>
  words.reduce((n, w, i) => n + w.text.length + (i > 0 ? 1 : 0), 0);

/** Greedy wrap: number of lines needed (Infinity if a word alone is too long). */
function linesNeeded(words: { text: string }[], maxChars: number): number {
  let lines = 0;
  let cur = -1;
  for (const w of words) {
    if (w.text.length > maxChars) return Infinity;
    if (cur < 0 || cur + 1 + w.text.length > maxChars) {
      lines++;
      cur = w.text.length;
    } else cur += 1 + w.text.length;
  }
  return lines;
}

/** Split a page into 1 or 2 balanced lines; never ends line 1 with a weak word when avoidable. */
export function balanceLines(
  words: { text: string }[],
  maxChars: number,
  maxLines: 1 | 2 = 2,
): [string] | [string, string] {
  const all = words.map((w) => w.text).join(" ");
  if (words.length < 2 || all.length <= maxChars || maxLines === 1) return [all];
  let best: { k: number; score: number } | null = null;
  for (let k = 1; k < words.length; k++) {
    const a = joinLen(words.slice(0, k));
    const b = joinLen(words.slice(k));
    const over = Math.max(0, a - maxChars) + Math.max(0, b - maxChars);
    const weak = isWeakWord(words[k - 1]!.text) ? 1 : 0;
    // Overflow first, then weak endings, then balance (slightly prefer a shorter top line).
    const score = over * 10_000 + weak * 1_000 + Math.abs(a - b) + (a > b ? 0.5 : 0);
    if (!best || score < best.score) best = { k, score };
  }
  const k = best!.k;
  return [
    words
      .slice(0, k)
      .map((w) => w.text)
      .join(" "),
    words
      .slice(k)
      .map((w) => w.text)
      .join(" "),
  ];
}

/**
 * Word timings -> caption pages. A page ends on a pause ≥ page_break_pause_ms, at the end of a
 * sentence, at a comma once it is half full, when it would not fit in max_lines lines of
 * `maxChars`, or when it would last more than max_duration_s. Pages are then stretched (into the
 * following gap only) to reach min_duration_s and max_cps.
 */
export function paginateCaptions(
  words: readonly PaginateWord[],
  rules: CaptionRules,
  aspect: DesignAspect,
  opts: PaginateOptions = {},
): CaptionPage[] {
  const maxChars = opts.maxChars ?? rules.max_chars_line[aspect];
  const maxLines = rules.max_lines;
  const capacity = maxChars * maxLines;
  const list = words
    .map((w) => ({
      text: (w.text ?? w.word ?? "").trim(),
      start: w.start,
      end: Math.max(w.end, w.start),
    }))
    .filter((w) => w.text !== "");
  const groups: (typeof list)[] = [];
  let cur: typeof list = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (const w of list) {
    if (cur.length) {
      const prev = cur[cur.length - 1]!;
      const pause = (w.start - prev.end) * 1000;
      const tooLong = w.end - cur[0]!.start > rules.max_duration_s;
      const wouldFit = linesNeeded([...cur, w], maxChars) <= maxLines;
      const breakHere =
        pause >= rules.page_break_pause_ms ||
        SENTENCE_END.test(prev.text) ||
        (CLAUSE_END.test(prev.text) && joinLen(cur) >= capacity * 0.5) ||
        !wouldFit ||
        tooLong;
      if (breakHere) {
        // Capacity/length breaks never leave a weak word hanging at the end of the page.
        if (!wouldFit || tooLong) {
          const carry: typeof list = [];
          while (cur.length > 1 && isWeakWord(cur[cur.length - 1]!.text)) carry.unshift(cur.pop()!);
          flush();
          cur = carry;
          if (cur.length && linesNeeded([...cur, w], maxChars) > maxLines) flush();
        } else flush();
      }
    }
    cur.push(w);
  }
  flush();

  const pages: CaptionPage[] = groups.map((g) => ({
    text: g.map((w) => w.text).join(" "),
    lines: balanceLines(g, maxChars, maxLines),
    start: g[0]!.start,
    end: g[g.length - 1]!.end,
    words: g,
  }));
  // Timing: stretch into the gap after the page (never over the next page / limitEnd).
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    const limit = Math.min(pages[i + 1]?.start ?? Infinity, opts.limitEnd ?? Infinity);
    let want = Math.max(p.end, p.start + rules.min_duration_s);
    if (!opts.karaoke) want = Math.max(want, p.start + p.text.length / rules.max_cps);
    want = Math.min(want, p.start + rules.max_duration_s);
    p.end = Math.max(p.end, Math.min(want, limit));
  }
  if (!opts.karaoke)
    rebalancePages(pages, rules, opts.limitStart ?? -Infinity, opts.limitEnd ?? Infinity);
  return pages;
}

/** How much earlier / later than its first word a page may appear (audit S6 E4). */
export const CAPTION_PAGE_LEAD_S = 0.5;
export const CAPTION_PAGE_LAG_S = 0.3;

/**
 * Pages still too fast after stretching (fast speech leaves no gap after them) take time from
 * their neighbours: each page may appear up to CAPTION_PAGE_LEAD_S before its first word or
 * CAPTION_PAGE_LAG_S after it, within [lo, hi], and every page keeps what it needs (min duration
 * and max_cps). Earliest/latest feasible starts are computed both ways and the starts are moved
 * as little as possible; when the speech itself is faster than max_cps the pages keep their
 * natural starts (no solution) and the checklist reports them. Audit S6 E4.
 */
function rebalancePages(pages: CaptionPage[], rules: CaptionRules, lo: number, hi: number): void {
  const n = pages.length;
  if (n === 0) return;
  const need = pages.map((p) =>
    Math.min(rules.max_duration_s, Math.max(rules.min_duration_s, p.text.length / rules.max_cps)),
  );
  if (pages.every((p, i) => p.end - p.start >= need[i]! - 1e-4)) return;
  const w = pages.map((p) => p.words[0]!.start);
  const top = Number.isFinite(hi) ? hi : pages[n - 1]!.start + need[n - 1]! + CAPTION_PAGE_LAG_S;
  const E: number[] = [];
  for (let i = 0; i < n; i++)
    E[i] = Math.max(w[i]! - CAPTION_PAGE_LEAD_S, i ? E[i - 1]! + need[i - 1]! : Math.max(0, lo));
  const L: number[] = [];
  for (let i = n - 1; i >= 0; i--)
    L[i] = Math.min(w[i]! + CAPTION_PAGE_LAG_S, (i < n - 1 ? L[i + 1]! : top) - need[i]!);
  if (E.some((e, i) => e > L[i]! + 1e-6)) return; // too fast to fix by timing alone
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    const low = Math.max(E[i]!, i ? starts[i - 1]! + need[i - 1]! : E[i]!);
    starts[i] = Math.min(Math.max(pages[i]!.start, low), L[i]!);
  }
  for (let i = 0; i < n; i++) {
    const p = pages[i]!;
    const nextStart = i < n - 1 ? starts[i + 1]! : top;
    p.start = round3(starts[i]!);
    p.end = round3(Math.min(nextStart, Math.max(p.end, starts[i]! + need[i]!)));
  }
}

/** Words of a segment (measured, or spread over the segment by length when absent). */
export function segmentWords(seg: SubtitleSegment): PaginateWord[] {
  const measured = seg.words?.filter((w) => w.word.trim() !== "");
  if (measured && measured.length) return measured;
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1;
  const span = Math.max(0, seg.end - seg.start);
  let t = seg.start;
  return tokens.map((tok) => {
    const d = (span * (tok.length + 1)) / total;
    const w = { word: tok, start: t, end: t + d };
    t += d;
    return w;
  });
}

/**
 * Pages for every subtitle segment (each segment paginated alone, bounded by the next segment's
 * start and by the previous segment's last page).
 */
export function paginateSegments(
  segments: readonly SubtitleSegment[],
  rules: CaptionRules,
  aspect: DesignAspect,
  opts: Omit<PaginateOptions, "limitEnd" | "limitStart"> & { limitEnd?: number } = {},
): CaptionPage[] {
  const live = segments
    .filter((s) => s.end > s.start && s.text.trim() !== "")
    .slice()
    .sort((a, b) => a.start - b.start);
  const out: CaptionPage[] = [];
  live.forEach((s, i) => {
    out.push(
      ...paginateCaptions(segmentWords(s), rules, aspect, {
        ...opts,
        limitEnd: Math.min(live[i + 1]?.start ?? Infinity, opts.limitEnd ?? Infinity),
        limitStart: out.at(-1)?.end ?? -Infinity,
      }),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Auto-fix and checklist

function boxAlpha(style: CaptionStyle): number {
  return parseCssColor(style.background)?.a ?? 0;
}

function withAlpha(color: string, alpha: number): string {
  const c = parseCssColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return `rgba(${c.r},${c.g},${c.b},${Math.round(alpha * 100) / 100})`;
}

function outlineOk(style: CaptionStyle, rules: CaptionRules): boolean {
  const need = (style.fontSize * rules.outline_pct_size) / 100;
  return (style.outlineWidth ?? 0) > 0 && (style.outlineWidth ?? 0) >= need * 0.95;
}

function contrastOf(style: CaptionStyle): number {
  return contrastRatio(style.color, style.box ? style.background : (style.outlineColor ?? "#000"));
}

/** Fix the hard rules of an (effective) caption style: size, outline or box, contrast, lines. */
export function autofixCaptionStyle(style: CaptionStyle, resolved: ResolvedDesign): CaptionStyle {
  const t = resolved.tokens;
  const rules = t.caption;
  const out: CaptionStyle = { ...style };
  out.fontSize = Math.max(out.fontSize, Math.ceil(minCaptionUnits(t)));
  if (out.box) {
    if (boxAlpha(out) < rules.box_min_alpha)
      out.background = withAlpha(
        out.background || t.color.plate,
        Math.max(rules.box_min_alpha, 0.7),
      );
  } else if (!outlineOk(out, rules)) {
    out.outlineWidth = round1((out.fontSize * rules.outline_pct_size) / 100);
    out.outlineColor = out.outlineColor ?? t.color.text_outline;
  }
  if (contrastOf(out) < rules.min_contrast) {
    if (out.box) {
      const bg = out.background;
      out.color =
        contrastRatio("#FFFFFF", bg) >= contrastRatio("#000000", bg) ? "#FFFFFF" : "#000000";
      if (contrastOf(out) < rules.min_contrast)
        out.background = withAlpha("#000000", Math.max(boxAlpha(out), rules.box_min_alpha));
      if (contrastOf(out) < rules.min_contrast) out.color = "#FFFFFF";
    } else {
      const bright = relativeLuminance(out.color) > 0.18;
      out.outlineColor = bright ? "#000000" : "#FFFFFF";
      if (contrastOf(out) < rules.min_contrast) {
        out.color = "#FFFFFF";
        out.outlineColor = "#000000";
      }
    }
  }
  if ((out.maxLines ?? rules.max_lines) > rules.max_lines) out.maxLines = rules.max_lines;
  return out;
}

/** Minimum on-screen time of a title: max(min_duration_s, s_per_word × words + extra_s). */
export function titleMinDuration(text: string, tokens: DesignTokens): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const r = tokens.title;
  return Math.max(r.min_duration_s, r.s_per_word * words + r.extra_s);
}

/** Templates that put titles on screen (title.* rules) and the kit font role they use. */
export const TITLE_TEMPLATE_FONT_ROLE: Record<string, keyof DesignTokens["font"]> = {
  "title-card": "title",
  "lower-third": "body",
  "end-screen": "title",
  "kinetic-typography": "display",
};

/** Kit font role used by each template for its default `fontFamily` (animated-captions = caption). */
export function templateFontRole(template: string): keyof DesignTokens["font"] | undefined {
  return template === "animated-captions" ? "caption" : TITLE_TEMPLATE_FONT_ROLE[template];
}

/**
 * Tokens handed to Remotion templates as the internal `__design` prop (props explicitly set on
 * the clip still win). `safe_zone` is the one of the render aspect.
 */
export interface TemplateDesign {
  font: DesignTokens["font"];
  color: DesignTokens["color"];
  safe_zone: SafeZone;
  motion: DesignTokens["motion"];
  caption: { size_px_1080: number; min_size_px_1080: number; outline_pct_size: number };
}

export function templateDesign(tokens: DesignTokens, aspect: DesignAspect): TemplateDesign {
  return {
    font: tokens.font,
    color: tokens.color,
    safe_zone: tokens.safe_zone[aspect],
    motion: tokens.motion,
    caption: {
      size_px_1080: Math.round((tokens.caption.size_pct_short_side * 1080) / 100),
      min_size_px_1080: Math.ceil(minCaptionUnits(tokens)),
      outline_pct_size: tokens.caption.outline_pct_size,
    },
  };
}

const clipDuration = (c: Clip) => (c.out - c.in) / (c.speed || 1);

const COLOR_KEY = /colou?r$/i;
/** Two colors this close (RGB distance) count as the same kit color. */
const KIT_COLOR_TOLERANCE = 48;

interface Collected {
  issues: DesignIssue[];
  fixes: (() => void)[];
}

function issue(
  c: Collected,
  rule: DesignRuleId,
  target: DesignIssue["target"],
  message_es: string,
  fix?: () => void,
  measured?: number,
  limit?: number,
) {
  const def = DESIGN_RULES.find((r) => r.id === rule)!;
  c.issues.push({
    rule,
    severity: def.severity,
    target,
    message_es: message_es.slice(0, 300),
    autofix: Boolean(fix),
    ...(measured !== undefined && { measured: Math.round(measured * 100) / 100 }),
    ...(limit !== undefined && { limit: Math.round(limit * 100) / 100 }),
  });
  if (fix) c.fixes.push(fix);
}

const fmt = (n: number, d = 1) => n.toFixed(d).replace(".", ",");

/** Visible motion clips of the project. */
function motionClips(project: Project): Clip[] {
  return project.tracks
    .filter((t) => t.kind === "motion" && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c) => c.motion);
}

export interface CheckDesignOptions {
  /** Burned subtitles (default: project.burnSubtitles ?? no animated-captions clip). */
  burnSubtitles?: boolean;
}

/**
 * The 10-rule design checklist (criterion C2) of a project for an aspect (default: its canvas).
 * Returns the result and, applied on a copy, the project with every automatic fix.
 */
export function checkDesignWithFix(
  project: Project,
  kit: BrandKit,
  aspect?: DesignAspect,
  opts: CheckDesignOptions = {},
): { result: DesignCheckResult; fixed: Project; fixedCount: number } {
  const copy: Project = structuredClone(project);
  const canvasAspect = aspectOfCanvas(copy.settings.width, copy.settings.height);
  const asp = aspect ?? canvasAspect;
  const canvas =
    asp === canvasAspect
      ? { w: copy.settings.width, h: copy.settings.height }
      : canvasForAspect(asp);
  const resolved = resolveDesign(kit.tokens, canvas, asp);
  const t = kit.tokens;
  const rules = t.caption;
  const c: Collected = { issues: [], fixes: [] };
  const families = new Set<string>();
  const unit = captionUnit(resolved);

  // --- Captions (burned subtitles) ---------------------------------------------------------
  const animated = motionClips(copy).filter((m) => m.motion!.template === "animated-captions");
  const burn = opts.burnSubtitles ?? copy.burnSubtitles ?? animated.length === 0;
  if (burn && copy.subtitles.some((s) => s.text.trim() !== "")) {
    const eff = captionStyleFromTokens(t, copy.captionStyle);
    families.add(eff.fontFamily);
    const target = { kind: "caption" as const };
    const fixStyle = () => {
      copy.captionStyle = autofixCaptionStyle(
        captionStyleFromTokens(t, copy.captionStyle),
        resolved,
      );
    };
    if ((eff.maxLines ?? rules.max_lines) > rules.max_lines)
      issue(c, "caption.max_lines", target, "El estilo pide más de 2 líneas.", fixStyle);
    const sizePx = eff.fontSize * unit;
    if (sizePx + 0.5 < resolved.caption_px.min_size)
      issue(
        c,
        "caption.min_size",
        target,
        `La letra mide ${Math.round(sizePx)} px; el mínimo es ${resolved.caption_px.min_size} px (4,5 % del lado corto).`,
        fixStyle,
        sizePx,
        resolved.caption_px.min_size,
      );
    if (eff.box ? boxAlpha(eff) < rules.box_min_alpha : !outlineOk(eff, rules))
      issue(
        c,
        "caption.outline_or_box",
        target,
        eff.box
          ? `La caja es demasiado transparente (${fmt(boxAlpha(eff), 2)}; mínimo ${fmt(rules.box_min_alpha, 2)}).`
          : "El texto no tiene contorno suficiente: se pierde sobre fondos claros.",
        fixStyle,
      );
    const contrast = contrastOf(eff);
    if (contrast < rules.min_contrast)
      issue(
        c,
        "caption.contrast",
        target,
        `Contraste ${fmt(contrast)}:1; hace falta al menos ${fmt(rules.min_contrast)}:1.`,
        fixStyle,
        contrast,
        rules.min_contrast,
      );
    // Pages exactly as ASS/Remotion will draw them (after the auto-fixes of generation).
    const drawn = autofixCaptionStyle(eff, resolved);
    const maxChars = captionMaxChars(drawn, resolved);
    const pages = paginateSegments(copy.subtitles, rules, asp, {
      maxChars,
      karaoke: drawn.animation === "karaoke",
    });
    pages.forEach((p, i) => {
      const at = {
        kind: "caption" as const,
        segmentIndex: i,
        t_s: Math.round(p.start * 100) / 100,
      };
      if (p.lines.length > rules.max_lines)
        issue(
          c,
          "caption.max_lines",
          at,
          `«${p.text.slice(0, 40)}» ocupa ${p.lines.length} líneas.`,
        );
      const longest = Math.max(...p.lines.map((l) => l.length));
      if (longest > resolved.caption_px.max_chars_line)
        issue(
          c,
          "caption.chars_per_line",
          at,
          `Una línea tiene ${longest} caracteres (máximo ${resolved.caption_px.max_chars_line}).`,
          undefined,
          longest,
          resolved.caption_px.max_chars_line,
        );
      const lay = captionLayout(drawn, resolved, p.lines.length);
      const width =
        longest * drawn.fontSize * unit * charWidthEm(drawn.fontFamily, drawn.uppercase) +
        2 * captionBorderPx(drawn, resolved);
      const sz = resolved.safe_zone_px;
      if (
        lay.blockTop < sz.top - 1 ||
        lay.blockBottom > canvas.h - sz.bottom + 1 ||
        width > canvas.w - sz.left - sz.right + 1
      )
        issue(c, "caption.safe_zone", at, `«${p.text.slice(0, 40)}» se sale de la zona segura.`);
      const dur = p.end - p.start;
      const cps = p.text.length / Math.max(0.01, dur);
      if (dur + 0.005 < rules.min_duration_s || dur - 0.005 > rules.max_duration_s)
        issue(
          c,
          "caption.timing",
          at,
          `«${p.text.slice(0, 40)}» dura ${fmt(dur, 2)} s (entre ${fmt(rules.min_duration_s, 2)} y ${fmt(rules.max_duration_s)} s).`,
          undefined,
          dur,
        );
      else if (drawn.animation !== "karaoke" && cps > rules.max_cps + 0.05)
        issue(
          c,
          "caption.timing",
          at,
          `«${p.text.slice(0, 40)}» se lee a ${fmt(cps)} caracteres por segundo (máximo ${rules.max_cps}).`,
          undefined,
          cps,
          rules.max_cps,
        );
    });
  }

  // --- Motion clips --------------------------------------------------------------------------
  const sz = t.safe_zone[asp];
  for (const clip of motionClips(copy)) {
    const m = clip.motion!;
    const props = m.props as Record<string, unknown>;
    const target = { kind: "motion" as const, clipId: clip.id, t_s: clip.start };
    const role = templateFontRole(m.template);
    if (role) {
      const fam = typeof props.fontFamily === "string" ? props.fontFamily : t.font[role].family;
      families.add(fam);
    }
    if (m.template === "animated-captions") {
      const size = typeof props.fontSize === "number" ? props.fontSize : undefined;
      if (size !== undefined && size + 0.5 < minCaptionUnits(t))
        issue(
          c,
          "caption.min_size",
          target,
          `Los subtítulos animados miden ${Math.round(size)} px a 1080; el mínimo es ${Math.ceil(minCaptionUnits(t))}.`,
          () => delete props.fontSize,
          size,
          minCaptionUnits(t),
        );
      const stroke = typeof props.strokeWidth === "number" ? props.strokeWidth : undefined;
      const style = typeof props.style === "string" ? props.style : "highlight";
      if (stroke !== undefined && stroke <= 0 && style !== "box")
        issue(
          c,
          "caption.outline_or_box",
          target,
          "Los subtítulos animados no tienen borde.",
          () => {
            delete props.strokeWidth;
          },
        );
      const tc = typeof props.textColor === "string" ? props.textColor : t.color.text;
      const sc = typeof props.strokeColor === "string" ? props.strokeColor : t.color.text_outline;
      if (contrastRatio(tc, sc) < rules.min_contrast)
        issue(c, "caption.contrast", target, "Poco contraste entre el texto y su borde.", () => {
          delete props.textColor;
          delete props.strokeColor;
        });
      const sa = props.safeArea as SafeZone | undefined;
      if (
        sa &&
        (sa.top < sz.top || sa.bottom < sz.bottom || sa.left < sz.left || sa.right < sz.right)
      )
        issue(
          c,
          "caption.safe_zone",
          target,
          "La zona segura de los subtítulos animados es menor que la del kit.",
          () => {
            delete props.safeArea;
          },
        );
      continue;
    }
    if (!(m.template in TITLE_TEMPLATE_FONT_ROLE)) continue;
    // title.safe_zone: explicit margins below the kit safe zone (absent = the kit's).
    const margin = typeof props.marginPct === "number" ? props.marginPct : undefined;
    const sa = props.safeArea as SafeZone | undefined;
    if (m.template === "lower-third" && margin !== undefined) {
      const pos = typeof props.position === "string" ? props.position : "bottom-left";
      const needV = pos.startsWith("top") ? sz.top : sz.bottom;
      const needH = pos.endsWith("center") ? 0 : pos.endsWith("left") ? sz.left : sz.right;
      if (margin < Math.max(needV, needH))
        issue(
          c,
          "title.safe_zone",
          target,
          `El rótulo tiene un margen de ${fmt(margin)} %; la zona segura pide ${fmt(Math.max(needV, needH))} %.`,
          () => delete props.marginPct,
          margin,
          Math.max(needV, needH),
        );
    } else if (
      sa &&
      (sa.top < sz.top || sa.bottom < sz.bottom || sa.left < sz.left || sa.right < sz.right)
    )
      issue(
        c,
        "title.safe_zone",
        target,
        "El título usa una zona segura menor que la del kit.",
        () => {
          delete props.safeArea;
        },
      );
    // title.duration (guide).
    const dur = clipDuration(clip);
    if (m.template === "lower-third") {
      if (dur + 0.01 < t.title.lower_third_min_s)
        issue(
          c,
          "title.duration",
          target,
          `El rótulo dura ${fmt(dur)} s; conviene al menos ${fmt(t.title.lower_third_min_s)} s.`,
          undefined,
          dur,
          t.title.lower_third_min_s,
        );
    } else {
      const text = [props.title, props.subtitle, props.text]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      const need = titleMinDuration(text, t);
      if (dur + 0.01 < need)
        issue(
          c,
          "title.duration",
          target,
          `El título dura ${fmt(dur)} s; para leerlo hacen falta ${fmt(need)} s.`,
          undefined,
          dur,
          need,
        );
    }
    // brand.consistency: explicit colors far from the kit colors (guide; fix = use the kit's).
    const colors = kitColors(t);
    for (const [k, v] of Object.entries(props)) {
      if (!COLOR_KEY.test(k) || typeof v !== "string" || !v.startsWith("#")) continue;
      if (!isNeutral(v) && colors.every((kc) => colorDistance(kc, v) > KIT_COLOR_TOLERANCE))
        issue(c, "brand.consistency", target, `El color ${v} no es del kit de marca.`, () => {
          delete props[k];
        });
    }
  }

  // --- Text clips (fonts only) ----------------------------------------------------------------
  for (const tr of copy.tracks.filter((x) => x.kind === "text" && !x.hidden))
    for (const clip of tr.clips)
      if (clip.text?.trim()) families.add(clip.textStyle?.fontFamily ?? "Inter");

  // --- brand.consistency: ≤ 2 families, all bundled -------------------------------------------
  const notBundled = [...families].filter((f) => !isBundledFamily(f));
  if (notBundled.length)
    issue(
      c,
      "brand.consistency",
      { kind: "text" },
      `Tipografías que no vienen con Studio: ${notBundled.join(", ")}.`,
    );
  if (families.size > 2)
    issue(
      c,
      "brand.consistency",
      { kind: "text" },
      `Se usan ${families.size} tipografías (${[...families].join(", ")}); el kit recomienda 2 como mucho.`,
      undefined,
      families.size,
      2,
    );

  const rulesOut = DESIGN_RULE_IDS.map((id) => {
    const n = c.issues.filter((i) => i.rule === id).length;
    return { id, passed: n === 0, issues: n };
  });
  for (const f of c.fixes) f();
  const fixedCount = c.fixes.length;
  return {
    result: {
      aspect: asp,
      rules: rulesOut,
      passed: rulesOut.filter((r) => r.passed).length,
      issues: c.issues,
      fixed: 0,
      checkedAt: new Date().toISOString(),
    },
    fixed: copy,
    fixedCount,
  };
}

/** The 10-rule design checklist (no changes). */
export function checkDesign(
  project: Project,
  kit: BrandKit,
  aspect?: DesignAspect,
  opts?: CheckDesignOptions,
): DesignCheckResult {
  return checkDesignWithFix(project, kit, aspect, opts).result;
}

/** Design tokens as a DTCG 2025.10 tree (Figma / Tokens Studio export). */
export function toDtcg(tokens: DesignTokens): Record<string, unknown> {
  const color = (v: string) => ({ $type: "color", $value: v });
  const dim = (v: number, unit: string) => ({ $type: "dimension", $value: { value: v, unit } });
  const font = (f: { family: string; weight: number }) => ({
    family: { $type: "fontFamily", $value: f.family },
    weight: { $type: "fontWeight", $value: f.weight },
  });
  return {
    color: {
      text: color(tokens.color.text),
      "text-outline": color(tokens.color.text_outline),
      accent: color(tokens.color.accent),
      plate: color(tokens.color.plate),
      palette: Object.fromEntries(tokens.color.palette.map((c, i) => [String(i + 1), color(c)])),
    },
    font: Object.fromEntries(Object.entries(tokens.font).map(([k, f]) => [k, font(f)])),
    caption: {
      "size-pct": { $type: "number", $value: tokens.caption.size_pct_short_side },
      "min-size-pct": { $type: "number", $value: tokens.caption.min_size_pct_short_side },
      "max-lines": { $type: "number", $value: tokens.caption.max_lines },
    },
    "safe-zone": Object.fromEntries(
      Object.entries(tokens.safe_zone).map(([a, z]) => [
        a,
        Object.fromEntries(Object.entries(z).map(([k, v]) => [k, dim(v, "%")])),
      ]),
    ),
    motion: {
      enter: { $type: "duration", $value: { value: tokens.motion.enter_ms, unit: "ms" } },
      exit: { $type: "duration", $value: { value: tokens.motion.exit_ms, unit: "ms" } },
    },
  };
}
