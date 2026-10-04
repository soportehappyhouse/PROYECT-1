import { toast } from "sonner";
import { saveProjectNow } from "@/hooks/use-project-sync";
import type { ShortcutActionId } from "@/lib/shortcuts";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showPanel } from "./dock-controller";

/** Executes a bindable action (shared by hotkeys, command palette and menus). */
export function runAction(id: ShortcutActionId): void {
  const p = useProjectStore.getState();
  const s = useSettingsStore.getState();
  const frame = 1 / (p.project.settings.fps || 30);
  switch (id) {
    case "playback.toggle":
      p.togglePlaying();
      break;
    case "playback.toStart":
      p.setPlayhead(0);
      break;
    case "playback.frameBack":
      p.setPlayhead(p.playhead - frame);
      break;
    case "playback.frameForward":
      p.setPlayhead(p.playhead + frame);
      break;
    case "timeline.split":
      if (!p.splitAt()) toast.message("No hay clip bajo el cursor para dividir");
      break;
    case "timeline.delete":
      p.deleteClip();
      break;
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
