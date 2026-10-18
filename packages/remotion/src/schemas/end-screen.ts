import { z } from "zod";
import { background, choice, type Filled, kitColor, kitFontFamily, text } from "./common.js";

export const endScreenSchema = z.object({
  title: text("Título").default("¡Gracias por ver!"),
  subtitle: text("Subtítulo").default("Nuevo video cada semana"),
  ctaText: text("Botón (llamada a la acción)").default("Suscribite"),
  handle: text("Usuario / canal").default("@tucanal"),
  layout: choice(["youtube", "minimal"], "Diseño").default("youtube"),
  slot1Label: text("Recuadro 1").default("Video recomendado"),
  slot2Label: text("Recuadro 2").default("Lista de reproducción"),
  /** Absent = kit `font.title` (Poppins without a kit). */
  fontFamily: kitFontFamily("title"),
  accentColor: kitColor("Color de acento", "accent"),
  textColor: kitColor("Color del texto", "text"),
  background: background("#0f0f12"),
});
export type EndScreenProps = Filled<
  z.infer<typeof endScreenSchema>,
  "fontFamily" | "textColor" | "accentColor"
>;
