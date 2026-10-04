import { z } from "zod";
import { background, color, fontFamily, text } from "./common.js";

export const TITLE_CARD_STYLES = ["fade-up", "pop", "slide", "typewriter", "boxed"] as const;

export const titleCardSchema = z.object({
  title: text("Título").default("Mi título"),
  subtitle: text("Subtítulo").default("Subtítulo opcional"),
  style: z.enum(TITLE_CARD_STYLES).meta({ title: "Estilo" }).default("fade-up"),
  align: z.enum(["center", "left"]).meta({ title: "Alineación" }).default("center"),
  fontFamily: fontFamily("Montserrat"),
  titleSize: z
    .number()
    .min(16)
    .max(400)
    .meta({ title: "Tamaño del título (px a 1080p)" })
    .default(120),
  titleColor: color("Color del título").default("#ffffff"),
  subtitleColor: color("Color del subtítulo").default("#d4d4d8"),
  accentColor: color("Color de acento").default("#e13238"),
  /** B6: transparent by default so the title overlays the video; type "#111111" for a solid card. */
  background: background("transparent"),
  exit: z.boolean().meta({ title: "Animación de salida" }).default(true),
});
export type TitleCardProps = z.infer<typeof titleCardSchema>;
