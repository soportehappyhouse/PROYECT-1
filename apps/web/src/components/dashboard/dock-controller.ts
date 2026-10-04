import type { DockviewApi } from "dockview-react";
import { addPanelWithDefaults, panelTitle, type WebPanelId } from "@/lib/layout";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";

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
  addBreadcrumb("panel", `Abrió el panel ${panelTitle(id)}`, { panel: id }, `panel:${id}`);
  if (existing) {
    existing.api.setActive();
    return;
  }
  addPanelWithDefaults(dockApi, id);
  dockApi.getPanel(id)?.api.setActive();
}

export function hidePanel(id: WebPanelId): void {
  const panel = dockApi?.getPanel(id);
  if (panel) {
    addBreadcrumb("panel", `Cerró el panel ${panelTitle(id)}`, { panel: id });
    dockApi?.removePanel(panel);
  }
}

export function togglePanel(id: WebPanelId): void {
  if (isPanelOpen(id)) hidePanel(id);
  else showPanel(id);
}

export { panelTitle };
