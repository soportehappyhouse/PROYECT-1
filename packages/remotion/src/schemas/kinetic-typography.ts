import { z } from "zod";
import { background, choice, color, type Filled, kitFontFamily, textarea } from "./common.js";

export const KINETIC_ANIMATIONS = ["slam", "slide-up", "rotate", "stagger"] as const;

export const kineticTypographySchema = z.object({
  text: textarea("Texto").default("Crea. Edita. Comparte. Todo en tu PC."),
  splitBy: choice(["word", "phrase"], "Dividir por").default("word"),
  animation: choice(KINETIC_ANIMATIONS, "Animación").default("slam"),
  /** Absent = kit `font.display` (Bebas Neue without a kit). */
  fontFamily: kitFontFamily("display"),
  fontSize: z.number().min(24).max(600).meta({ title: "Tamaño (px a 1080p)" }).default(220),
  uppercase: z.boolean().meta({ title: "Mayúsculas" }).default(true),
  colors: z
    .array(color("Color"))
    .min(1)
    .max(8)
    .meta({ title: "Paleta (rota por palabra)" })
    .default(["#ffffff", "#ffd400", "#e13238"]),
  background: background("#111111"),
});
export type KineticTypographyProps = Filled<z.infer<typeof kineticTypographySchema>, "fontFamily">;
