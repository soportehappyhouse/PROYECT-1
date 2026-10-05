"use client";

import type { TrackKind } from "@studio/shared";
import { Magnet, Plus, Redo2, Scissors, Trash2, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { Timeline } from "@/components/timeline/Timeline";
import { Button } from "@/components/ui/button";
import { Range } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { formatTime } from "@/lib/format";
import { projectDuration, TRACK_KIND_LABELS } from "@/lib/timeline";
import { MAX_ZOOM, MIN_ZOOM, useProjectStore } from "@/stores/project-store";
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
  const store = useProjectStore.getState;

  const toolbar = (
    <>
      <Menu
        label="Añadir pista"
        align="start"
        trigger={(p) => (
          <Button variant="ghost" size="xs" {...p}>
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
      <Button variant="ghost" size="xs" onClick={() => store().addTextClip()}>
        <Type /> Texto
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Deshacer"
        disabled={!canUndo}
        onClick={() => store().undo()}
      >
        <Undo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rehacer"
        disabled={!canRedo}
        onClick={() => store().redo()}
      >
        <Redo2 />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dividir en el cursor"
        onClick={() => store().splitAt()}
      >
        <Scissors />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Eliminar clip"
        disabled={!hasSelection}
        onClick={() => store().deleteClip()}
      >
        <Trash2 />
      </Button>
      <Button
        variant={snapping ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Imán (snapping)"
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
