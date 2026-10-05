import { DEFAULT_DASHBOARD_SETTINGS, type Shortcut } from "@studio/shared";

export type ShortcutActionId =
  | "playback.toggle"
  | "playback.toStart"
  | "playback.frameBack"
  | "playback.frameForward"
  | "playback.toEnd"
  | "playback.shuttleBack"
  | "playback.pause"
  | "playback.shuttleForward"
  | "timeline.split"
  | "timeline.delete"
  | "timeline.zoomIn"
  | "timeline.zoomOut"
  | "timeline.toggleSnap"
  | "edit.undo"
  | "edit.redo"
  | "project.export"
  | "project.save"
  | "palette.open"
  | "layout.reset";

export interface ShortcutActionInfo {
  id: ShortcutActionId;
  label: string;
  group: "Reproducción" | "Línea de tiempo" | "Edición" | "Proyecto" | "Interfaz";
  defaultKeys: string;
}

const contractDefaults = Object.fromEntries(
  DEFAULT_DASHBOARD_SETTINGS.shortcuts.map((s) => [s.action, s.keys]),
) as Record<string, string>;

/** Every bindable action. Defaults come from the shared contract when it defines them. */
export const SHORTCUT_ACTIONS: readonly ShortcutActionInfo[] = [
  {
    id: "playback.toggle",
    label: "Reproducir / pausar",
    group: "Reproducción",
    defaultKeys: contractDefaults["playback.toggle"] ?? "Space",
  },
  { id: "playback.toStart", label: "Ir al inicio", group: "Reproducción", defaultKeys: "Home" },
  { id: "playback.toEnd", label: "Ir al final", group: "Reproducción", defaultKeys: "End" },
  {
    id: "playback.shuttleBack",
    label: "Reproducir hacia atrás (otra vez: más rápido)",
    group: "Reproducción",
    defaultKeys: "J",
  },
  {
    id: "playback.pause",
    label: "Pausa (detenido, con un clip elegido: agregar keyframe)",
    group: "Reproducción",
    defaultKeys: "K",
  },
  {
    id: "playback.shuttleForward",
    label: "Reproducir (otra vez: más rápido)",
    group: "Reproducción",
    defaultKeys: "L",
  },
  {
    id: "playback.frameBack",
    label: "Fotograma anterior",
    group: "Reproducción",
    defaultKeys: "ArrowLeft",
  },
  {
    id: "playback.frameForward",
    label: "Fotograma siguiente",
    group: "Reproducción",
    defaultKeys: "ArrowRight",
  },
  {
    id: "timeline.split",
    label: "Dividir clip en el cursor",
    group: "Línea de tiempo",
    defaultKeys: contractDefaults["timeline.split"] ?? "S",
  },
  {
    id: "timeline.delete",
    label: "Eliminar clip seleccionado",
    group: "Línea de tiempo",
    defaultKeys: contractDefaults["timeline.delete"] ?? "Delete",
  },
  { id: "timeline.zoomIn", label: "Acercar", group: "Línea de tiempo", defaultKeys: "Equal" },
  { id: "timeline.zoomOut", label: "Alejar", group: "Línea de tiempo", defaultKeys: "Minus" },
  {
    id: "timeline.toggleSnap",
    label: "Activar / desactivar imán",
    group: "Línea de tiempo",
    defaultKeys: "N",
  },
  {
    id: "edit.undo",
    label: "Deshacer",
    group: "Edición",
    defaultKeys: contractDefaults["edit.undo"] ?? "Ctrl+Z",
  },
  {
    id: "edit.redo",
    label: "Rehacer",
    group: "Edición",
    defaultKeys: contractDefaults["edit.redo"] ?? "Ctrl+Shift+Z",
  },
  {
    id: "project.export",
    label: "Exportar",
    group: "Proyecto",
    defaultKeys: contractDefaults["project.export"] ?? "Ctrl+E",
  },
  { id: "project.save", label: "Guardar proyecto", group: "Proyecto", defaultKeys: "Ctrl+S" },
  { id: "palette.open", label: "Paleta de comandos", group: "Interfaz", defaultKeys: "Ctrl+K" },
  { id: "layout.reset", label: "Restaurar layout", group: "Interfaz", defaultKeys: "Ctrl+Shift+R" },
];

export type ShortcutMap = Record<ShortcutActionId, string>;

export function defaultShortcutMap(): ShortcutMap {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultKeys])) as ShortcutMap;
}

const ACTION_IDS = new Set<string>(SHORTCUT_ACTIONS.map((a) => a.id));

/** Contract array -> map (unknown actions ignored, missing ones get defaults). */
export function shortcutsFromList(list: readonly Shortcut[] | undefined): ShortcutMap {
  const map = defaultShortcutMap();
  for (const s of list ?? [])
    if (ACTION_IDS.has(s.action)) map[s.action as ShortcutActionId] = s.keys;
  return map;
}

export function shortcutsToList(map: ShortcutMap): Shortcut[] {
  return SHORTCUT_ACTIONS.map((a) => ({ action: a.id, keys: map[a.id] ?? a.defaultKeys }));
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** Normalize "shift+ctrl+k" -> "Ctrl+Shift+K" so combos compare reliably. */
export function normalizeKeys(keys: string): string {
  const parts = keys
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods = new Set<string>();
  const rest: string[] = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "ctrl" || low === "control" || low === "mod") mods.add("Ctrl");
    else if (low === "alt" || low === "option") mods.add("Alt");
    else if (low === "shift") mods.add("Shift");
    else if (low === "meta" || low === "cmd" || low === "command") mods.add("Meta");
    else if (low.length === 1) rest.push(low.toUpperCase());
    else
      rest.push(
        low === "del" ? "Delete" : low === "esc" ? "Escape" : p[0]!.toUpperCase() + p.slice(1),
      );
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), ...rest].join("+");
}

/** Contract format ("Ctrl+Shift+Z") -> react-hotkeys-hook format ("ctrl+shift+z"). */
export function toHotkeyString(keys: string): string {
  return normalizeKeys(keys)
    .split("+")
    .map((p) => p.toLowerCase())
    .join("+");
}

/** Build the contract string from a keyboard event (uses physical `code`, like react-hotkeys-hook). */
export function keysFromEvent(
  e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code" | "key">,
): string | undefined {
  const code = e.code || e.key;
  if (!code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return undefined;
  const key = code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Numpad/, "");
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return normalizeKeys([...mods, key].join("+"));
}

/** Map of normalized combo -> action ids using it (only entries with 2+ actions). */
export function findConflicts(map: ShortcutMap): Record<string, ShortcutActionId[]> {
  const byCombo: Record<string, ShortcutActionId[]> = {};
  for (const a of SHORTCUT_ACTIONS) {
    const keys = map[a.id];
    if (!keys) continue;
    const k = normalizeKeys(keys);
    (byCombo[k] ??= []).push(a.id);
  }
  return Object.fromEntries(Object.entries(byCombo).filter(([, ids]) => ids.length > 1));
}

/** Human label: "Ctrl+Shift+Z" -> "Ctrl ⇧ Z" style kept simple and Spanish-friendly. */
export function displayKeys(keys: string): string {
  const names: Record<string, string> = {
    Space: "Espacio",
    Delete: "Supr",
    Equal: "=",
    Minus: "-",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Home: "Inicio",
    End: "Fin",
    Escape: "Esc",
    Shift: "Mayús",
  };
  return normalizeKeys(keys)
    .split("+")
    .map((p) => names[p] ?? p)
    .join(" + ");
}
