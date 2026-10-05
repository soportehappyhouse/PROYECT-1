"use client";

import type { TrackKind } from "@studio/shared";
import {
  AudioWaveform,
  Film,
  Magnet,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { cutAtScenes, detectScenes } from "@/components/timeline/scene-actions";
import { Timeline } from "@/components/timeline/Timeline";
import { Button } from "@/components/ui/button";
import { Range } from "@/components/ui/input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { formatTime } from "@/lib/format";
import { findClip, projectDuration, TRACK_KIND_LABELS } from "@/lib/timeline";
import { MAX_ZOOM, MIN_ZOOM, useProjectStore } from "@/stores/project-store";
import { useScenesStore } from "@/stores/scenes-store";
import { useSilencesStore } from "@/stores/silences-store";
import { Panel } from "./Panel";

const KINDS: TrackKind[] = ["video", "audio", "text", "motion"];

export function TimelinePanel() {
  const zoom = useProjectStore((s) => s.zoom);
  const snapping = useProjectStore((s) => s.snapping);
  const playhead = useProjectStore((s) => s.playhead);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);
  const hasSelection = useProjectStore((s) => s.selectedClipId !== undefined);
  const duration = useProjectStore((s) => projectDuration(s.project));
  const showScenes = useScenesStore((s) => s.visible);
  const store = useProjectStore.getState;

  const openSilences = () => {
    const { project, selectedClipId } = store();
    const found = selectedClipId ? findClip(project, selectedClipId) : undefined;
    if (!found?.clip.assetId || (found.track.kind !== "audio" && found.track.kind !== "video"))
      return toast.message("Selecciona un clip con voz para quitar silencios y muletillas");
    useSilencesStore.getState().open(found.clip.id);
  };

  const toolbar = (
    <>
      <Menu
        label="Añadir pista"
        align="start"
        trigger={(p) => (
          <Button variant="ghost" size="xs" tooltip="Añadir una pista" {...p}>
            <Plus /> Pista
          </Button>
        )}
      >
        {(close) =>
          KINDS.map((k) => (
            <MenuItem
              key={k}
              onSelect={() => {
                store().addTrack(k);
                close();
              }}
            >
              Pista de {TRACK_KIND_LABELS[k].toLowerCase()}
            </MenuItem>
          ))
        }
      </Menu>
      <Button
        variant="ghost"
        size="xs"
        tooltip="Añadir un texto en el cursor"
        onClick={() => store().addTextClip()}
      >
        <Type /> Texto
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Deshacer"
        shortcut="edit.undo"
        disabled={!canUndo}
        onClick={() => store().undo()}
      >
        <Undo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rehacer"
        shortcut="edit.redo"
        disabled={!canRedo}
        onClick={() => store().redo()}
      >
        <Redo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Cortar en el cursor"
        shortcut="timeline.split"
        onClick={() => store().splitAt()}
      >
        <Scissors />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Eliminar clip"
        shortcut="timeline.delete"
        disabled={!hasSelection}
        onClick={() => store().deleteClip()}
      >
        <Trash2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Quitar silencios y muletillas"
        disabled={!hasSelection}
        onClick={openSilences}
      >
        <AudioWaveform />
      </Button>
      <Menu
        label="Escenas"
        align="start"
        trigger={(p) => (
          <Button variant="ghost" size="xs" tooltip="Detectar y cortar en cambios de escena" {...p}>
            <Film /> Escenas
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                void detectScenes();
              }}
            >
              Detectar escenas
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                cutAtScenes();
              }}
            >
              Cortar en escenas
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              checked={showScenes}
              onSelect={() => useScenesStore.getState().toggleVisible()}
            >
              Mostrar marcadores de escena
            </MenuItem>
          </>
        )}
      </Menu>
      <Button
        variant={snapping ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Imán (snapping)"
        shortcut="timeline.toggleSnap"
        aria-pressed={snapping}
        onClick={() => store().toggleSnapping()}
      >
        <Magnet />
      </Button>
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {formatTime(playhead)} / {formatTime(duration)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Alejar"
        shortcut="timeline.zoomOut"
        onClick={() => store().zoomBy(1 / 1.25)}
      >
        <ZoomOut />
      </Button>
      <Range
        aria-label="Zoom"
        className="w-24"
        min={Math.log(MIN_ZOOM)}
        max={Math.log(MAX_ZOOM)}
        step={0.01}
        value={Math.log(zoom)}
        onChange={(e) => store().setZoom(Math.exp(Number(e.target.value)))}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Acercar"
        shortcut="timeline.zoomIn"
        onClick={() => store().zoomBy(1.25)}
      >
        <ZoomIn />
      </Button>
    </>
  );

  return (
    <Panel title="Línea de tiempo" toolbar={toolbar} bare>
      <Timeline />
    </Panel>
  );
}
