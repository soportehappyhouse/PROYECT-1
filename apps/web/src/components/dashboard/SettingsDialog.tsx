"use client";

import type { Theme, UiDensity } from "@studio/shared";
import { Check, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Badge, Section, Tabs } from "@/components/ui/misc";
import {
  displayKeys,
  findConflicts,
  keysFromEvent,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import {
  ACCENT_PRESETS,
  DENSITY_LABELS,
  THEME_LABELS,
  useSettingsStore,
  type SettingsTab,
} from "@/stores/settings-store";
import { AiPacksTab } from "./AiPacksTab";
import { AssistantTab } from "./AssistantTab";

type Tab = SettingsTab;

function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const density = useSettingsStore((s) => s.density);
  const { setTheme, setAccent, setDensity } = useSettingsStore.getState();
  return (
    <div className="flex flex-col gap-5">
      <Section title="Tema">
        <Tabs<Theme>
          value={theme}
          onChange={setTheme}
          items={(["light", "dark", "system"] as const).map((t) => ({
            value: t,
            label: THEME_LABELS[t],
          }))}
        />
      </Section>
      <Section title="Color de acento">
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              title={p.name}
              aria-label={`Acento ${p.name}`}
              aria-pressed={accent === p.value}
              onClick={() => setAccent(p.value)}
              className="flex size-7 items-center justify-center rounded-full border-2 border-transparent aria-pressed:border-foreground"
              style={{ background: p.value }}
            >
              {accent === p.value ? <Check className="size-3.5 text-white" /> : null}
            </button>
          ))}
          <Label className="flex-row items-center gap-2">
            Personalizado
            <Input
              type="color"
              className="h-7 w-10 p-0.5"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
          </Label>
        </div>
      </Section>
      <Section title="Densidad de la interfaz">
        <Tabs<UiDensity>
          value={density}
          onChange={setDensity}
          items={(["compact", "comfortable", "spacious"] as const).map((d) => ({
            value: d,
            label: DENSITY_LABELS[d],
          }))}
        />
      </Section>
    </div>
  );
}

function ShortcutsTab() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const { setShortcut, resetShortcuts } = useSettingsStore.getState();
  const [recording, setRecording] = useState<ShortcutActionId | undefined>(undefined);
  const conflicts = useMemo(() => findConflicts(shortcuts), [shortcuts]);
  const conflictIds = new Set(Object.values(conflicts).flat());
  const groups = [...new Set(SHORTCUT_ACTIONS.map((a) => a.group))];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Haz clic en un atajo y pulsa la nueva combinación (Esc cancela, Retroceso lo borra).
        </p>
        <Button size="xs" variant="outline" onClick={resetShortcuts}>
          <RotateCcw /> Restablecer
        </Button>
      </div>
      {Object.keys(conflicts).length > 0 ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          Hay atajos repetidos: {Object.keys(conflicts).map(displayKeys).join(", ")}
        </p>
      ) : null}
      {groups.map((g) => (
        <Section key={g} title={g}>
          <ul className="flex flex-col divide-y rounded-md border">
            {SHORTCUT_ACTIONS.filter((a) => a.group === g).map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
              >
                <span>{a.label}</span>
                <button
                  type="button"
                  aria-label={`Cambiar atajo de ${a.label}`}
                  className={cn(
                    "min-w-28 rounded border px-2 py-0.5 text-xs font-mono",
                    recording === a.id && "border-primary bg-primary/10",
                    conflictIds.has(a.id) && "border-destructive text-destructive",
                  )}
                  onClick={() => setRecording(a.id)}
                  onBlur={() => setRecording(undefined)}
                  onKeyDown={(e) => {
                    if (recording !== a.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") return setRecording(undefined);
                    if (e.key === "Backspace") {
                      setShortcut(a.id, "");
                      return setRecording(undefined);
                    }
                    const keys = keysFromEvent(e.nativeEvent);
                    if (!keys) return;
                    setShortcut(a.id, keys);
                    setRecording(undefined);
                  }}
                >
                  {recording === a.id
                    ? "Pulsa una tecla…"
                    : shortcuts[a.id]
                      ? displayKeys(shortcuts[a.id])
                      : "—"}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function LayoutsTab() {
  const presets = useSettingsStore((s) => s.layoutPresets);
  const syncState = useSettingsStore((s) => s.syncState);
  const { saveLayoutPreset, applyLayoutPreset, deleteLayoutPreset, restoreDefaultLayout } =
    useSettingsStore.getState();
  const [name, setName] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <Section title="Layout actual">
        <div className="flex gap-2">
          <Input
            placeholder="Nombre del layout (p. ej. Edición de voz)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() => {
              if (saveLayoutPreset(name)) {
                toast.success(`Layout «${name.trim()}» guardado`);
                setName("");
              } else toast.error("No se pudo guardar el layout");
            }}
          >
            Guardar
          </Button>
        </div>
        <Button size="sm" variant="outline" onClick={restoreDefaultLayout}>
          <RotateCcw /> Restaurar layout por defecto
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Se guarda en este navegador
          {syncState === "synced"
            ? " y en la API local."
            : syncState === "local"
              ? " (la API de ajustes está en desarrollo)."
              : "."}
        </p>
      </Section>
      <Section title="Layouts guardados">
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground">Todavía no hay layouts guardados.</p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {presets.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
              <span className="flex-1">{p.name}</span>
              <Badge tone="muted">{new Date(p.createdAt).toLocaleDateString("es")}</Badge>
              <Button size="xs" variant="outline" onClick={() => applyLayoutPreset(p.id)}>
                Aplicar
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Eliminar layout ${p.name}`}
                onClick={() => deleteLayoutPreset(p.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const requestedTab = useSettingsStore((s) => s.settingsTab);
  const [tab, setTab] = useState<Tab>("appearance");
  useEffect(() => {
    if (open && requestedTab) setTab(requestedTab);
  }, [open, requestedTab]);
  return (
    <Dialog
      open={open}
      onClose={() => useSettingsStore.getState().setSettingsOpen(false)}
      title="Ajustes"
    >
      <div className="flex flex-col gap-4">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "appearance", label: "Apariencia" },
            { value: "shortcuts", label: "Atajos" },
            { value: "layouts", label: "Layouts" },
            { value: "ai-packs", label: "Paquetes de IA" },
            { value: "assistant", label: "Asistente local" },
          ]}
        />
        {tab === "appearance" ? (
          <AppearanceTab />
        ) : tab === "shortcuts" ? (
          <ShortcutsTab />
        ) : tab === "layouts" ? (
          <LayoutsTab />
        ) : tab === "assistant" ? (
          <AssistantTab />
        ) : (
          <AiPacksTab />
        )}
      </div>
    </Dialog>
  );
}
