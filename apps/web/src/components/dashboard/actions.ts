import { toast } from "sonner";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { errorMessage } from "@/lib/api";
import { projectsApi } from "@/lib/api-projects";
import type { ShortcutActionId } from "@/lib/shortcuts";
import { projectDuration, stepFrame } from "@/lib/timeline";
import { focusAssistant } from "@/stores/agent-store";
import { focusConsole } from "@/stores/console-store";
import { keyOrPause, REFRAME_OWNER, useKeyframeStore } from "@/stores/keyframe-store";
import { createEmptyProject, persistLocalProject, useProjectStore } from "@/stores/project-store";
import { useFaceStore } from "@/stores/face-store";
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
      else if (p.deleteSelected() === 0 && p.selectedClipIds.length)
        toast.message("Ese clip está en una pista bloqueada");
      break;
    }
    case "timeline.rippleDelete":
      if (!p.selectedClipIds.length)
        toast.message("Elegí uno o más clips para borrar y cerrar el hueco");
      else if (p.deleteSelected({ ripple: true }) === 0)
        toast.message("Ese clip está en una pista bloqueada");
      break;
    case "timeline.closeGaps": {
      if (!p.selectedClipId) {
        toast.message("Elegí un clip de la pista para cerrar sus huecos");
        break;
      }
      const secs = p.closeGaps();
      toast.message(
        secs > 0 ? `Huecos cerrados (${secs.toFixed(2)} s)` : "La pista no tiene huecos",
      );
      break;
    }
    case "timeline.selectAll":
      p.selectAll();
      break;
    case "timeline.deselect":
      p.selectClip(undefined);
      break;
    case "timeline.trimStartToCursor":
    case "timeline.trimEndToCursor":
      if (!p.trimToCursor(id === "timeline.trimStartToCursor" ? "start" : "end"))
        toast.message("Poné el cursor dentro de un clip para recortarlo");
      break;
    case "timeline.markIn":
      p.markIn();
      break;
    case "timeline.markOut":
      p.markOut();
      break;
    case "timeline.clearInOut":
      p.clearInOut();
      break;
    case "timeline.zoomIn":
      p.zoomBy(1.25);
      break;
    case "timeline.zoomOut":
      p.zoomBy(1 / 1.25);
      break;
    case "timeline.toggleSnap": {
      const enabled = !s.snap.enabled;
      s.setSnap({ enabled });
      toast.message(enabled ? "Imán activado" : "Imán desactivado");
      break;
    }
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
    case "project.open":
      s.setProjectsOpen(true);
      break;
    case "project.new":
      void newProjectNow();
      break;
    case "palette.open":
      s.setCommandPaletteOpen(true);
      break;
    case "layout.reset":
      s.restoreDefaultLayout();
      toast.message("Layout restaurado");
      break;
    case "assistant.open":
      showPanel("assistant");
      focusAssistant();
      break;
    case "console.open":
      showPanel("console");
      focusConsole();
      break;
  }
}

// ---- Sprint 4 M1 (caras): palette / menu entries without a shortcut on purpose -----------------

/** Ajustes → Personas y consentimientos. */
export function openPersons(): void {
  useSettingsStore.getState().setSettingsOpen(true, "persons");
}

/** «Cambiar cara…» on `clipId` (default: the selected clip). */
export function openFaceSwap(clipId?: string): void {
  const id = clipId ?? useProjectStore.getState().selectedClipId;
  if (!id) {
    toast.message("Elegí un clip de video para cambiarle la cara");
    return;
  }
  void useFaceStore.getState().openWizard(id);
}

// ---- Sprint 5 M2: projects (Ctrl+O list, Ctrl+Alt+N new) ------------------------------------------

/** Save the current project before switching (best effort: it is also kept in this browser). */
async function saveBeforeSwitch(): Promise<void> {
  const { saveState } = useProjectStore.getState();
  if (saveState === "dirty" || saveState === "saving" || saveState === "error")
    await saveProjectNow().catch(() => undefined);
}

/** Open another saved project (the current one is saved first). */
export async function openProjectById(id: string): Promise<boolean> {
  if (id === useProjectStore.getState().project.id) return true;
  await saveBeforeSwitch();
  try {
    const project = await projectsApi.get(id);
    useProjectStore.getState().loadProject(project);
    persistLocalProject(project);
    toast.success(`Abriste «${project.name}»`);
    return true;
  } catch (err) {
    toast.error("No se pudo abrir el proyecto", { description: errorMessage(err) });
    return false;
  }
}

/** «Proyecto nuevo» (Ctrl+Alt+N): saves the current one and starts an empty project. */
export async function newProjectNow(): Promise<void> {
  await saveBeforeSwitch();
  const project = createEmptyProject();
  useProjectStore.getState().loadProject(project);
  persistLocalProject(project);
  // Creates it on the api (PUT 404 -> POST) so it shows up in the list right away.
  useProjectStore.getState().setSaveState("dirty");
  await saveProjectNow();
  toast.message("Proyecto nuevo");
}
