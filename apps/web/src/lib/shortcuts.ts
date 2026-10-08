import { HOTKEYS, type HotkeyDef, type HotkeyGroup, type Shortcut } from "@studio/shared";

/** Every bindable action: the ids of the shared HOTKEYS registry (Sprint 5, decision 7). */
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
  | "timeline.rippleDelete"
  | "timeline.closeGaps"
  | "timeline.selectAll"
  | "timeline.deselect"
  | "timeline.trimStartToCursor"
  | "timeline.trimEndToCursor"
  | "timeline.markIn"
  | "timeline.markOut"
  | "timeline.clearInOut"
  | "timeline.zoomIn"
  | "timeline.zoomOut"
  | "timeline.toggleSnap"
  | "edit.undo"
  | "edit.redo"
  | "project.export"
  | "project.save"
  | "project.open"
  | "project.new"
  | "palette.open"
  | "layout.reset"
  | "assistant.open"
  | "console.open";

export interface ShortcutActionInfo {
  id: ShortcutActionId;
  label: string;
  group: HotkeyGroup;
  defaultKeys: string;
  /** Sprint 5: what it does (Ajustes → Atajos, tooltips). */
  help: string;
  scope: HotkeyDef["scope"];
  onSlider: boolean;
  inTextFields: boolean;
}

/** Derived from the shared HOTKEYS registry (single source for defaults, scopes and help). */
export const SHORTCUT_ACTIONS: readonly ShortcutActionInfo[] = HOTKEYS.map((h) => ({
  id: h.id as ShortcutActionId,
  label: h.label_es,
  group: h.group,
  defaultKeys: h.keys,
  help: h.help_es,
  scope: h.scope,
  onSlider: h.onSlider,
  inTextFields: h.inTextFields,
}));

export function shortcutAction(id: ShortcutActionId): ShortcutActionInfo | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === id);
}

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

// ---- Sprint 5 (M2): hotkey scopes and focus policy (contract decision 7, H5) ---------------------

/** Scopes active when nothing blocks the editor (dialogs and the palette turn `editor` off). */
export const INITIAL_HOTKEY_SCOPES = ["global", "editor"] as const;

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** True where typing produces text: text inputs, textareas, contenteditable, textbox roles. */
export function isTextEditable(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input")
    return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || "text").toLowerCase());
  if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true") return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/** True while a modal dialog is open (its own keys win; editor shortcuts wait). */
export function modalDialogOpen(doc: Document | undefined = globalThis.document): boolean {
  return !!doc?.querySelector('[role="dialog"][aria-modal="true"]');
}

/** react-hotkeys-hook options for one action (scope, form tags, when to ignore). */
export function hotkeyPolicy(
  info: Pick<ShortcutActionInfo, "scope" | "onSlider" | "inTextFields">,
): {
  scopes: "global" | "editor";
  enableOnFormTags: boolean | ["slider"];
  ignoreEventWhen: (e: Pick<KeyboardEvent, "target">) => boolean;
} {
  return {
    scopes: info.scope,
    enableOnFormTags: info.inTextFields ? true : info.onSlider ? ["slider"] : false,
    ignoreEventWhen: (e) => {
      if (info.inTextFields) return false;
      if (isTextEditable(e.target)) return true;
      return info.scope === "editor" && modalDialogOpen();
    },
  };
}
