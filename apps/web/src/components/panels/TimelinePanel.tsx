"use client";

import type { TrackKind } from "@studio/shared";
import {
  AudioWaveform,
  ChevronDown,
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
import { useSettingsStore } from "@/stores/settings-store";
import { useScenesStore } from "@/stores/scenes-store";
import { useSilencesStore } from "@/stores/silences-store";
import { Panel } from "./Panel";

const KINDS: TrackKind[] = ["video", "audio", "text", "motion"];

export function TimelinePanel() {
  const zoom = useProjectStore((s) => s.zoom);
  const snap = useSettingsStore((s) => s.snap);
  const selectedCount = useProjectStore((s) => s.selectedClipIds.length);
  const inOut = useProjectStore((s) => s.inOut);
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
        tip="undo"
        disabled={!canUndo}
        onClick={() => store().undo()}
      >
        <Undo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rehacer"
        tip="redo"
        disabled={!canRedo}
        onClick={() => store().redo()}
      >
        <Redo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Cortar en el cursor"
        tip="split"
        onClick={() => store().splitAt()}
      >
        <Scissors />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Eliminar clip"
        tip="delete"
        disabled={!hasSelection}
        disabledReason="Elegí un clip primero"
        onClick={(e) => store().deleteSelected({ ripple: e.shiftKey })}
      >
        <Trash2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Quitar silencios y muletillas"
        tip="silences"
        disabled={!hasSelection}
        disabledReason="Elegí un clip con voz primero"
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
        variant={snap.enabled ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Imán (snapping)"
        tip="snap"
        aria-pressed={snap.enabled}
        onClick={() => useSettingsStore.getState().setSnap({ enabled: !snap.enabled })}
      >
        <Magnet />
      </Button>
      <Menu
        label="Opciones del imán"
        align="start"
        trigger={(p) => (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1 w-4"
            aria-label="Opciones del imán"
            tooltip="Elegir a qué se pega el imán: cursor, bordes de clips o marcas I/O"
            {...p}
          >
            <ChevronDown />
          </Button>
        )}
      >
        {() => (
          <>
            <MenuItem
              checked={snap.playhead}
              onSelect={() => useSettingsStore.getState().setSnap({ playhead: !snap.playhead })}
            >
              Pegar al cursor
            </MenuItem>
            <MenuItem
              checked={snap.clipEdges}
              onSelect={() => useSettingsStore.getState().setSnap({ clipEdges: !snap.clipEdges })}
            >
              Pegar a los bordes de los clips
            </MenuItem>
            <MenuItem
              checked={snap.inOut}
              onSelect={() => useSettingsStore.getState().setSnap({ inOut: !snap.inOut })}
            >
              Pegar a las marcas de entrada y salida (I/O)
            </MenuItem>
          </>
        )}
      </Menu>
      {selectedCount > 1 ? (
        <span
          data-testid="selection-count"
          className="rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary"
        >
          {selectedCount} clips elegidos
        </span>
      ) : null}
      {inOut ? (
        <button
          type="button"
          data-testid="inout-label"
          className="rounded bg-primary/15 px-1.5 text-[11px] text-primary hover:bg-primary/25"
          title="Rango I–O (Exportar puede usar solo este tramo). Clic para quitarlo (Alt+X)"
          onClick={() => store().clearInOut()}
        >
          I–O {formatTime(inOut.in)} → {formatTime(inOut.out)} ×
        </button>
      ) : null}
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {formatTime(playhead)} / {formatTime(duration)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Alejar"
        tip="zoomOut"
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
        tip="zoomIn"
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
