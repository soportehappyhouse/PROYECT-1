"use client";

import { useHotkeys } from "react-hotkeys-hook";
import { SHORTCUT_ACTIONS, toHotkeyString, type ShortcutActionId } from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settings-store";
import { runAction } from "./actions";

/** Actions that still fire while typing in a form field. */
const GLOBAL_IN_FORMS = new Set<ShortcutActionId>([
  "palette.open",
  "project.save",
  "project.export",
]);

function Binding({ action, keys }: { action: ShortcutActionId; keys: string }) {
  const blocked = useSettingsStore(
    (s) => s.settingsOpen || (s.commandPaletteOpen && action !== "palette.open"),
  );
  useHotkeys(
    toHotkeyString(keys),
    (e) => {
      e.preventDefault();
      runAction(action);
    },
    {
      enabled: Boolean(keys) && !blocked,
      enableOnFormTags: GLOBAL_IN_FORMS.has(action),
      preventDefault: true,
    },
    [action, keys],
  );
  return null;
}

/** Registers every configurable shortcut from the settings store. */
export function Hotkeys() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  return (
    <>
      {SHORTCUT_ACTIONS.map((a) => (
        <Binding key={a.id} action={a.id} keys={shortcuts[a.id] ?? ""} />
      ))}
    </>
  );
}
