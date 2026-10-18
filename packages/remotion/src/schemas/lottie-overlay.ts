import { z } from "zod";
import { ADVANCED_PROP, background, choice, mediaSrc } from "./common.js";

export const LOTTIE_POSITIONS = [
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export const lottieOverlaySchema = z.object({
  lottieSrc: mediaSrc("Animación Lottie (.json)"),
  /** Inline Lottie JSON (alternative to lottieSrc). Falls back to a built-in sample. */
  animationData: z
    .record(z.string(), z.unknown())
    .meta({ title: "Animación (JSON)", [ADVANCED_PROP]: true })
    .optional(),
  loop: z.boolean().meta({ title: "Repetir" }).default(true),
  playbackRate: z.number().min(0.1).max(4).meta({ title: "Velocidad" }).default(1),
  size: z
    .number()
    .min(0.05)
    .max(1)
    .meta({ title: "Tamaño (fracción del lado menor)" })
    .default(0.5),
  position: choice(LOTTIE_POSITIONS, "Posición").default("center"),
  marginPct: z.number().min(0).max(30).meta({ title: "Margen (%)" }).default(5),
  background: background("transparent"),
});
export type LottieOverlayProps = z.infer<typeof lottieOverlaySchema>;
