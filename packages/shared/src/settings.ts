import { z } from "zod";

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

export const DashboardSettingsSchema = z.object({
  theme: ThemeSchema.default("system"),
  panels: z.array(PanelLayoutSchema),
  shortcuts: z.array(ShortcutSchema),
  language: z.literal("es").default("es"),
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
