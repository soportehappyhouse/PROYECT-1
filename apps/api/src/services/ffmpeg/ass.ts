import type { CaptionStyle, Rect, Size, SubtitleSegment } from "@studio/shared";

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

const DEFAULT_STYLE: Pick<
  CaptionStyle,
  "fontFamily" | "fontSize" | "color" | "background" | "position"
> = {
  fontFamily: "Inter",
  fontSize: 60,
  color: "#ffffff",
  background: "",
  position: "bottom",
};

export interface BuildAssOptions {
  canvas: Size;
  style?: Partial<CaptionStyle>;
  /** Video rect for a timeline time (where the captions must fit). Default: the whole canvas. */
  rectAt?: (t: number) => Rect;
}

/**
 * ASS script for `segments`. `style.fontSize` is in pixels of a 1080-px frame (CaptionStyle
 * contract) and scales with the shorter side of the video rect, like the Remotion captions.
 */
export function buildAss(segments: readonly SubtitleSegment[], o: BuildAssOptions): string {
  const st = { ...DEFAULT_STYLE, ...o.style };
  const full: Rect = { x: 0, y: 0, width: o.canvas.width, height: o.canvas.height };
  const rectAt = o.rectAt ?? (() => full);
  const live = segments.filter((s) => s.end > s.start && s.text.trim() !== "");
  const first = live[0] ? rectAt((live[0].start + live[0].end) / 2) : full;
  const unit = Math.min(first.width, first.height) / 1080;
  const fontSize = Math.max(8, Math.round(st.fontSize * unit));
  const box = Boolean(st.background?.trim());
  const back = cssColorToAss(st.background, "&H80000000");
  const align = ASS_ALIGNMENT[st.position ?? "bottom"] ?? 2;
  const m = marginsForRect(first, o.canvas, st.position ?? "bottom");
  const outline = box
    ? Math.max(2, Math.round(fontSize * 0.18))
    : Math.max(1, Math.round(fontSize * 0.06));
  const font = (st.fontFamily || "Inter").replace(/,/g, " ");
  const style = [
    "Default",
    font,
    fontSize,
    cssColorToAss(st.color),
    "&H000000FF",
    box ? back : "&H00000000",
    box ? back : "&H64000000",
    -1, // bold
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
    align,
    m.left,
    m.right,
    m.vertical,
    1,
  ].join(",");
  const events = live.map((s) => {
    const mm = marginsForRect(rectAt((s.start + s.end) / 2), o.canvas, st.position ?? "bottom");
    return `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Default,,${mm.left},${mm.right},${mm.vertical},,${assText(s.text)}`;
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${o.canvas.width}`,
    `PlayResY: ${o.canvas.height}`,
    "WrapStyle: 0",
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
