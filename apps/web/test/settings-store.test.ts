import { DashboardSettingsSchema } from "@studio/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultLayout,
  isValidSerializedLayout,
  panelsInLayout,
  toPanelLayouts,
  type LayoutBuilderApi,
} from "@/lib/layout";
import {
  defaultPersistedSettings,
  loadPersistedSettings,
  persistSettingsToLocalStorage,
  toApiSettings,
  useSettingsStore,
} from "@/stores/settings-store";

/** A dockview `SerializedDockview`-shaped object. */
function fakeLayout(panelIds: string[]) {
  return {
    grid: {
      root: { type: "branch", data: [] },
      width: 1200,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: Object.fromEntries(panelIds.map((id) => [id, { id, contentComponent: id, title: id }])),
    activeGroup: "1",
  };
}

beforeEach(() => {
  const d = defaultPersistedSettings();
  useSettingsStore.setState({ ...d, openPanels: [], layoutRevision: 0, syncState: "idle" });
});

describe("layout validation", () => {
  it("accepts dockview JSON with known panels only", () => {
    expect(isValidSerializedLayout(fakeLayout(["media", "timeline", "export"]))).toBe(true);
    expect(isValidSerializedLayout(fakeLayout(["media", "unknown-panel"]))).toBe(false);
    expect(isValidSerializedLayout({ foo: 1 })).toBe(false);
    expect(isValidSerializedLayout(undefined)).toBe(false);
    expect(panelsInLayout(fakeLayout(["preview", "jobs"]))).toEqual(["preview", "jobs"]);
  });

  it("builds the default layout with every panel, anchors first", () => {
    const added: { id: string; position?: unknown }[] = [];
    const api: LayoutBuilderApi = {
      addPanel: (o) => added.push(o),
      getPanel: (id) => added.find((p) => p.id === id),
    };
    buildDefaultLayout(api);
    expect(added.map((p) => p.id)).toEqual([
      "media",
      "library",
      "preview",
      "inspector",
      "motion",
      "voice",
      "subtitles",
      "export",
      "assistant",
      "console",
      "style",
      "timeline",
      "jobs",
    ]);
    expect(added.find((p) => p.id === "console")).toMatchObject({
      inactive: true,
      position: { referencePanel: "assistant", direction: "within" },
    });
    expect(added.find((p) => p.id === "assistant")?.position).toEqual({
      referencePanel: "inspector",
      direction: "within",
    });
    expect(added.find((p) => p.id === "timeline")?.position).toEqual({ direction: "below" });
    expect(added.find((p) => p.id === "jobs")?.position).toEqual({
      referencePanel: "timeline",
      direction: "within",
    });
  });
});

describe("settings persistence", () => {
  it("writes changes to localStorage and restores them", () => {
    const stop = persistSettingsToLocalStorage();
    const s = useSettingsStore.getState();
    s.setTheme("dark");
    s.setAccent("#30a46c");
    s.setDensity("compact");
    s.setLayout(fakeLayout(["media", "preview"]));
    stop();
    const restored = loadPersistedSettings();
    expect(restored).toMatchObject({ theme: "dark", accent: "#30a46c", density: "compact" });
    expect(panelsInLayout(restored.layout)).toEqual(["media", "preview"]);
  });

  it("drops an invalid stored layout and falls back to defaults on corrupt data", () => {
    window.localStorage.setItem(
      "studio.settings.v1",
      JSON.stringify({ ...defaultPersistedSettings(), theme: "light", layout: { broken: true } }),
    );
    const restored = loadPersistedSettings();
    expect(restored.theme).toBe("light");
    expect(restored.layout).toBeUndefined();

    window.localStorage.setItem("studio.settings.v1", "{{{");
    expect(loadPersistedSettings().theme).toBe("system");
  });

  it("saves, applies and deletes named layout presets", () => {
    const s = useSettingsStore.getState();
    s.setLayout(fakeLayout(["media", "timeline"]));
    const preset = s.saveLayoutPreset("Edición");
    expect(preset?.name).toBe("Edición");
    expect(useSettingsStore.getState().saveLayoutPreset("   ")).toBeUndefined();

    useSettingsStore.getState().setLayout(fakeLayout(["voice"]));
    const rev = useSettingsStore.getState().layoutRevision;
    expect(useSettingsStore.getState().applyLayoutPreset(preset!.id)).toBe(true);
    expect(useSettingsStore.getState().layoutRevision).toBe(rev + 1);
    expect(panelsInLayout(useSettingsStore.getState().layout)).toEqual(["media", "timeline"]);

    // Saving with the same name overwrites instead of duplicating.
    useSettingsStore.getState().saveLayoutPreset("Edición");
    expect(useSettingsStore.getState().layoutPresets).toHaveLength(1);

    useSettingsStore.getState().deleteLayoutPreset(preset!.id);
    expect(useSettingsStore.getState().layoutPresets).toHaveLength(0);
  });

  it("restores the default layout by clearing the saved one", () => {
    const s = useSettingsStore.getState();
    s.setLayout(fakeLayout(["media"]));
    s.restoreDefaultLayout();
    expect(useSettingsStore.getState().layout).toBeUndefined();
    expect(useSettingsStore.getState().layoutRevision).toBe(1);
  });

  it("does not bump updatedAt for programmatic layout loads", () => {
    const before = useSettingsStore.getState().updatedAt;
    useSettingsStore.getState().setLayout(fakeLayout(["media"]), false);
    expect(useSettingsStore.getState().updatedAt).toBe(before);
    useSettingsStore.getState().setLayout(fakeLayout(["media", "jobs"]));
    expect(useSettingsStore.getState().updatedAt).not.toBe(before);
  });
});

describe("api settings mapping", () => {
  it("produces a contract-valid DashboardSettings with the ui extension", () => {
    useSettingsStore.getState().setOpenPanels(["media", "timeline", "export"]);
    useSettingsStore.getState().setShortcut("timeline.split", "ctrl+b");
    const payload = toApiSettings(useSettingsStore.getState());
    expect(DashboardSettingsSchema.safeParse(payload).success).toBe(true);
    expect(payload.panels.find((p) => p.id === "media")?.visible).toBe(true);
    expect(payload.panels.find((p) => p.id === "voice")?.visible).toBe(false);
    // "export" is part of the shared PanelIdSchema.
    expect(payload.panels.find((p) => p.id === "export")?.visible).toBe(true);
    expect(payload.shortcuts.find((s) => s.action === "timeline.split")?.keys).toBe("Ctrl+B");
    expect(toPanelLayouts([])).toHaveLength(10);
  });

  it("merges remote settings only when they are newer", () => {
    const s = useSettingsStore.getState();
    s.setTheme("light");
    const local = useSettingsStore.getState().updatedAt;
    const older = toApiSettings({
      ...useSettingsStore.getState(),
      theme: "dark",
      updatedAt: new Date(0).toISOString(),
    });
    expect(useSettingsStore.getState().mergeRemote(older)).toBe(false);

    const newer = toApiSettings({
      ...useSettingsStore.getState(),
      theme: "dark",
      accent: "#d6409f",
      updatedAt: new Date(Date.parse(local) + 60_000).toISOString(),
    });
    expect(useSettingsStore.getState().mergeRemote(newer)).toBe(true);
    expect(useSettingsStore.getState()).toMatchObject({ theme: "dark", accent: "#d6409f" });

    // Server defaults (no ui block) never override local choices.
    expect(
      useSettingsStore
        .getState()
        .mergeRemote({ theme: "system", language: "es", panels: [], shortcuts: [] }),
    ).toBe(false);
  });
});
