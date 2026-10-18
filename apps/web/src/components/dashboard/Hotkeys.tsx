"use client";

import { useEffect, useMemo } from "react";
import { HotkeysProvider, useHotkeys, useHotkeysContext } from "react-hotkeys-hook";
import {
  hotkeyPolicy,
  INITIAL_HOTKEY_SCOPES,
  modalDialogOpen,
  normalizeKeys,
  SHORTCUT_ACTIONS,
  toHotkeyString,
  type ShortcutActionId,
  type ShortcutActionInfo,
} from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settings-store";
import { runAction } from "./actions";

/** Transport actions that must not auto-repeat while the key is held down. */
const NO_REPEAT = new Set<ShortcutActionId>([
  "playback.toggle",
  "playback.pause",
  "playback.shuttleBack",
  "playback.shuttleForward",
]);

function Binding({ info, keys }: { info: ShortcutActionInfo; keys: string }) {
  const action = info.id;
  // The settings dialog records new keys: nothing fires while it is open. The command palette
  // only lets its own shortcut through (to close it again).
  const blocked = useSettingsStore(
    (s) => s.settingsOpen || (s.commandPaletteOpen && action !== "palette.open"),
  );
  const policy = useMemo(() => hotkeyPolicy(info), [info]);
  useHotkeys(
    toHotkeyString(keys),
    (e) => {
      e.preventDefault();
      if (e.repeat && NO_REPEAT.has(action)) return;
      runAction(action);
    },
    {
      enabled: Boolean(keys) && !blocked,
      scopes: policy.scopes,
      enableOnFormTags: policy.enableOnFormTags,
      ignoreEventWhen: policy.ignoreEventWhen,
      preventDefault: true,
    },
    [action, keys, blocked, policy],
  );
  return null;
}

/**
 * Sprint 5 (H5): `editor` shortcuts turn off while the command palette, the settings dialog or the
 * projects list is open; `global` ones (palette, save, export, assistant, open/new project) stay.
 */
function EditorScopeGate() {
  const { enableScope, disableScope } = useHotkeysContext();
  const blocked = useSettingsStore((s) => s.settingsOpen || s.commandPaletteOpen || s.projectsOpen);
  useEffect(() => {
    if (blocked) disableScope("editor");
    else enableScope("editor");
  }, [blocked, enableScope, disableScope]);
  return null;
}

/**
 * Feedback 8: with a toolbar button focused (e.g. after clicking Play), Space used to toggle twice:
 * once through the shortcut and once more as the browser "clicks" the focused button on keyup.
 * When a single-key shortcut is bound to Space, the button activation is cancelled.
 */
function useSpaceDoesNotClickButtons(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (!t || !(t.tagName === "BUTTON" || t.getAttribute("role") === "button")) return;
      // Audit D4: in any modal dialog (Ajustes, Proyectos, Exportar…) Space must still press the
      // focused button: Play is paused there anyway.
      if (useSettingsStore.getState().settingsOpen || modalDialogOpen()) return;
      e.preventDefault();
    };
    document.addEventListener("keyup", onKey, true);
    document.addEventListener("keypress", onKey, true);
    return () => {
      document.removeEventListener("keyup", onKey, true);
      document.removeEventListener("keypress", onKey, true);
    };
  }, [enabled]);
}

/** Registers every configurable shortcut (shared HOTKEYS registry + the user's keys). */
export function Hotkeys() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  useSpaceDoesNotClickButtons(
    Object.values(shortcuts).some((k) => k && normalizeKeys(k) === "Space"),
  );
  return (
    <HotkeysProvider initiallyActiveScopes={[...INITIAL_HOTKEY_SCOPES]}>
      <EditorScopeGate />
      {SHORTCUT_ACTIONS.map((a) => (
        <Binding key={a.id} info={a} keys={shortcuts[a.id] ?? ""} />
      ))}
    </HotkeysProvider>
  );
}
