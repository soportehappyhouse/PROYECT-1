import { z } from "zod";
import { TimestampSchema } from "./common.js";

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const PanelIdSchema = z.enum([
  "media",
  "preview",
  "inspector",
  "timeline",
  "motion",
  "voice",
  "subtitles",
  "library",
  "jobs",
  "export",
]);
export type PanelId = z.infer<typeof PanelIdSchema>;

export const PanelLayoutSchema = z.object({
  id: PanelIdSchema,
  visible: z.boolean(),
  /** Order within its dock area. */
  order: z.number().int().min(0),
  area: z.enum(["left", "center", "right", "bottom"]),
  /** Relative size (percentage of the area). */
  size: z.number().min(5).max(100).optional(),
});
export type PanelLayout = z.infer<typeof PanelLayoutSchema>;

export const ShortcutSchema = z.object({
  action: z.string(),
  /** e.g. "Space", "Ctrl+K", "Shift+Delete". */
  keys: z.string(),
});
export type Shortcut = z.infer<typeof ShortcutSchema>;

export const UiDensitySchema = z.enum(["compact", "comfortable", "spacious"]);
export type UiDensity = z.infer<typeof UiDensitySchema>;

/** A named, user-saved dockview layout (`api.toJSON()` output, opaque to the server). */
export const LayoutPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layout: z.unknown(),
  createdAt: TimestampSchema,
});
export type LayoutPreset = z.infer<typeof LayoutPresetSchema>;

/** Dashboard-only preferences (module a); the api persists them verbatim. */
export const DashboardUiPrefsSchema = z.object({
  /** CSS color used as the accent (primary) color. */
  accent: z.string().min(1),
  density: UiDensitySchema,
  /** Current dockview layout (`SerializedDockview`), opaque to the server. */
  layout: z.unknown().optional(),
  layoutPresets: z.array(LayoutPresetSchema).default([]),
  /** Last local modification; the newest copy (browser vs api) wins on load. */
  updatedAt: TimestampSchema.optional(),
  /** Sprint 5 (M2): timeline magnet and what it snaps to. */
  snap: z
    .object({
      enabled: z.boolean().default(true),
      playhead: z.boolean().default(true),
      clipEdges: z.boolean().default(true),
      inOut: z.boolean().default(true),
    })
    .optional(),
});
export type DashboardUiPrefs = z.infer<typeof DashboardUiPrefsSchema>;

/**
 * Persisted as one JSON document by PUT /api/settings (whole object, including `ui`) so layout,
 * accent, density and layout presets survive a browser reset.
 */
export const DashboardSettingsSchema = z.object({
  theme: ThemeSchema.default("system"),
  panels: z.array(PanelLayoutSchema),
  shortcuts: z.array(ShortcutSchema),
  language: z.literal("es").default("es"),
  ui: DashboardUiPrefsSchema.optional(),
});
export type DashboardSettings = z.infer<typeof DashboardSettingsSchema>;

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  theme: "system",
  language: "es",
  panels: [
    { id: "media", visible: true, order: 0, area: "left" },
    { id: "library", visible: true, order: 1, area: "left" },
    { id: "preview", visible: true, order: 0, area: "center" },
    { id: "inspector", visible: true, order: 0, area: "right" },
    { id: "motion", visible: true, order: 1, area: "right" },
    { id: "voice", visible: true, order: 2, area: "right" },
    { id: "subtitles", visible: false, order: 3, area: "right" },
    { id: "timeline", visible: true, order: 0, area: "bottom" },
    { id: "jobs", visible: false, order: 1, area: "bottom" },
    { id: "export", visible: false, order: 4, area: "right" },
  ],
  shortcuts: [
    { action: "playback.toggle", keys: "Space" },
    { action: "timeline.split", keys: "S" },
    { action: "timeline.delete", keys: "Delete" },
    { action: "edit.undo", keys: "Ctrl+Z" },
    { action: "edit.redo", keys: "Ctrl+Shift+Z" },
    { action: "project.export", keys: "Ctrl+E" },
  ],
};
