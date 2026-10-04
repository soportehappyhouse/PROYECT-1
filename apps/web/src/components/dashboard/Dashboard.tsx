"use client";

import { DEFAULT_DASHBOARD_SETTINGS, type PanelLayout } from "@studio/shared";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PANEL_COMPONENTS } from "@/components/panels";

type Area = PanelLayout["area"];

function AreaColumn({ panels, area }: { panels: PanelLayout[]; area: Area }) {
  const visible = panels
    .filter((p) => p.area === area && p.visible)
    .sort((a, b) => a.order - b.order);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {visible.map((p) => {
        const Component = PANEL_COMPONENTS[p.id];
        return (
          <div key={p.id} className="min-h-0 flex-1">
            <Component />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Dashboard shell: 4 dock areas (left / center / right / bottom).
 * TODO(module-a): replace this static grid with dockview 8 (DockviewReact) for drag & drop reorder,
 * resize, show/hide; serialize dockview layout into DashboardSettings and persist via PUT /api/settings,
 * theme toggle (light/dark/system) and configurable keyboard shortcuts.
 */
export function Dashboard() {
  const { panels } = DEFAULT_DASHBOARD_SETTINGS;
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <span className="font-semibold">Studio</span>
        <Button variant="ghost" size="icon" aria-label="Ajustes">
          <Settings />
        </Button>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-[280px_1fr_320px] grid-rows-[1fr_260px] gap-2 p-2">
        <AreaColumn panels={panels} area="left" />
        <AreaColumn panels={panels} area="center" />
        <AreaColumn panels={panels} area="right" />
        <div className="col-span-3 min-h-0">
          <AreaColumn panels={panels} area="bottom" />
        </div>
      </main>
    </div>
  );
}
