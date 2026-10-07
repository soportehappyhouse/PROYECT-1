import {
  DashboardSettingsSchema,
  LayoutPresetSchema,
  ThemeSchema,
  UiDensitySchema,
  type DashboardSettings,
  type LayoutPreset,
  type Theme,
  type UiDensity,
} from "@studio/shared";
import { z } from "zod";
import { create } from "zustand";
import { createId } from "@/lib/ids";
import { isValidSerializedLayout, toPanelLayouts, type WebPanelId } from "@/lib/layout";
import {
  defaultShortcutMap,
  normalizeKeys,
  shortcutsFromList,
  shortcutsToList,
  type ShortcutActionId,
  type ShortcutMap,
} from "@/lib/shortcuts";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";
import { addBreadcrumb } from "./breadcrumbs-store";

export const ACCENT_PRESETS: readonly { name: string; value: string }[] = [
  { name: "Rojo", value: "#e5484d" },
  { name: "Naranja", value: "#f76b15" },
  { name: "Ámbar", value: "#d99a00" },
  { name: "Verde", value: "#30a46c" },
  { name: "Turquesa", value: "#12a594" },
  { name: "Azul", value: "#0090ff" },
  { name: "Índigo", value: "#3e63dd" },
  { name: "Violeta", value: "#8e4ec6" },
  { name: "Rosa", value: "#d6409f" },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[5]!.value;

export const DENSITY_LABELS: Record<UiDensity, string> = {
  compact: "Compacta",
  comfortable: "Cómoda",
  spacious: "Amplia",
};

export const THEME_LABELS: Record<Theme, string> = {
  light: "Claro",
  dark: "Oscuro",
  system: "Sistema",
};

/** Shape persisted in localStorage (and mirrored to the api as `DashboardSettings`). */
const PersistedSettingsSchema = z.object({
  version: z.literal(1),
  theme: ThemeSchema,
  accent: z.string().min(1),
  density: UiDensitySchema,
  shortcuts: z.record(z.string(), z.string()),
  layout: z.unknown().optional(),
  layoutPresets: z.array(LayoutPresetSchema),
  updatedAt: z.string(),
});
export type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;

export type SyncState = "idle" | "synced" | "local" | "error";

export interface SettingsState {
  theme: Theme;
  accent: string;
  density: UiDensity;
  shortcuts: ShortcutMap;
  /** Current dockview layout (`SerializedDockview`) or undefined = default layout. */
  layout: unknown;
  layoutPresets: LayoutPreset[];
  updatedAt: string;
  /** Panels currently open in dockview (runtime only). */
  openPanels: WebPanelId[];
  /** Incremented to ask the dock to rebuild from `layout` (restore/apply preset). */
  layoutRevision: number;
  syncState: SyncState;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  /** Tab to show when the settings dialog opens (e.g. "ai-packs" from the GPU indicator). */
  settingsTab: SettingsTab | undefined;

  setTheme: (theme: Theme) => void;
  setAccent: (accent: string) => void;
  setDensity: (density: UiDensity) => void;
  setShortcut: (action: ShortcutActionId, keys: string) => void;
  resetShortcuts: () => void;
  /**
   * Called on every dockview layout change. Does not trigger a rebuild. `userChange=false` stores
   * the layout without bumping `updatedAt` (initial load, programmatic rebuilds).
   */
  setLayout: (layout: unknown, userChange?: boolean) => void;
  setOpenPanels: (panels: WebPanelId[]) => void;
  /** Drop the saved layout and rebuild the default one. */
  restoreDefaultLayout: () => void;
  saveLayoutPreset: (name: string) => LayoutPreset | undefined;
  applyLayoutPreset: (id: string) => boolean;
  deleteLayoutPreset: (id: string) => void;
  renameLayoutPreset: (id: string, name: string) => void;
  /** Merge settings coming from the api when they are newer than the local copy. */
  mergeRemote: (remote: DashboardSettings) => boolean;
  setSyncState: (s: SyncState) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
}

/** Sprint 4 M1: "persons" (Personas y consentimientos). */
export type SettingsTab =
  "appearance" | "shortcuts" | "layouts" | "ai-packs" | "assistant" | "persons";

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultPersistedSettings(): PersistedSettings {
  return {
    version: 1,
    theme: "system",
    accent: DEFAULT_ACCENT,
    density: "comfortable",
    shortcuts: defaultShortcutMap(),
    layout: undefined,
    layoutPresets: [],
    updatedAt: new Date(0).toISOString(),
  };
}

/** Read and validate the localStorage copy; invalid data falls back to defaults. */
export function loadPersistedSettings(): PersistedSettings {
  const parsed = PersistedSettingsSchema.safeParse(readJson(STORAGE_KEYS.settings));
  if (!parsed.success) return defaultPersistedSettings();
  const data = parsed.data;
  return {
    ...data,
    shortcuts: { ...defaultShortcutMap(), ...data.shortcuts },
    layout: isValidSerializedLayout(data.layout) ? data.layout : undefined,
  };
}

export function pickPersisted(s: SettingsState): PersistedSettings {
  return {
    version: 1,
    theme: s.theme,
    accent: s.accent,
    density: s.density,
    shortcuts: s.shortcuts,
    layout: s.layout,
    layoutPresets: s.layoutPresets,
    updatedAt: s.updatedAt,
  };
}

/** Api payload: the contract `DashboardSettings` plus the additive `ui` block. */
export function toApiSettings(s: SettingsState): DashboardSettings {
  return {
    theme: s.theme,
    language: "es",
    panels: toPanelLayouts(s.openPanels),
    shortcuts: shortcutsToList(s.shortcuts),
    ui: {
      accent: s.accent,
      density: s.density,
      layout: s.layout,
      layoutPresets: s.layoutPresets,
      updatedAt: s.updatedAt,
    },
  };
}

function initialState(): PersistedSettings {
  return typeof window === "undefined" ? defaultPersistedSettings() : loadPersistedSettings();
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  const init = initialState();
  const touch = () => ({ updatedAt: nowIso() });
  return {
    theme: init.theme,
    accent: init.accent,
    density: init.density,
    shortcuts: init.shortcuts as ShortcutMap,
    layout: init.layout,
    layoutPresets: init.layoutPresets,
    updatedAt: init.updatedAt,
    openPanels: [],
    layoutRevision: 0,
    syncState: "idle",
    commandPaletteOpen: false,
    settingsOpen: false,
    settingsTab: undefined,

    setTheme: (theme) => {
      addBreadcrumb("settings", `Cambió el tema a ${theme}`, { theme });
      set({ theme, ...touch() });
    },
    setAccent: (accent) => {
      addBreadcrumb("settings", `Cambió el color de acento a ${accent}`, { accent }, "accent");
      set({ accent, ...touch() });
    },
    setDensity: (density) => {
      addBreadcrumb("settings", `Cambió la densidad a ${density}`, { density });
      set({ density, ...touch() });
    },
    setShortcut: (action, keys) => {
      addBreadcrumb("settings", `Cambió el atajo de ${action} a ${keys}`, { action, keys });
      set({ shortcuts: { ...get().shortcuts, [action]: normalizeKeys(keys) }, ...touch() });
    },
    resetShortcuts: () => {
      addBreadcrumb("settings", "Restableció los atajos");
      set({ shortcuts: defaultShortcutMap(), ...touch() });
    },
    setLayout: (layout, userChange = true) => {
      const changed = JSON.stringify(layout) !== JSON.stringify(get().layout);
      set({ layout, ...(userChange && changed ? touch() : {}) });
    },
    setOpenPanels: (openPanels) => set({ openPanels }),
    restoreDefaultLayout: () => {
      addBreadcrumb("settings", "Restauró el layout por defecto");
      set({ layout: undefined, layoutRevision: get().layoutRevision + 1, ...touch() });
    },
    saveLayoutPreset: (name) => {
      const layout = get().layout;
      const trimmed = name.trim();
      if (!trimmed || !isValidSerializedLayout(layout)) return undefined;
      const existing = get().layoutPresets.find((p) => p.name === trimmed);
      const preset: LayoutPreset = {
        id: existing?.id ?? createId("lay"),
        name: trimmed,
        layout,
        createdAt: nowIso(),
      };
      set({
        layoutPresets: existing
          ? get().layoutPresets.map((p) => (p.id === existing.id ? preset : p))
          : [...get().layoutPresets, preset],
        ...touch(),
      });
      return preset;
    },
    applyLayoutPreset: (id) => {
      const preset = get().layoutPresets.find((p) => p.id === id);
      if (!preset || !isValidSerializedLayout(preset.layout)) return false;
      addBreadcrumb("settings", `Aplicó el layout «${preset.name}»`);
      set({ layout: preset.layout, layoutRevision: get().layoutRevision + 1, ...touch() });
      return true;
    },
    deleteLayoutPreset: (id) =>
      set({ layoutPresets: get().layoutPresets.filter((p) => p.id !== id), ...touch() }),
    renameLayoutPreset: (id, name) =>
      set({
        layoutPresets: get().layoutPresets.map((p) => (p.id === id ? { ...p, name } : p)),
        ...touch(),
      }),
    mergeRemote: (remote) => {
      const parsed = DashboardSettingsSchema.safeParse(remote);
      if (!parsed.success) return false;
      const ui = parsed.data.ui;
      // Remote without `ui.updatedAt` is just the server defaults: keep the local copy.
      if (!ui?.updatedAt || Date.parse(ui.updatedAt) <= Date.parse(get().updatedAt)) return false;
      const layout = isValidSerializedLayout(ui.layout) ? ui.layout : undefined;
      set({
        theme: parsed.data.theme,
        shortcuts: shortcutsFromList(parsed.data.shortcuts),
        accent: ui.accent,
        density: ui.density,
        layout,
        layoutPresets: ui.layoutPresets,
        updatedAt: ui.updatedAt,
        layoutRevision: get().layoutRevision + 1,
      });
      return true;
    },
    setSyncState: (syncState) => set({ syncState }),
    setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
    setSettingsOpen: (settingsOpen, settingsTab) => set({ settingsOpen, settingsTab }),
  };
});

/** Write the persisted part to localStorage whenever it changes. */
export function persistSettingsToLocalStorage(): () => void {
  let last = JSON.stringify(pickPersisted(useSettingsStore.getState()));
  return useSettingsStore.subscribe((state) => {
    const next = JSON.stringify(pickPersisted(state));
    if (next !== last) {
      last = next;
      writeJson(STORAGE_KEYS.settings, JSON.parse(next));
    }
  });
}
