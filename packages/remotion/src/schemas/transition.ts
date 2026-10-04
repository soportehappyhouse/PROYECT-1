import { z } from "zod";
import { color, DIRECTIONS, mediaSrc, text } from "./common.js";

export const TRANSITION_KINDS = ["fade", "slide", "wipe", "flip"] as const;

export const transitionSchema = z.object({
  kind: z.enum(TRANSITION_KINDS).meta({ title: "Transición" }).default("slide"),
  direction: z.enum(DIRECTIONS).meta({ title: "Dirección" }).default("from-right"),
  transitionSec: z
    .number()
    .min(0.1)
    .max(5)
    .meta({ title: "Duración de la transición (s)" })
    .default(0.8),
  timing: z.enum(["linear", "spring"]).meta({ title: "Curva" }).default("spring"),
  fromSrc: mediaSrc("Clip A (video o imagen)"),
  toSrc: mediaSrc("Clip B (video o imagen)"),
  fit: z.enum(["cover", "contain"]).meta({ title: "Ajuste" }).default("cover"),
  fromColor: color("Color de A (sin medio)").default("#1e3a8a"),
  toColor: color("Color de B (sin medio)").default("#e13238"),
  fromLabel: text("Etiqueta A").default("Clip A"),
  toLabel: text("Etiqueta B").default("Clip B"),
});
export type TransitionProps = z.infer<typeof transitionSchema>;
