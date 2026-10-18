import { z } from "zod";
import {
  type Filled,
  ADVANCED_PROP,
  choice,
  color,
  kitColor,
  kitFontFamily,
  text,
  trackProps,
} from "./common.js";

export const LOWER_THIRD_STYLES = ["bar", "box", "underline", "split"] as const;
export const LOWER_THIRD_POSITIONS = [
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "top-left",
  "top-right",
] as const;
export const LOWER_THIRD_ENTER = ["slide", "fade", "wipe", "pop"] as const;
export const LOWER_THIRD_EXIT = ["slide", "fade", "wipe", "pop", "none"] as const;

export const lowerThirdSchema = z.object({
  name: text("Nombre").default("Nombre Apellido"),
  role: text("Cargo / descripción").default("Cargo o descripción"),
  style: choice(LOWER_THIRD_STYLES, "Estilo").default("bar"),
  position: choice(LOWER_THIRD_POSITIONS, "Posición").default("bottom-left"),
  enter: choice(LOWER_THIRD_ENTER, "Animación de entrada").default("slide"),
  exit: choice(LOWER_THIRD_EXIT, "Animación de salida").default("slide"),
  /** Absent = kit `motion.enter_ms` (0,6 s without a kit). */
  inSec: z
    .number()
    .min(0.1)
    .max(3)
    .meta({ title: "Duración de la entrada (s)", [ADVANCED_PROP]: true })
    .optional(),
  outSec: z
    .number()
    .min(0.1)
    .max(3)
    .meta({ title: "Duración de la salida (s)", [ADVANCED_PROP]: true })
    .optional(),
  fontFamily: kitFontFamily("body"),
  scale: z.number().min(0.3).max(3).meta({ title: "Escala" }).default(1),
  /** Absent = the kit safe zone (6 % without a kit). */
  marginPct: z
    .number()
    .min(0)
    .max(30)
    .meta({ title: "Margen (%)", [ADVANCED_PROP]: true })
    .optional(),
  accentColor: kitColor("Color de acento", "accent"),
  textColor: kitColor("Color del nombre", "text"),
  roleColor: color("Color del cargo").default("#e4e4e7"),
  boxColor: color("Color de la caja").default("rgba(0,0,0,0.75)"),
  /** Sprint 2: follow a track (the card's center goes to the anchor point + offset). */
  ...trackProps,
});
export type LowerThirdProps = Filled<
  z.infer<typeof lowerThirdSchema>,
  "fontFamily" | "textColor" | "accentColor" | "inSec" | "outSec"
>;
