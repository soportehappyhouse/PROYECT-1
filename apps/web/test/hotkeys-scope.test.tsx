import { HOTKEYS, type MediaAsset } from "@studio/shared";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Hotkeys } from "@/components/dashboard/Hotkeys";
import {
  defaultShortcutMap,
  hotkeyPolicy,
  isTextEditable,
  SHORTCUT_ACTIONS,
  shortcutAction,
} from "@/lib/shortcuts";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";

/** Sprint 5 (M2, H5): one registry, scopes `global`/`editor`, slider policy, text fields. */
const st = () => useProjectStore.getState();
const asset: MediaAsset = {
  id: "v1",
  kind: "video",
  name: "toma.mp4",
  path: "media/v1.mp4",
  sizeBytes: 1,
  durationSec: 4,
  createdAt: new Date().toISOString(),
};
const clipCount = () => st().project.tracks.reduce((n, t) => n + t.clips.length, 0);
const press = (target: Element, key: string, code: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(target, { key, code, ...extra });
    fireEvent.keyUp(target, { key, code, ...extra });
  });

beforeEach(() => {
  st().loadProject(createEmptyProject("Atajos"));
  useSettingsStore.setState({
    shortcuts: defaultShortcutMap(),
    commandPaletteOpen: false,
    settingsOpen: false,
    projectsOpen: false,
  });
});

describe("registry", () => {
  it("SHORTCUT_ACTIONS is derived from HOTKEYS (ids, keys, help)", () => {
    expect(SHORTCUT_ACTIONS.map((a) => a.id)).toEqual(HOTKEYS.map((h) => h.id));
    expect(SHORTCUT_ACTIONS).toHaveLength(32);
    for (const h of HOTKEYS) {
      const a = shortcutAction(h.id as never)!;
      expect(a.defaultKeys).toBe(h.keys);
      expect(a.help).toBe(h.help_es);
    }
    // Defaults of the 21 existing shortcuts did not change.
    expect(defaultShortcutMap()).toMatchObject({
      "playback.toggle": "Space",
      "timeline.split": "S",
      "timeline.delete": "Delete",
      "playback.shuttleBack": "J",
      "playback.pause": "K",
      "playback.shuttleForward": "L",
      "edit.undo": "Ctrl+Z",
      "edit.redo": "Ctrl+Shift+Z",
      "timeline.rippleDelete": "Shift+Delete",
    });
  });
});

describe("hotkeyPolicy", () => {
  it("editing shortcuts fire on the ruler (role=slider) but arrows do not", () => {
    expect(hotkeyPolicy(shortcutAction("timeline.split")!)).toMatchObject({
      scopes: "editor",
      enableOnFormTags: ["slider"],
    });
    expect(hotkeyPolicy(shortcutAction("playback.frameBack")!).enableOnFormTags).toBe(false);
    expect(hotkeyPolicy(shortcutAction("palette.open")!)).toMatchObject({
      scopes: "global",
      enableOnFormTags: true,
    });
  });

  it("text fields block everything but the global in-form shortcuts", () => {
    const input = document.createElement("input");
    const range = Object.assign(document.createElement("input"), { type: "range" });
    const area = document.createElement("textarea");
    const div = document.createElement("div");
    expect(isTextEditable(input)).toBe(true);
    expect(isTextEditable(area)).toBe(true);
    expect(isTextEditable(range)).toBe(false);
    expect(isTextEditable(div)).toBe(false);
    const split = hotkeyPolicy(shortcutAction("timeline.split")!);
    const save = hotkeyPolicy(shortcutAction("project.save")!);
    expect(split.ignoreEventWhen({ target: input })).toBe(true);
    expect(split.ignoreEventWhen({ target: div })).toBe(false);
    expect(save.ignoreEventWhen({ target: input })).toBe(false);
  });

  it("an open modal dialog pauses editor shortcuts only", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    try {
      const div = document.createElement("div");
      expect(hotkeyPolicy(shortcutAction("timeline.split")!).ignoreEventWhen({ target: div })).toBe(
        true,
      );
      expect(hotkeyPolicy(shortcutAction("project.open")!).ignoreEventWhen({ target: div })).toBe(
        false,
      );
    } finally {
      dialog.remove();
    }
  });
});

describe("<Hotkeys /> in the DOM", () => {
  it("Space presses a focused button inside a modal dialog (audit D4)", () => {
    const { getByTestId } = render(
      <>
        <Hotkeys />
        <button type="button" data-testid="toolbar">
          Play
        </button>
        <div role="dialog" aria-modal="true">
          <button type="button" data-testid="in-dialog">
            Aceptar
          </button>
        </div>
      </>,
    );
    const up = (el: Element) => {
      const ev = new KeyboardEvent("keyup", {
        key: " ",
        code: "Space",
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(up(getByTestId("in-dialog"))).toBe(false); // the dialog button gets its click
    expect(up(getByTestId("toolbar"))).toBe(false); // a modal is open: never blocked
    getByTestId("in-dialog").parentElement!.setAttribute("aria-modal", "false");
    expect(up(getByTestId("toolbar"))).toBe(true); // no modal: Space is Play, not a click
  });

  it("S splits after a click on the ruler (focus on a role=slider)", () => {
    render(
      <>
        <Hotkeys />
        <div role="slider" aria-label="Regla de tiempo" tabIndex={-1} data-testid="ruler" />
      </>,
    );
    const ruler = document.querySelector('[data-testid="ruler"]')!;
    // Chromium reflects ARIA roles (react-hotkeys-hook reads `el.role`); jsdom does not.
    Object.defineProperty(ruler, "role", { value: "slider" });
    st().addAssetClip(asset, { start: 0 });
    st().selectClip(undefined);
    st().setPlayhead(1);
    (ruler as HTMLElement).focus();
    press(ruler, "s", "KeyS");
    expect(clipCount()).toBe(2);
    // Arrows stay with the slider (onSlider:false): the playhead does not move.
    press(ruler, "ArrowRight", "ArrowRight");
    expect(st().playhead).toBe(1);
    // Supr deletes the selected clip from the ruler too.
    st().selectClip(st().project.tracks[0]!.clips[0]!.id);
    press(ruler, "Delete", "Delete");
    expect(clipCount()).toBe(1);
  });

  it("never fires while typing; the projects dialog turns the editor scope off", () => {
    render(
      <>
        <Hotkeys />
        <input aria-label="texto" data-testid="txt" />
      </>,
    );
    st().addAssetClip(asset, { start: 0 });
    st().selectClip(undefined);
    st().setPlayhead(1);
    press(document.querySelector('[data-testid="txt"]')!, "s", "KeyS");
    expect(clipCount()).toBe(1);
    act(() => useSettingsStore.getState().setProjectsOpen(true));
    press(document.body, "s", "KeyS");
    expect(clipCount()).toBe(1);
    // Global shortcuts still work (Ctrl+K opens the palette).
    press(document.body, "k", "KeyK", { ctrlKey: true });
    expect(useSettingsStore.getState().commandPaletteOpen).toBe(true);
    act(() => {
      useSettingsStore.getState().setCommandPaletteOpen(false);
      useSettingsStore.getState().setProjectsOpen(false);
    });
    press(document.body, "s", "KeyS");
    expect(clipCount()).toBe(2);
  });
});
