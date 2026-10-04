"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Clapperboard,
  Command as CommandIcon,
  LayoutGrid,
  Monitor,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { toast, Toaster } from "sonner";
import type { AssetDragData } from "@/components/panels/MediaPanel";
import type { TrackDropData } from "@/components/timeline/Timeline";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { Badge } from "@/components/ui/misc";
import { useApplyTheme } from "@/hooks/use-apply-theme";
import { useJobEvents } from "@/hooks/use-job-events";
import { usePlaybackClock } from "@/hooks/use-playback-clock";
import { useProjectSync } from "@/hooks/use-project-sync";
import { useSettingsSync } from "@/hooks/use-settings-sync";
import { PANELS } from "@/lib/layout";
import { displayKeys } from "@/lib/shortcuts";
import { trackKindForAsset } from "@/lib/timeline";
import { useProjectStore, type SaveState } from "@/stores/project-store";
import { THEME_LABELS, useSettingsStore } from "@/stores/settings-store";
import { CommandPalette } from "./CommandPalette";
import { togglePanel } from "./dock-controller";
import { DockLayout } from "./DockLayout";
import { Hotkeys } from "./Hotkeys";
import { SettingsDialog } from "./SettingsDialog";

const SAVE_LABELS: Record<
  SaveState,
  { label: string; tone: "success" | "warning" | "muted" | "danger" | "default" }
> = {
  idle: { label: "", tone: "muted" },
  dirty: { label: "Cambios sin guardar", tone: "muted" },
  saving: { label: "Guardando…", tone: "default" },
  saved: { label: "Guardado", tone: "success" },
  local: { label: "Guardado local", tone: "warning" },
  error: { label: "Error al guardar", tone: "danger" },
};

function ThemeIcon() {
  const theme = useSettingsStore((s) => s.theme);
  return theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />;
}

function Header() {
  const projectName = useProjectStore((s) => s.project.name);
  const saveState = useProjectStore((s) => s.saveState);
  const openPanels = useSettingsStore((s) => s.openPanels);
  const presets = useSettingsStore((s) => s.layoutPresets);
  const paletteKeys = useSettingsStore((s) => s.shortcuts["palette.open"]);
  const resetKeys = useSettingsStore((s) => s.shortcuts["layout.reset"]);
  const settings = useSettingsStore.getState;
  const save = SAVE_LABELS[saveState];

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-3">
      <Clapperboard className="size-5 text-primary" aria-hidden />
      <span className="font-semibold">Studio</span>
      <span className="text-muted-foreground">/</span>
      <span className="max-w-64 truncate text-sm" title={projectName}>
        {projectName}
      </span>
      {save.label ? (
        <Badge
          tone={save.tone}
          title={
            saveState === "local"
              ? "La API de proyectos no está disponible: se guarda en este navegador"
              : undefined
          }
        >
          {save.label}
        </Badge>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="hidden gap-2 text-muted-foreground sm:inline-flex"
          onClick={() => settings().setCommandPaletteOpen(true)}
        >
          <CommandIcon /> Comandos
          {paletteKeys ? <kbd className="text-[11px]">{displayKeys(paletteKeys)}</kbd> : null}
        </Button>
        <Menu
          label="Paneles"
          trigger={(p) => (
            <Button variant="ghost" size="icon" aria-label="Paneles" {...p}>
              <PanelsTopLeft />
            </Button>
          )}
        >
          {() => (
            <>
              <MenuLabel>Mostrar / ocultar paneles</MenuLabel>
              {PANELS.map((panel) => (
                <MenuItem
                  key={panel.id}
                  checked={openPanels.includes(panel.id)}
                  onSelect={() => togglePanel(panel.id)}
                >
                  {panel.title}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <Menu
          label="Layouts"
          trigger={(p) => (
            <Button variant="ghost" size="icon" aria-label="Layouts" {...p}>
              <LayoutGrid />
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                hint={resetKeys ? displayKeys(resetKeys) : undefined}
                onSelect={() => {
                  settings().restoreDefaultLayout();
                  close();
                }}
              >
                Restaurar layout
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  const name = window.prompt("Nombre del layout");
                  if (name && settings().saveLayoutPreset(name))
                    toast.success(`Layout «${name}» guardado`);
                  close();
                }}
              >
                Guardar layout actual…
              </MenuItem>
              {presets.length > 0 ? <MenuSeparator /> : null}
              {presets.length > 0 ? <MenuLabel>Layouts guardados</MenuLabel> : null}
              {presets.map((p) => (
                <MenuItem
                  key={p.id}
                  onSelect={() => {
                    settings().applyLayoutPreset(p.id);
                    close();
                  }}
                >
                  {p.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onSelect={() => {
                  settings().setSettingsOpen(true);
                  close();
                }}
              >
                Gestionar layouts…
              </MenuItem>
            </>
          )}
        </Menu>
        <Menu
          label="Tema"
          trigger={(p) => (
            <Button variant="ghost" size="icon" aria-label="Tema" {...p}>
              <ThemeIcon />
            </Button>
          )}
        >
          {(close) =>
            (["light", "dark", "system"] as const).map((t) => (
              <MenuItem
                key={t}
                checked={settings().theme === t}
                onSelect={() => {
                  settings().setTheme(t);
                  close();
                }}
              >
                {THEME_LABELS[t]}
              </MenuItem>
            ))
          }
        </Menu>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Ajustes"
          onClick={() => settings().setSettingsOpen(true)}
        >
          <Settings />
        </Button>
      </div>
    </header>
  );
}

/** Drop a media item from the Media panel onto a timeline track. */
export function handleAssetDrop(
  event: Pick<DragEndEvent, "active" | "over" | "activatorEvent" | "delta">,
): void {
  const data = event.active.data.current as AssetDragData | undefined;
  const target = event.over?.data.current as TrackDropData | undefined;
  if (data?.type !== "asset" || !target) return;
  const pointer = event.activatorEvent as PointerEvent | MouseEvent | null;
  const clientX = (pointer && "clientX" in pointer ? pointer.clientX : 0) + event.delta.x;
  const kind = trackKindForAsset(data.asset);
  const start = target.timeAt(clientX);
  useProjectStore.getState().addAssetClip(data.asset, {
    start,
    ...(target.kind === kind ? { trackId: target.trackId } : {}),
  });
  if (target.kind !== kind)
    toast.message(`Añadido a una pista de ${kind === "audio" ? "audio" : kind}`);
}

export function Dashboard() {
  const resolvedTheme = useApplyTheme();
  useSettingsSync();
  useProjectSync();
  useJobEvents();
  usePlaybackClock();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragging, setDragging] = useState<AssetDragData | undefined>(undefined);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) =>
        setDragging(e.active.data.current as AssetDragData | undefined)
      }
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={(e) => {
        setDragging(undefined);
        handleAssetDrop(e);
      }}
    >
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <Header />
        <main className="min-h-0 flex-1">
          <DockLayout resolvedTheme={resolvedTheme} />
        </main>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="rounded-md border bg-card px-2 py-1 text-xs shadow-lg">
            {dragging.asset.name}
          </div>
        ) : null}
      </DragOverlay>
      <Hotkeys />
      <CommandPalette />
      <SettingsDialog />
      <Toaster theme={resolvedTheme} position="bottom-right" richColors closeButton />
    </DndContext>
  );
}
