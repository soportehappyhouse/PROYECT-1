// Sprint 6 M2: brand-kit tokens -> template props (browser + Node, pure). Props explicitly set on
// the clip always win; absent token-backed props take the kit value (`__design`, injected by the
// api) or, without a kit, the built-in default each template had before Sprint 6.
import type {
  CaptionPageMeta,
  DesignMeta,
  FontFamily,
  RenderMetaProps,
} from "../schemas/common.js";

type Path =
  | "font.title"
  | "font.caption"
  | "font.body"
  | "font.display"
  | "color.text"
  | "color.text_outline"
  | "color.accent"
  | "motion.enter_s"
  | "motion.exit_s"
  | "safe_zone";

interface TokenProp {
  token: Path;
  /** Value without a kit (= the pre-Sprint 6 default). */
  legacy: unknown;
}

/** Token-backed props of each template. */
export const TOKEN_PROPS: Record<string, Record<string, TokenProp>> = {
  "title-card": {
    fontFamily: { token: "font.title", legacy: "Montserrat" },
    titleColor: { token: "color.text", legacy: "#ffffff" },
    accentColor: { token: "color.accent", legacy: "#e13238" },
  },
  "lower-third": {
    fontFamily: { token: "font.body", legacy: "Inter" },
    textColor: { token: "color.text", legacy: "#ffffff" },
    accentColor: { token: "color.accent", legacy: "#e13238" },
    inSec: { token: "motion.enter_s", legacy: 0.6 },
    outSec: { token: "motion.exit_s", legacy: 0.5 },
  },
  "animated-captions": {
    fontFamily: { token: "font.caption", legacy: "Montserrat" },
    textColor: { token: "color.text", legacy: "#ffffff" },
    highlightColor: { token: "color.accent", legacy: "#ffd400" },
    strokeColor: { token: "color.text_outline", legacy: "#000000" },
    safeArea: { token: "safe_zone", legacy: undefined },
  },
  "end-screen": {
    fontFamily: { token: "font.title", legacy: "Poppins" },
    textColor: { token: "color.text", legacy: "#ffffff" },
    accentColor: { token: "color.accent", legacy: "#e13238" },
  },
  "kinetic-typography": {
    fontFamily: { token: "font.display", legacy: "Bebas Neue" },
  },
};

function tokenValue(d: DesignMeta, path: Path): unknown {
  switch (path) {
    case "font.title":
    case "font.caption":
    case "font.body":
    case "font.display":
      return d.font[path.slice(5) as "title"].family satisfies FontFamily;
    case "color.text":
      return d.color.text;
    case "color.text_outline":
      return d.color.text_outline;
    case "color.accent":
      return d.color.accent;
    case "motion.enter_s":
      return d.motion.enter_ms / 1000;
    case "motion.exit_s":
      return d.motion.exit_ms / 1000;
    case "safe_zone":
      return { ...d.safe_zone };
  }
}

/** Fill the token-backed props that the clip does not set (kit value, or the legacy default). */
export function applyDesign<T extends Record<string, unknown>>(
  templateId: string,
  props: T,
  design?: DesignMeta,
): T {
  const map = TOKEN_PROPS[templateId];
  if (!map) return props;
  const out: Record<string, unknown> = { ...props };
  for (const [key, spec] of Object.entries(map)) {
    if (out[key] !== undefined) continue;
    const v = design ? tokenValue(design, spec.token) : spec.legacy;
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

export function designOf(props: unknown): DesignMeta | undefined {
  return (props as RenderMetaProps | undefined)?.__design;
}

export function pagesOf(props: unknown): CaptionPageMeta[] | undefined {
  return (props as RenderMetaProps | undefined)?.__pages;
}

/** Inner padding (px) that keeps a block inside the kit safe zone, never under `minPx`. */
export function safePadding(
  design: DesignMeta | undefined,
  width: number,
  height: number,
  minPx: { x: number; y: number },
): { top: number; bottom: number; left: number; right: number } {
  if (!design) return { top: minPx.y, bottom: minPx.y, left: minPx.x, right: minPx.x };
  const z = design.safe_zone;
  return {
    top: Math.max(minPx.y, (z.top / 100) * height),
    bottom: Math.max(minPx.y, (z.bottom / 100) * height),
    left: Math.max(minPx.x, (z.left / 100) * width),
    right: Math.max(minPx.x, (z.right / 100) * width),
  };
}
