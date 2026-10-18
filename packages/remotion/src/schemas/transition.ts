import { z } from "zod";
import { choice, color, DIRECTIONS, mediaSrc, text } from "./common.js";

export const TRANSITION_KINDS = ["fade", "slide", "wipe", "flip"] as const;

export const transitionSchema = z.object({
  kind: choice(TRANSITION_KINDS, "Transición").default("slide"),
  direction: choice(DIRECTIONS, "Dirección").default("from-right"),
  transitionSec: z
    .number()
    .min(0.1)
    .max(5)
    .meta({ title: "Duración de la transición (s)" })
    .default(0.8),
  timing: choice(["linear", "spring"], "Curva").default("spring"),
  fromSrc: mediaSrc("Clip A (video o imagen)"),
  toSrc: mediaSrc("Clip B (video o imagen)"),
  fit: choice(["cover", "contain"], "Ajuste").default("cover"),
  fromColor: color("Color de A (sin medio)").default("#1e3a8a"),
  toColor: color("Color de B (sin medio)").default("#e13238"),
  fromLabel: text("Etiqueta A").default("Clip A"),
  toLabel: text("Etiqueta B").default("Clip B"),
});
export type TransitionProps = z.infer<typeof transitionSchema>;
