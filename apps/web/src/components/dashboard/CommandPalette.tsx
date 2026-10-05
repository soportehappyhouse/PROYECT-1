"use client";

import { Command } from "cmdk";
import { useMemo } from "react";
import { PANELS } from "@/lib/layout";
import { displayKeys, SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import { TRACK_KIND_LABELS } from "@/lib/timeline";
import { useProjectStore } from "@/stores/project-store";
import { useSilencesStore } from "@/stores/silences-store";
import { cutAtScenes, detectScenes } from "@/components/timeline/scene-actions";
import { openReport } from "@/stores/report-store";
import { THEME_LABELS, useSettingsStore } from "@/stores/settings-store";
import { runAction } from "./actions";
import { showPanel, togglePanel } from "./dock-controller";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useSettingsStore((s) => s.commandPaletteOpen);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const openPanels = useSettingsStore((s) => s.openPanels);
  const presets = useSettingsStore((s) => s.layoutPresets);
  const close = () => useSettingsStore.getState().setCommandPaletteOpen(false);

  const items = useMemo<PaletteItem[]>(() => {
    const s = useSettingsStore.getState;
    const list: PaletteItem[] = SHORTCUT_ACTIONS.filter((a) => a.id !== "palette.open").map(
      (a) => ({
        id: `action:${a.id}`,
        group: a.group,
        label: a.label,
        hint: shortcuts[a.id] ? displayKeys(shortcuts[a.id]) : undefined,
        run: () => runAction(a.id),
      }),
    );
    for (const p of PANELS) {
      const isOpen = openPanels.includes(p.id);
      list.push({
        id: `panel:${p.id}`,
        group: "Paneles",
        label: `${isOpen ? "Ocultar" : "Mostrar"} panel: ${p.title}`,
        run: () => togglePanel(p.id),
      });
      list.push({
        id: `goto:${p.id}`,
        group: "Ir a",
        label: `Ir a ${p.title}`,
        run: () => showPanel(p.id),
      });
    }
    for (const preset of presets)
      list.push({
        id: `layout:${preset.id}`,
        group: "Layouts",
        label: `Aplicar layout: ${preset.name}`,
        run: () => s().applyLayoutPreset(preset.id),
      });
    for (const t of ["light", "dark", "system"] as const)
      list.push({
        id: `theme:${t}`,
        group: "Apariencia",
        label: `Tema: ${THEME_LABELS[t]}`,
        run: () => s().setTheme(t),
      });
    list.push({
      id: "settings",
      group: "Apariencia",
      label: "Abrir ajustes",
      run: () => s().setSettingsOpen(true),
    });
    for (const k of ["video", "audio", "text", "motion"] as const)
      list.push({
        id: `track:${k}`,
        group: "Proyecto",
        label: `Añadir pista de ${TRACK_KIND_LABELS[k].toLowerCase()}`,
        run: () => useProjectStore.getState().addTrack(k),
      });
    list.push({
      id: "text-clip",
      group: "Proyecto",
      label: "Añadir clip de texto en el cursor",
      run: () => useProjectStore.getState().addTextClip(),
    });
    list.push(
      {
        id: "ai:silences",
        group: "IA local",
        label: "Quitar silencios y muletillas del clip seleccionado",
        run: () => {
          const id = useProjectStore.getState().selectedClipId;
          if (id) useSilencesStore.getState().open(id);
        },
      },
      {
        id: "ai:scenes",
        group: "IA local",
        label: "Detectar escenas del clip seleccionado",
        run: () => void detectScenes(),
      },
      {
        id: "ai:cut-scenes",
        group: "IA local",
        label: "Cortar en escenas",
        run: () => cutAtScenes(),
      },
      {
        id: "ai:packs",
        group: "IA local",
        label: "Paquetes de IA y test de rendimiento",
        run: () => s().setSettingsOpen(true, "ai-packs"),
      },
    );
    list.push({
      id: "report-error",
      group: "Ayuda",
      label: "Reportar error (diagnóstico para Claude)",
      run: () => openReport({ source: "paleta" }),
    });
    list.push({
      id: "new-project",
      group: "Proyecto",
      label: "Nuevo proyecto",
      run: () => useProjectStore.getState().newProject(),
    });
    return list;
  }, [shortcuts, openPanels, presets]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const it of items) map.set(it.group, [...(map.get(it.group) ?? []), it]);
    return [...map.entries()];
  }, [items]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => useSettingsStore.getState().setCommandPaletteOpen(o)}
      label="Paleta de comandos"
      overlayClassName="fixed inset-0 z-50 bg-black/40"
      contentClassName="fixed top-[15vh] left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-2xl"
    >
      <Command.Input
        placeholder="Escribe un comando…"
        className="h-11 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-[50vh] overflow-auto p-1">
        <Command.Empty className="p-4 text-center text-xs text-muted-foreground">
          Sin resultados.
        </Command.Empty>
        {groups.map(([group, groupItems]) => (
          <Command.Group
            key={group}
            heading={group}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
          >
            {groupItems.map((it) => (
              <Command.Item
                key={it.id}
                value={`${it.group} ${it.label}`}
                onSelect={() => {
                  close();
                  it.run();
                }}
                className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm data-[selected=true]:bg-accent"
              >
                <span>{it.label}</span>
                {it.hint ? (
                  <kbd className="text-[11px] text-muted-foreground">{it.hint}</kbd>
                ) : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
