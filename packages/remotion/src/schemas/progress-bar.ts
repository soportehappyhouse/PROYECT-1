import { z } from "zod";
import { background, color, fontFamily, text } from "./common.js";

export const ChapterSchema = z.object({
  label: text("Capítulo", 80),
  startSec: z.number().nonnegative(),
});

export const progressBarSchema = z.object({
  position: z.enum(["top", "bottom"]).meta({ title: "Posición" }).default("bottom"),
  thickness: z.number().min(2).max(80).meta({ title: "Grosor (px a 1080p)" }).default(12),
  color: color("Color de la barra").default("#e13238"),
  trackColor: color("Color del fondo de barra").default("rgba(255,255,255,0.25)"),
  rounded: z.boolean().meta({ title: "Bordes redondeados" }).default(true),
  marginPct: z.number().min(0).max(20).meta({ title: "Margen (%)" }).default(0),
  /** Chapters split the bar in segments and can show the current label. */
  chapters: z.array(ChapterSchema).meta({ title: "Capítulos" }).default([]),
  showLabel: z.boolean().meta({ title: "Mostrar capítulo actual" }).default(false),
  fontFamily: fontFamily("Inter"),
  labelColor: color("Color de la etiqueta").default("#ffffff"),
  background: background("transparent"),
});
export type ProgressBarProps = z.infer<typeof progressBarSchema>;
