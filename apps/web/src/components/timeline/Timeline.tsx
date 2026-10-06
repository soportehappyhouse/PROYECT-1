"use client";

import { useDroppable } from "@dnd-kit/core";
import type { MediaAsset, Track } from "@studio/shared";
import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useSceneMarkers } from "@/hooks/use-scene-markers";
import { moveTrackBy, moveTrackTo, timelineRows } from "@/lib/layers";
import { projectDuration } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { ClipView } from "./ClipView";
import { Ruler } from "./Ruler";

export const HEADER_WIDTH = 224;
export const TRACK_HEIGHT = 56;

/** Data attached to every track lane so drops from the media panel know where they land. */
export interface TrackDropData {
  trackId: string;
  kind: Track["kind"];
  timeAt: (clientX: number) => number;
}

/** dataTransfer type of a dragged track header (Sprint 3b z-order). */
const TRACK_DRAG_TYPE = "application/x-studio-track";

/**
 * Sprint 3b: menu of a track header (right click or ⋮): layer order. Rows are the z-order: the
 * first row is the bottom layer, lower rows are drawn on top.
 */
function TrackLayerMenu({
  track,
  z,
  count,
  at,
  onClose,
}: {
  track: Track;
  z: number;
  count: number;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Capa de «${track.name}»`}
      className="fixed z-50 min-w-60 rounded-md border bg-card p-1 text-sm shadow-lg"
      style={{ left: at.x, top: at.y }}
    >
      <div className="px-2 py-1 text-xs text-muted-foreground">
        Capa {z + 1} de {count} · las pistas de más abajo se dibujan encima
      </div>
      <MenuItem disabled={z === 0} onSelect={run(() => moveTrackBy(track.id, -1))} hint="al fondo">
        <span className="inline-flex items-center gap-1.5">
          <ArrowUp className="size-3.5" /> Mover arriba
        </span>
      </MenuItem>
      <MenuItem
        disabled={z >= count - 1}
        onSelect={run(() => moveTrackBy(track.id, 1))}
        hint="al frente"
      >
        <span className="inline-flex items-center gap-1.5">
          <ArrowDown className="size-3.5" /> Mover abajo
        </span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={z >= count - 1} onSelect={run(() => moveTrackTo(track.id, count - 1))}>
        Traer al frente
      </MenuItem>
      <MenuItem disabled={z === 0} onSelect={run(() => moveTrackTo(track.id, 0))}>
        Enviar al fondo
      </MenuItem>
    </div>
  );
}

function TrackHeader({ track, z, count }: { track: Track; z: number; count: number }) {
  const updateTrack = useProjectStore((s) => s.updateTrack);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  const [dropOver, setDropOver] = useState(false);
  const closeMenu = useCallback(() => setMenu(undefined), []);
  return (
    <div
      data-track-header={track.id}
      data-z={z}
      className={cn(
        "sticky left-0 z-20 flex shrink-0 items-center gap-0.5 border-r border-b bg-card px-1",
        dropOver && "ring-2 ring-primary ring-inset",
      )}
      style={{ width: HEADER_WIDTH, height: TRACK_HEIGHT }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false);
        const id = e.dataTransfer.getData(TRACK_DRAG_TYPE);
        if (!id || id === track.id) return;
        e.preventDefault();
        moveTrackTo(id, z);
      }}
    >
      <span
        draggable
        role="button"
        tabIndex={-1}
        aria-label={`Arrastrar «${track.name}» para cambiar su capa`}
        title="Arrastrá para cambiar el orden de capas (más abajo = encima)"
        className="flex cursor-grab items-center text-muted-foreground active:cursor-grabbing"
        onDragStart={(e) => {
          e.dataTransfer.setData(TRACK_DRAG_TYPE, track.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <GripVertical className="size-3.5" />
      </span>
      <span
        data-testid="track-z"
        className="rounded bg-muted px-1 text-[10px] font-semibold tabular-nums text-muted-foreground"
        title={`Capa ${z + 1} de ${count} (1 = fondo; las pistas de más abajo se dibujan encima)`}
      >
        {z + 1}
      </span>
      <span className="flex-1 truncate text-xs font-medium" title={track.name}>
        {track.name}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Orden de capa"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        tooltip="Orden de capa: mover arriba / abajo"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu(menu ? undefined : { x: r.left, y: r.bottom + 2 });
        }}
      >
        <EllipsisVertical />
      </Button>
      {menu ? (
        <TrackLayerMenu track={track} z={z} count={count} at={menu} onClose={closeMenu} />
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={track.muted ? "Activar sonido" : "Silenciar"}
        aria-pressed={track.muted}
        onClick={() => updateTrack(track.id, { muted: !track.muted })}
      >
        {track.muted ? <VolumeX /> : <Volume2 />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={track.hidden ? "Mostrar pista" : "Ocultar pista"}
        aria-pressed={track.hidden}
        onClick={() => updateTrack(track.id, { hidden: !track.hidden })}
      >
        {track.hidden ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={track.locked ? "Desbloquear pista" : "Bloquear pista"}
        aria-pressed={track.locked}
        onClick={() => updateTrack(track.id, { locked: !track.locked })}
      >
        {track.locked ? <Lock /> : <Unlock />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Eliminar pista"
        disabled={track.clips.length > 0}
        title={track.clips.length > 0 ? "Vacía la pista para eliminarla" : "Eliminar pista"}
        onClick={() => removeTrack(track.id)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function TrackLane({
  track,
  width,
  zoom,
  assets,
  selectedClipId,
}: {
  track: Track;
  width: number;
  zoom: number;
  assets: Record<string, MediaAsset>;
  selectedClipId: string | undefined;
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const timeAt = useCallback(
    (clientX: number) => {
      const rect = laneRef.current?.getBoundingClientRect();
      return rect ? Math.max(0, (clientX - rect.left) / zoom) : 0;
    },
    [zoom],
  );
  const data: TrackDropData = { trackId: track.id, kind: track.kind, timeAt };
  const { setNodeRef, isOver } = useDroppable({ id: `track:${track.id}`, data });
  const setRefs = (el: HTMLDivElement | null) => {
    laneRef.current = el;
    setNodeRef(el);
  };
  return (
    <div
      ref={setRefs}
      data-track-id={track.id}
      data-track-kind={track.kind}
      className={cn(
        "relative shrink-0 border-b",
        track.locked &&
          "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,var(--muted)_6px,var(--muted)_8px)]",
        isOver && "bg-primary/10",
      )}
      style={{ width, height: TRACK_HEIGHT }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          useProjectStore.getState().selectClip(undefined);
          useProjectStore.getState().setPlayhead(timeAt(e.clientX));
        }
      }}
    >
      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          track={track}
          asset={clip.assetId ? assets[clip.assetId] : undefined}
          zoom={zoom}
          height={TRACK_HEIGHT}
          selected={clip.id === selectedClipId}
        />
      ))}
    </div>
  );
}

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const zoom = useProjectStore((s) => s.zoom);
  const playhead = useProjectStore((s) => s.playhead);
  const playing = useProjectStore((s) => s.playing);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const assets = useMediaStore((s) => s.assets);
  const markers = useSceneMarkers();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(800);

  const duration = Math.max(projectDuration(project) + 30, (viewportWidth - HEADER_WIDTH) / zoom);
  // Sprint 3b: rows in z-order (first row = bottom layer), like the export and the preview.
  const rows = timelineRows(project);
  const width = duration * zoom;

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const store = useProjectStore.getState();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - HEADER_WIDTH + el.scrollLeft;
      const time = x / store.zoom;
      store.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      el.scrollLeft =
        time * useProjectStore.getState().zoom - (e.clientX - rect.left - HEADER_WIDTH);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, []);

  // Keep the playhead visible while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = playhead * zoom;
    const visible = el.clientWidth - HEADER_WIDTH;
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [playhead, zoom, playing]);

  const seek = useCallback((t: number) => useProjectStore.getState().setPlayhead(t), []);

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto"
      data-testid="timeline-scroll"
    >
      <div className="relative" style={{ width: HEADER_WIDTH + width }}>
        <div className="sticky top-0 z-30 flex">
          <div
            className="sticky left-0 z-30 shrink-0 border-r border-b bg-card"
            style={{ width: HEADER_WIDTH }}
          />
          <Ruler zoom={zoom} duration={duration} onSeek={seek} markers={markers} />
        </div>
        {rows.map((track, z) => (
          <div key={track.id} className="flex">
            <TrackHeader track={track} z={z} count={rows.length} />
            <TrackLane
              track={track}
              width={width}
              zoom={zoom}
              assets={assets}
              selectedClipId={selectedClipId}
            />
          </div>
        ))}
        {markers.map((m) => (
          <div
            key={`${m.clipId}:${m.time}`}
            aria-hidden
            className="pointer-events-none absolute top-6 bottom-0 z-[5] w-0 border-l border-dashed border-amber-500/50"
            style={{ left: HEADER_WIDTH + m.time * zoom }}
          />
        ))}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 z-[25] w-px bg-primary"
          style={{ left: HEADER_WIDTH + playhead * zoom }}
        >
          <div className="absolute -top-0 -left-1.5 size-3 rotate-45 bg-primary" />
        </div>
        {project.tracks.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            No hay pistas. Añade una con los botones de la barra.
          </p>
        ) : null}
      </div>
    </div>
  );
}
