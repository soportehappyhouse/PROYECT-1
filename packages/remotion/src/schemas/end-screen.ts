import { z } from "zod";
import { background, color, fontFamily, text } from "./common.js";

export const endScreenSchema = z.object({
  title: text("Título").default("¡Gracias por ver!"),
  subtitle: text("Subtítulo").default("Nuevo video cada semana"),
  ctaText: text("Botón (CTA)").default("Suscríbete"),
  handle: text("Usuario / canal").default("@tucanal"),
  layout: z.enum(["youtube", "minimal"]).meta({ title: "Diseño" }).default("youtube"),
  slot1Label: text("Recuadro 1").default("Video recomendado"),
  slot2Label: text("Recuadro 2").default("Lista de reproducción"),
  fontFamily: fontFamily("Poppins"),
  accentColor: color("Color de acento").default("#e13238"),
  textColor: color("Color del texto").default("#ffffff"),
  background: background("#0f0f12"),
});
export type EndScreenProps = z.infer<typeof endScreenSchema>;
