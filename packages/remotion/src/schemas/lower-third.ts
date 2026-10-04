import { z } from "zod";
import { color, fontFamily, text } from "./common.js";

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
  style: z.enum(LOWER_THIRD_STYLES).meta({ title: "Estilo" }).default("bar"),
  position: z.enum(LOWER_THIRD_POSITIONS).meta({ title: "Posición" }).default("bottom-left"),
  enter: z.enum(LOWER_THIRD_ENTER).meta({ title: "Animación de entrada" }).default("slide"),
  exit: z.enum(LOWER_THIRD_EXIT).meta({ title: "Animación de salida" }).default("slide"),
  inSec: z.number().min(0.1).max(3).meta({ title: "Duración entrada (s)" }).default(0.6),
  outSec: z.number().min(0.1).max(3).meta({ title: "Duración salida (s)" }).default(0.5),
  fontFamily: fontFamily("Inter"),
  scale: z.number().min(0.3).max(3).meta({ title: "Escala" }).default(1),
  marginPct: z.number().min(0).max(30).meta({ title: "Margen (%)" }).default(6),
  accentColor: color("Color de acento").default("#e13238"),
  textColor: color("Color del nombre").default("#ffffff"),
  roleColor: color("Color del cargo").default("#e4e4e7"),
  boxColor: color("Color de la caja").default("rgba(0,0,0,0.75)"),
});
export type LowerThirdProps = z.infer<typeof lowerThirdSchema>;
