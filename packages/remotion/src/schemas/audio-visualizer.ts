import { z } from "zod";
import { background, color, fontFamily, mediaSrc, text } from "./common.js";

export const VISUALIZER_STYLES = ["bars", "wave", "mirror-bars"] as const;

export const audioVisualizerSchema = z.object({
  audioSrc: mediaSrc("Audio (mp3/wav)"),
  style: z.enum(VISUALIZER_STYLES).meta({ title: "Estilo" }).default("bars"),
  bars: z.number().int().min(8).max(128).meta({ title: "Cantidad de barras" }).default(48),
  color: color("Color principal").default("#22d3ee"),
  secondaryColor: color("Color secundario").default("#a855f7"),
  background: background("#0b1020"),
  title: text("Título").default("Escucha esto"),
  subtitle: text("Subtítulo").default("Episodio 1"),
  fontFamily: fontFamily("Poppins"),
  sensitivity: z.number().min(0.2).max(5).meta({ title: "Sensibilidad" }).default(1.5),
});
export type AudioVisualizerProps = z.infer<typeof audioVisualizerSchema>;
