// Template catalog shared by Root.tsx (browser bundle) and templates.ts (Node).
// Browser-safe: zod + local schemas only.
import type { z } from "zod";
import {
  animatedCaptionsSchema,
  audioVisualizerSchema,
  endScreenSchema,
  kineticTypographySchema,
  lottieOverlaySchema,
  lowerThirdSchema,
  progressBarSchema,
  titleCardSchema,
  transitionSchema,
} from "./schemas/index.js";

export type TemplateCategory = "texto" | "subtitulos" | "transiciones" | "audio" | "overlays";

export interface TemplateDef<S extends z.ZodObject = z.ZodObject> {
  /** = <Composition id>. */
  id: string;
  /** Spanish name shown in the dashboard. */
  name: string;
  /** Spanish description. */
  description: string;
  category: TemplateCategory;
  schema: S;
  defaultDurationSec: number;
  /** Default canvas (overridden per render by MotionSpec width/height). */
  defaultSize: { width: number; height: number };
  /** Template renders without an opaque background when background = "transparent". */
  supportsAlpha: boolean;
  /** Frame (at 30 fps) used by the `<id>-thumb` Still composition. */
  thumbnailFrame: number;
}

const HD = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

/** Order matters: first entries are the shared REMOTION_TEMPLATE_IDS (contract). */
export const TEMPLATE_DEFS = [
  {
    id: "title-card",
    name: "Título",
    description:
      "Título y subtítulo animados con 5 estilos (fade, pop, slide, máquina de escribir, caja).",
    category: "texto",
    schema: titleCardSchema,
    defaultDurationSec: 3,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 45,
  },
  {
    id: "lower-third",
    name: "Rótulo (lower third)",
    description: "Nombre y cargo con animaciones de entrada y salida configurables.",
    category: "texto",
    schema: lowerThirdSchema,
    defaultDurationSec: 5,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 60,
  },
  {
    id: "animated-captions",
    name: "Subtítulos animados",
    description:
      "Subtítulos estilo TikTok/CapCut desde la transcripción palabra a palabra: resaltado, karaoke, pop o caja.",
    category: "subtitulos",
    schema: animatedCaptionsSchema,
    defaultDurationSec: 5,
    defaultSize: VERTICAL,
    supportsAlpha: true,
    thumbnailFrame: 36,
  },
  {
    id: "transition",
    name: "Transición entre clips",
    description: "Une dos clips (video o imagen) con fundido, deslizamiento, barrido o giro.",
    category: "transiciones",
    schema: transitionSchema,
    defaultDurationSec: 4,
    defaultSize: HD,
    supportsAlpha: false,
    thumbnailFrame: 60,
  },
  {
    id: "audio-visualizer",
    name: "Visualizador de audio",
    description: "Barras o forma de onda que reaccionan al audio, con título.",
    category: "audio",
    schema: audioVisualizerSchema,
    defaultDurationSec: 10,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 40,
  },
  {
    id: "lottie-overlay",
    name: "Animación Lottie",
    description: "Superpone una animación Lottie (.json) con fondo transparente.",
    category: "overlays",
    schema: lottieOverlaySchema,
    defaultDurationSec: 3,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 20,
  },
  {
    id: "end-screen",
    name: "Pantalla final (CTA)",
    description: "Cierre con llamada a la acción, usuario y recuadros para videos sugeridos.",
    category: "overlays",
    schema: endScreenSchema,
    defaultDurationSec: 8,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 60,
  },
  {
    id: "progress-bar",
    name: "Barra de progreso",
    description: "Barra de progreso del video, con capítulos opcionales.",
    category: "overlays",
    schema: progressBarSchema,
    defaultDurationSec: 10,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 150,
  },
  {
    id: "kinetic-typography",
    name: "Tipografía cinética",
    description: "Texto palabra por palabra con animaciones de impacto.",
    category: "texto",
    schema: kineticTypographySchema,
    defaultDurationSec: 4,
    defaultSize: HD,
    supportsAlpha: true,
    thumbnailFrame: 20,
  },
] as const satisfies readonly TemplateDef[];

export type RemotionTemplateId = (typeof TEMPLATE_DEFS)[number]["id"];

export const THUMBNAIL_SUFFIX = "-thumb";

export function findTemplateDef(id: string): TemplateDef | undefined {
  return (TEMPLATE_DEFS as readonly TemplateDef[]).find((t) => t.id === id);
}
