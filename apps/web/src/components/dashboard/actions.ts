import { toast } from "sonner";
import { saveProjectNow } from "@/hooks/use-project-sync";
import type { ShortcutActionId } from "@/lib/shortcuts";
import { projectDuration, stepFrame } from "@/lib/timeline";
import { keyOrPause, REFRAME_OWNER, useKeyframeStore } from "@/stores/keyframe-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showPanel } from "./dock-controller";

/** Executes a bindable action (shared by hotkeys, command palette and menus). */
export function runAction(id: ShortcutActionId): void {
  const p = useProjectStore.getState();
  const s = useSettingsStore.getState();
  const fps = p.project.settings.fps || 30;
  switch (id) {
    case "playback.toggle":
      p.togglePlaying();
      break;
    case "playback.toStart":
      p.setPlayhead(0);
      break;
    case "playback.toEnd":
      p.setPlaying(false);
      p.setPlayhead(projectDuration(p.project));
      break;
    case "playback.shuttleBack":
      p.shuttleBackward();
      break;
    case "playback.pause":
      // Sprint 2: stopped with a clip selected, K adds a keyframe (see keyOrPause).
      keyOrPause();
      break;
    case "playback.shuttleForward":
      p.shuttleForward();
      break;
    case "playback.frameBack":
      p.setPlayhead(stepFrame(p.playhead, fps, -1));
      break;
    case "playback.frameForward":
      p.setPlayhead(stepFrame(p.playhead, fps, 1));
      break;
    case "timeline.split":
      if (!p.splitAt()) toast.message("No hay clip bajo el cursor para dividir");
      break;
    case "timeline.delete": {
      // Sprint 2: with a keyframe selected (diamond / inspector) Supr deletes the keyframe.
      const kf = useKeyframeStore.getState();
      const sel = kf.selected;
      if (sel && sel.clipId === REFRAME_OWNER) kf.removeReframe(sel.index);
      else if (sel && sel.clipId === p.selectedClipId) kf.remove(sel.clipId, sel.prop, sel.index);
      else p.deleteClip();
      break;
    }
    case "timeline.zoomIn":
      p.zoomBy(1.25);
      break;
    case "timeline.zoomOut":
      p.zoomBy(1 / 1.25);
      break;
    case "timeline.toggleSnap":
      p.toggleSnapping();
      toast.message(useProjectStore.getState().snapping ? "Imán activado" : "Imán desactivado");
      break;
    case "edit.undo":
      p.undo();
      break;
    case "edit.redo":
      p.redo();
      break;
    case "project.export":
      showPanel("export");
      break;
    case "project.save":
      void saveProjectNow().then(() => {
        const state = useProjectStore.getState().saveState;
        if (state === "saved") toast.success("Proyecto guardado");
        else if (state === "local")
          toast.message("Guardado en este navegador (API de proyectos en desarrollo)");
        else toast.error("No se pudo guardar el proyecto");
      });
      break;
    case "palette.open":
      s.setCommandPaletteOpen(true);
      break;
    case "layout.reset":
      s.restoreDefaultLayout();
      toast.message("Layout restaurado");
      break;
  }
}
