"use client";

import { useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  normalizeKeys,
  SHORTCUT_ACTIONS,
  toHotkeyString,
  type ShortcutActionId,
} from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settings-store";
import { runAction } from "./actions";

/** Actions that still fire while typing in a form field. */
const GLOBAL_IN_FORMS = new Set<ShortcutActionId>([
  "palette.open",
  "project.save",
  "project.export",
]);

/** Transport actions that must not auto-repeat while the key is held down. */
const NO_REPEAT = new Set<ShortcutActionId>([
  "playback.toggle",
  "playback.pause",
  "playback.shuttleBack",
  "playback.shuttleForward",
]);

function Binding({ action, keys }: { action: ShortcutActionId; keys: string }) {
  const blocked = useSettingsStore(
    (s) => s.settingsOpen || (s.commandPaletteOpen && action !== "palette.open"),
  );
  useHotkeys(
    toHotkeyString(keys),
    (e) => {
      e.preventDefault();
      if (e.repeat && NO_REPEAT.has(action)) return;
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
      if (useSettingsStore.getState().settingsOpen) return;
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

/** Registers every configurable shortcut from the settings store. */
export function Hotkeys() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  useSpaceDoesNotClickButtons(
    Object.values(shortcuts).some((k) => k && normalizeKeys(k) === "Space"),
  );
  return (
    <>
      {SHORTCUT_ACTIONS.map((a) => (
        <Binding key={a.id} action={a.id} keys={shortcuts[a.id] ?? ""} />
      ))}
    </>
  );
}
