import type { PanelId, PanelLayout } from "@studio/shared";
import { DEFAULT_DASHBOARD_SETTINGS } from "@studio/shared";
import { z } from "zod";

/**
 * Dashboard panels: shared `PanelIdSchema` + `assistant` (Sprint 3; it lives only in the dockview
 * layout, the contract `panels` array does not list it).
 */
export type WebPanelId = PanelId | "assistant" | "console" | "style";

export interface PanelInfo {
  id: WebPanelId;
  title: string;
  description: string;
}

export const PANELS: readonly PanelInfo[] = [
  { id: "media", title: "Media", description: "Importar y gestionar archivos" },
  { id: "library", title: "Biblioteca", description: "Efectos de sonido y música" },
  { id: "preview", title: "Vista previa", description: "Reproductor sincronizado con el cursor" },
  { id: "timeline", title: "Línea de tiempo", description: "Pistas y clips" },
  { id: "inspector", title: "Propiedades", description: "Propiedades del clip seleccionado" },
  { id: "motion", title: "Motion graphics", description: "Plantillas animadas" },
  { id: "voice", title: "Voz y audio", description: "TTS, efectos y RVC" },
  { id: "subtitles", title: "Subtítulos", description: "Transcripción y estilos" },
  { id: "export", title: "Exportar", description: "Presets y exportación" },
  { id: "jobs", title: "Trabajos", description: "Progreso de tareas" },
  { id: "assistant", title: "Asistente", description: "Editar con comandos (IA local)" },
  {
    id: "console",
    title: "Consola Claude",
    description: "Claude Code con tu suscripción (sin API key)",
  },
  {
    id: "style",
    title: "Perfil de estilo",
    description: "Copiar el estilo de un video de referencia",
  },
];

export const PANEL_IDS = PANELS.map((p) => p.id);

export function panelTitle(id: WebPanelId): string {
  return PANELS.find((p) => p.id === id)?.title ?? id;
}

export function isWebPanelId(id: string): id is WebPanelId {
  return (PANEL_IDS as string[]).includes(id);
}

/** Minimal structural check of dockview's `SerializedDockview` before calling `fromJSON`. */
const SerializedDockviewShape = z.object({
  grid: z.object({
    root: z.object({ type: z.string() }).loose(),
    width: z.number(),
    height: z.number(),
    orientation: z.string(),
  }),
  panels: z.record(
    z.string(),
    z.object({ id: z.string(), contentComponent: z.string().optional() }).loose(),
  ),
});

export function isValidSerializedLayout(value: unknown): boolean {
  const parsed = SerializedDockviewShape.safeParse(value);
  if (!parsed.success) return false;
  // Every panel must be one we can render.
  return Object.values(parsed.data.panels).every((p) => isWebPanelId(p.contentComponent ?? p.id));
}

/** Panel ids contained in a serialized layout (empty when invalid). */
export function panelsInLayout(value: unknown): WebPanelId[] {
  const parsed = SerializedDockviewShape.safeParse(value);
  if (!parsed.success) return [];
  return Object.values(parsed.data.panels)
    .map((p) => p.contentComponent ?? p.id)
    .filter(isWebPanelId);
}

/** Subset of the dockview api used to build layouts (keeps this file testable without DOM). */
export interface LayoutBuilderApi {
  addPanel(options: {
    id: string;
    component: string;
    title?: string;
    inactive?: boolean;
    initialWidth?: number;
    initialHeight?: number;
    position?:
      | { referencePanel: string; direction?: "left" | "right" | "above" | "below" | "within" }
      | { direction: "left" | "right" | "above" | "below" };
  }): unknown;
  getPanel(id: string): unknown;
}

/**
 * Default arrangement: where each panel goes relative to an anchor panel. Sprint 5 (H8): the right
 * column is Propiedades · Asistente · Exportar (visible at 1366 px); Motion and Voz go to the left
 * column and Subtítulos, Trabajos, Consola Claude and Perfil de estilo to the bottom, as tabs.
 */
const DEFAULT_PLACEMENT: Record<
  WebPanelId,
  {
    anchor?: WebPanelId;
    direction?: "left" | "right" | "above" | "below" | "within";
    inactive?: boolean;
  }
> = {
  media: {},
  library: { anchor: "media", direction: "within", inactive: true },
  motion: { anchor: "media", direction: "within", inactive: true },
  voice: { anchor: "media", direction: "within", inactive: true },
  preview: { anchor: "media", direction: "right" },
  inspector: { anchor: "preview", direction: "right" },
  assistant: { anchor: "inspector", direction: "within", inactive: true },
  export: { anchor: "inspector", direction: "within", inactive: true },
  timeline: { direction: "below" },
  subtitles: { anchor: "timeline", direction: "within", inactive: true },
  jobs: { anchor: "timeline", direction: "within", inactive: true },
  // Sprint 3b: Consola Claude and «Perfil de estilo», inactive until Ctrl+Shift+C / the palette.
  console: { anchor: "timeline", direction: "within", inactive: true },
  style: { anchor: "timeline", direction: "within", inactive: true },
};

/** Panels shown by the default layout (the shared defaults hide subtitles/jobs; we keep them as tabs). */
export const DEFAULT_VISIBLE_PANELS: readonly WebPanelId[] = PANEL_IDS;

export function addPanelWithDefaults(api: LayoutBuilderApi, id: WebPanelId): void {
  if (api.getPanel(id)) return;
  const place = DEFAULT_PLACEMENT[id];
  const base = {
    id,
    component: id,
    title: panelTitle(id),
    inactive: place.inactive ?? false,
  };
  if (place.anchor && api.getPanel(place.anchor)) {
    api.addPanel({
      ...base,
      position: { referencePanel: place.anchor, direction: place.direction ?? "within" },
    });
  } else if (place.direction && place.direction !== "within") {
    api.addPanel({
      ...base,
      position: { direction: place.direction },
      ...(id === "timeline" ? { initialHeight: 280 } : {}),
    });
  } else {
    api.addPanel({ ...base, position: { direction: "right" } });
  }
}

export function buildDefaultLayout(api: LayoutBuilderApi): void {
  // Order matters: anchors first.
  const order: WebPanelId[] = [
    "media",
    "library",
    "motion",
    "voice",
    "preview",
    "inspector",
    "assistant",
    "export",
    "timeline",
    "subtitles",
    "jobs",
    "console",
    "style",
  ];
  for (const id of order) if (DEFAULT_VISIBLE_PANELS.includes(id)) addPanelWithDefaults(api, id);
}

const AREA_BY_PANEL = Object.fromEntries(
  DEFAULT_DASHBOARD_SETTINGS.panels.map((p) => [p.id, p.area]),
) as Record<PanelId, PanelLayout["area"]>;

/** Contract-shaped `panels` array derived from the open dockview panels. */
export function toPanelLayouts(openPanels: readonly WebPanelId[]): PanelLayout[] {
  // `assistant` is not in the shared enum: its placement travels in `ui.layout` only.
  return DEFAULT_DASHBOARD_SETTINGS.panels.map((p) => ({
    id: p.id,
    area: AREA_BY_PANEL[p.id],
    visible: openPanels.includes(p.id),
    order: Math.max(0, openPanels.indexOf(p.id)),
  }));
}
