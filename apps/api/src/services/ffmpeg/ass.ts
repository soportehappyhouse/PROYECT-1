import {
  autofixCaptionStyle,
  captionLayout,
  captionMaxChars,
  captionStyleFromTokens,
  DEFAULT_DESIGN_TOKENS,
  kitCaptionStyle,
  paginateCaptions,
  resolveDesign,
  segmentWords,
  type CaptionStyle,
  type DesignTokens,
  type Rect,
  type Size,
  type SubtitleSegment,
} from "@studio/shared";
import { escapeFilterPath } from "./escape.js";

/**
 * Burned subtitles as a real ASS script (feedback 3/4). SRT + `force_style` was unreliable:
 * libass stores `Alignment` with the legacy SSA codes, so the numpad values 5/8 written there
 * landed top-left / middle-left. A [V4+ Styles] script is parsed with numpad alignment, uses the
 * canvas as PlayRes (sizes in canvas pixels) and carries per-event margins, so the text stays
 * inside the video rect (pillar/letterbox of a vertical clip in a 16:9 canvas) and wraps there.
 */

/** Numpad alignment of a caption position (ASS v4+). */
export const ASS_ALIGNMENT: Record<CaptionStyle["position"], number> = {
  bottom: 2,
  center: 5,
  top: 8,
};

/** "#rgb" / "#rrggbb" / "#rrggbbaa" / "rgb(a)(…)" -> ASS "&HAABBGGRR" (alpha 00 = opaque). */
export function cssColorToAss(input: string | undefined, fallback = "&H00FFFFFF"): string {
  const v = (input ?? "").trim().toLowerCase();
  let r: number, g: number, b: number;
  let a = 1;
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v))) {
    [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h + h, 16)) as [number, number, number];
  } else if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(v))) {
    [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16)) as [number, number, number];
    if (m[4]) a = parseInt(m[4], 16) / 255;
  } else if (
    (m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v))
  ) {
    [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => Math.min(255, Math.round(Number(x)))) as [
      number,
      number,
      number,
    ];
    if (m[4]) a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  } else return fallback;
  const hex = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `&H${hex(255 * (1 - Math.min(1, Math.max(0, a))))}${hex(b)}${hex(g)}${hex(r)}`;
}

/** "H:MM:SS.cc" (ASS centiseconds). */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}.${p(cs % 100)}`;
}

/** Dialogue text: line breaks -> \N, no override blocks or stray escapes from user text. */
export function assText(text: string): string {
  return text
    .replace(/\r/g, "")
    .trim()
    .replace(/\\/g, "⧵")
    .replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"))
    .replace(/\n/g, "\\N");
}

export interface AssMargins {
  left: number;
  right: number;
  vertical: number;
}

/** Margins that keep text inside `rect` (plus a title-safe inner padding). */
export function marginsForRect(
  rect: Rect,
  canvas: Size,
  position: CaptionStyle["position"],
): AssMargins {
  const padX = rect.width * 0.05;
  const padY = rect.height * 0.07;
  const left = Math.max(0, Math.round(rect.x + padX));
  const right = Math.max(0, Math.round(canvas.width - rect.x - rect.width + padX));
  const vertical = Math.max(
    0,
    Math.round(
      position === "top"
        ? rect.y + padY
        : position === "bottom"
          ? canvas.height - rect.y - rect.height + padY
          : 0,
    ),
  );
  return { left, right, vertical };
}

export interface BuildAssOptions {
  canvas: Size;
  style?: Partial<CaptionStyle>;
  /** Video rect for a timeline time (where the captions must fit). Default: the whole canvas. */
  rectAt?: (t: number) => Rect;
  /** Sprint 6 M2: design tokens (default: the brand kit registered with setAssDesign). */
  tokens?: DesignTokens;
}

// ---------------------------------------------------------------------------------------------
// Sprint 6 M2: brand kit + bundled fonts for the burn-in (routes/design.ts registers them).

interface AssDesign {
  tokens: () => DesignTokens;
  /** Flat folder with the bundled TTFs (libass `fontsdir` is not recursive). */
  fontsDir: string | null;
}

let assDesign: AssDesign = { tokens: () => DEFAULT_DESIGN_TOKENS, fontsDir: null };

export function setAssDesign(next: Partial<AssDesign>): void {
  assDesign = { ...assDesign, ...next };
}

export function currentAssTokens(): DesignTokens {
  try {
    return assDesign.tokens();
  } catch {
    return DEFAULT_DESIGN_TOKENS;
  }
}

/**
 * `subtitles=<file>` + `fontsdir=<bundled fonts>` (escaped absolute path, Windows-safe), so the
 * burn-in uses the same OFL families as Remotion and the preview, never the system fonts.
 */
export function assSubtitlesFilter(file: string, fontsDir = assDesign.fontsDir): string {
  return fontsDir
    ? `subtitles=${file}:fontsdir=${escapeFilterPath(fontsDir)}`
    : `subtitles=${file}`;
}

const DEFAULT_POSITION: CaptionStyle["position"] = "bottom";

/**
 * ASS script for `segments`. Sprint 6 M2: the style is the effective one of the brand kit
 * (captionStyleFromTokens) with the hard design rules auto-fixed (size, outline/box, contrast);
 * captions are paginated by paginateCaptions (≤ 2 balanced lines, pauses, reading speed) and
 * written as explicit lines (`WrapStyle: 2`, no libass wrapping), inside the kit safe zone.
 * Sizes are in pixels of a 1080-px short side (CaptionStyle contract), scaled to the video rect.
 */
export function buildAss(segments: readonly SubtitleSegment[], o: BuildAssOptions): string {
  const tokens = o.tokens ?? currentAssTokens();
  const full: Rect = { x: 0, y: 0, width: o.canvas.width, height: o.canvas.height };
  const rectAt = o.rectAt ?? (() => full);
  const resolved = resolveDesign(tokens, { w: o.canvas.width, h: o.canvas.height });
  // A partial style is completed with the kit style (outline/box/lines stay derived from tokens).
  const kitBase = kitCaptionStyle(tokens);
  delete kitBase.outlineWidth;
  delete kitBase.outlineColor;
  delete kitBase.box;
  delete kitBase.maxLines;
  delete kitBase.fromBrandKit;
  const base = o.style ? ({ ...kitBase, ...o.style } as CaptionStyle) : undefined;
  const st = autofixCaptionStyle(captionStyleFromTokens(tokens, base), resolved);
  const live = segments.filter((s) => s.end > s.start && s.text.trim() !== "");
  const first = live[0] ? rectAt((live[0].start + live[0].end) / 2) : full;
  const unit = Math.min(first.width, first.height) / 1080;
  const fontSize = Math.max(8, Math.round(st.fontSize * unit));
  const box = Boolean(st.box);
  const back = cssColorToAss(st.background, "&H80000000");
  const position = st.position ?? DEFAULT_POSITION;
  const outline = box
    ? Math.max(2, Math.round(fontSize * 0.18))
    : Math.max(1, Math.round((st.outlineWidth ?? 0) * unit));
  const font = (st.fontFamily || tokens.font.caption.family).replace(/,/g, " ");
  // Kit weight (900 = Black) when the family comes from the kit; bold otherwise.
  const bold = st.fromBrandKit !== false ? tokens.font.caption.weight : -1;
  // Layout in the video rect's own pixels (pillarbox/letterbox), with the canvas safe zone.
  const rectDesign = (rect: Rect) => {
    const r = resolveDesign(
      tokens,
      { w: Math.round(rect.width), h: Math.round(rect.height) },
      resolved.aspect,
    );
    return { ...r, canvas: { w: Math.round(rect.width), h: Math.round(rect.height) } };
  };
  const marginsFor = (rect: Rect, lines: number) => {
    const rd = rectDesign(rect);
    const lay = captionLayout(
      { position, fontSize: st.fontSize, box, outlineWidth: st.outlineWidth ?? 0 },
      rd,
      lines,
    );
    const left = Math.round(rect.x + lay.marginL);
    const right = Math.round(o.canvas.width - rect.x - rect.width + lay.marginR);
    const vertical =
      lay.align === 8
        ? Math.round(rect.y + lay.marginV)
        : Math.round(o.canvas.height - rect.y - rect.height + lay.marginV);
    return {
      left: Math.max(0, left),
      right: Math.max(0, right),
      vertical: Math.max(0, vertical),
      align: lay.align,
    };
  };
  const m0 = marginsFor(first, 1);
  const style = [
    "Default",
    font,
    fontSize,
    cssColorToAss(st.color),
    "&H000000FF",
    box ? back : cssColorToAss(st.outlineColor, "&H00000000"),
    box ? back : "&H64000000",
    bold,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    box ? 3 : 1,
    outline,
    0,
    m0.align,
    m0.left,
    m0.right,
    m0.vertical,
    1,
  ].join(",");
  const events: string[] = [];
  const karaoke = st.animation === "karaoke";
  const sorted = live.slice().sort((a, b) => a.start - b.start);
  sorted.forEach((s, i) => {
    const rect = rectAt((s.start + s.end) / 2);
    const rd = rectDesign(rect);
    const maxChars = captionMaxChars(st, rd);
    const pages = paginateCaptions(segmentWords(s), tokens.caption, resolved.aspect, {
      maxChars,
      karaoke,
      limitEnd: sorted[i + 1]?.start ?? Infinity,
    });
    for (const p of pages) {
      const mm = marginsFor(rect, p.lines.length);
      const align = mm.align === m0.align ? "" : `{\\an${mm.align}}`;
      // Word timings keep the original case: «Mayúsculas» applies to the drawn lines.
      const lines = st.uppercase ? p.lines.map((l) => l.toLocaleUpperCase("es")) : p.lines;
      const text = lines.map(assText).join("\\N");
      events.push(
        `Dialogue: 0,${assTime(p.start)},${assTime(p.end)},Default,,${mm.left},${mm.right},${mm.vertical},,${align}${text}`,
      );
    }
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${o.canvas.width}`,
    `PlayResY: ${o.canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
