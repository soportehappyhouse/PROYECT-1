import { z } from "zod";
import { background, color, fontFamily, textarea } from "./common.js";

export const KINETIC_ANIMATIONS = ["slam", "slide-up", "rotate", "stagger"] as const;

export const kineticTypographySchema = z.object({
  text: textarea("Texto").default("Crea. Edita. Comparte. Todo en tu PC."),
  splitBy: z.enum(["word", "phrase"]).meta({ title: "Dividir por" }).default("word"),
  animation: z.enum(KINETIC_ANIMATIONS).meta({ title: "Animación" }).default("slam"),
  fontFamily: fontFamily("Bebas Neue"),
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
export type KineticTypographyProps = z.infer<typeof kineticTypographySchema>;
