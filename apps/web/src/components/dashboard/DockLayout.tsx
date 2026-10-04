"use client";

import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { PANEL_COMPONENTS } from "@/components/panels";
import {
  buildDefaultLayout,
  isValidSerializedLayout,
  isWebPanelId,
  PANEL_IDS,
  type WebPanelId,
} from "@/lib/layout";
import { useSettingsStore } from "@/stores/settings-store";
import { getDockApi, setDockApi } from "./dock-controller";

/** Wrap each panel so dockview gets FunctionComponent<IDockviewPanelProps>. */
const COMPONENTS = Object.fromEntries(
  PANEL_IDS.map((id) => {
    const Component = PANEL_COMPONENTS[id];
    const Wrapped = (_props: IDockviewPanelProps) => <Component />;
    Wrapped.displayName = `DockPanel(${id})`;
    return [id, Wrapped];
  }),
) as Record<WebPanelId, React.FunctionComponent<IDockviewPanelProps>>;

function openPanelIds(): WebPanelId[] {
  return (getDockApi()?.panels ?? []).map((p) => p.id).filter(isWebPanelId);
}

/** True while a layout is applied programmatically (its change events are not user edits). */
let applying = false;

/** Load `layout` into dockview, falling back to the default arrangement when it is missing/invalid. */
function applyLayout(layout: unknown): void {
  const api = getDockApi();
  if (!api) return;
  applying = true;
  setTimeout(() => {
    applying = false;
  }, 100);
  if (isValidSerializedLayout(layout)) {
    try {
      api.fromJSON(layout as Parameters<typeof api.fromJSON>[0]);
      return;
    } catch {
      // incompatible JSON (e.g. dockview major upgrade): rebuild the default
    }
  }
  api.clear();
  buildDefaultLayout(api);
  // Sensible default proportions: narrow side columns, wide preview, ~1/3 height timeline.
  const width = api.width || 1400;
  const height = api.height || 800;
  api.getPanel("media")?.group.api.setSize({ width: Math.round(Math.min(340, width * 0.22)) });
  api.getPanel("inspector")?.group.api.setSize({ width: Math.round(Math.min(400, width * 0.26)) });
  api.getPanel("timeline")?.group.api.setSize({ height: Math.round(Math.max(220, height * 0.36)) });
}

function syncFromDock(userChange: boolean): void {
  const api = getDockApi();
  if (!api) return;
  const s = useSettingsStore.getState();
  s.setOpenPanels(openPanelIds());
  s.setLayout(api.toJSON(), userChange && !applying);
}

export function DockLayout({ resolvedTheme }: { resolvedTheme: "light" | "dark" }) {
  const layoutRevision = useSettingsStore((s) => s.layoutRevision);
  const firstRevision = useRef(layoutRevision);
  const theme = useMemo(() => (resolvedTheme === "dark" ? themeDark : themeLight), [resolvedTheme]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setDockApi(event.api);
    applyLayout(useSettingsStore.getState().layout);
    syncFromDock(false);
    event.api.onDidLayoutChange(() => syncFromDock(true));
  }, []);

  // Restore default / apply preset / remote settings: rebuild from the store's layout.
  useEffect(() => {
    if (layoutRevision === firstRevision.current) return;
    applyLayout(useSettingsStore.getState().layout);
    syncFromDock(false);
  }, [layoutRevision]);

  useEffect(() => () => setDockApi(undefined), []);

  return (
    <DockviewReact
      className="studio-dock h-full w-full"
      components={COMPONENTS}
      onReady={onReady}
      theme={theme}
    />
  );
}
