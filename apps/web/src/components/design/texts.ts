/** Sprint 6 M2: Spanish texts of the Kit de marca (Ajustes) and the design checklist. */
export const KIT_TEXTS_ES = {
  intro:
    "Tu canal en un solo lugar: colores, tipografías y zona segura. Subtítulos, títulos y rótulos los usan solos.",
  saved: "Kit guardado",
  name: "Nombre del canal",
  logo: "Logo (PNG, JPG o SVG, hasta 5 MB)",
  logoPosition: "Posición del logo",
  colors: "Colores",
  fonts: "Tipografías",
  safeZone: "Zona segura 9:16",
  preview: "Vista previa",
  previewApprox: "Vista previa aproximada",
  previewPending: "Generando la vista previa…",
  check: "Revisar diseño del proyecto",
  checkRun: "Revisar",
  fixAll: "Arreglar automáticamente",
  fixedN: "Arreglé {n} cosas (un solo paso de deshacer).",
  calibrateHelp:
    "Subí una captura de Reels o TikTok de tu teléfono y mové las 4 guías hasta los bordes de los botones y textos de la app.",
  calibrateSave: "Usar esta zona segura",
  calibrateCancel: "Cancelar",
  shortsProfile: "Perfil Shorts (derecha 18 %)",
  reelsProfile: "Perfil Reels/TikTok (11 %)",
} as const;

export const COLOR_LABELS_ES = {
  text: "Texto",
  text_outline: "Contorno",
  accent: "Acento",
  plate: "Caja detrás del texto",
} as const;

export const FONT_ROLE_LABELS_ES = {
  title: "Títulos",
  caption: "Subtítulos",
  body: "Rótulos y textos",
  display: "Impacto (tipografía cinética)",
} as const;

export const FONT_WEIGHT_LABELS_ES: Record<400 | 700 | 900, string> = {
  400: "Normal",
  700: "Negrita",
  900: "Extra negrita",
};

export const SIDE_LABELS_ES = {
  top: "Arriba",
  bottom: "Abajo",
  left: "Izquierda",
  right: "Derecha",
} as const;

export const LOGO_POSITION_LABELS_ES = {
  "top-left": "Arriba a la izquierda",
  "top-right": "Arriba a la derecha",
  "bottom-left": "Abajo a la izquierda",
  "bottom-right": "Abajo a la derecha",
} as const;

/** Spanish names of the built-in templates (raw ids are never shown; shared with the api). */
export {
  MOTION_TEMPLATE_NAMES_ES as TEMPLATE_NAMES_ES,
  motionTemplateNameEs as templateNameEs,
} from "@studio/shared";
