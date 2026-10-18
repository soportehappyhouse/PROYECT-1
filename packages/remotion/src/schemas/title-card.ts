import { z } from "zod";
import { background, choice, color, type Filled, kitColor, kitFontFamily, text } from "./common.js";

export const TITLE_CARD_STYLES = ["fade-up", "pop", "slide", "typewriter", "boxed"] as const;

export const titleCardSchema = z.object({
  title: text("Título").default("Mi título"),
  subtitle: text("Subtítulo").default("Subtítulo opcional"),
  style: choice(TITLE_CARD_STYLES, "Estilo").default("fade-up"),
  align: choice(["center", "left"], "Alineación").default("center"),
  /** Absent = kit `font.title` (Montserrat without a kit). */
  fontFamily: kitFontFamily("title"),
  titleSize: z
    .number()
    .min(16)
    .max(400)
    .meta({ title: "Tamaño del título (px a 1080p)" })
    .default(120),
  titleColor: kitColor("Color del título", "text"),
  subtitleColor: color("Color del subtítulo").default("#d4d4d8"),
  accentColor: kitColor("Color de acento", "accent"),
  /** B6: transparent by default so the title overlays the video; type "#111111" for a solid card. */
  background: background("transparent"),
  exit: z.boolean().meta({ title: "Animación de salida" }).default(true),
});
export type TitleCardProps = Filled<
  z.infer<typeof titleCardSchema>,
  "fontFamily" | "titleColor" | "accentColor"
>;
