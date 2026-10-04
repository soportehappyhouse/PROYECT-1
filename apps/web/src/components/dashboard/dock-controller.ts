import type { DockviewApi } from "dockview-react";
import { addPanelWithDefaults, panelTitle, type WebPanelId } from "@/lib/layout";

/** Module-level handle on the live dockview api (one dashboard per page). */
let dockApi: DockviewApi | undefined;

export function setDockApi(api: DockviewApi | undefined): void {
  dockApi = api;
}

export function getDockApi(): DockviewApi | undefined {
  return dockApi;
}

export function isPanelOpen(id: WebPanelId): boolean {
  return Boolean(dockApi?.getPanel(id));
}

export function showPanel(id: WebPanelId): void {
  if (!dockApi) return;
  const existing = dockApi.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  addPanelWithDefaults(dockApi, id);
  dockApi.getPanel(id)?.api.setActive();
}

export function hidePanel(id: WebPanelId): void {
  const panel = dockApi?.getPanel(id);
  if (panel) dockApi?.removePanel(panel);
}

export function togglePanel(id: WebPanelId): void {
  if (isPanelOpen(id)) hidePanel(id);
  else showPanel(id);
}

export { panelTitle };
