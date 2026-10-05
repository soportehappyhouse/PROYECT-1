"use client";

import { useDroppable } from "@dnd-kit/core";
import type { MediaAsset, Track } from "@studio/shared";
import { Eye, EyeOff, Lock, Trash2, Unlock, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { projectDuration } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { ClipView } from "./ClipView";
import { Ruler } from "./Ruler";

export const HEADER_WIDTH = 184;
export const TRACK_HEIGHT = 56;

/** Data attached to every track lane so drops from the media panel know where they land. */
export interface TrackDropData {
  trackId: string;
  kind: Track["kind"];
  timeAt: (clientX: number) => number;
}

function TrackHeader({ track }: { track: Track }) {
  const updateTrack = useProjectStore((s) => s.updateTrack);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  return (
    <div
      className="sticky left-0 z-20 flex shrink-0 items-center gap-0.5 border-r border-b bg-card px-1.5"
      style={{ width: HEADER_WIDTH, height: TRACK_HEIGHT }}
    >
      <span className="flex-1 truncate text-xs font-medium" title={track.name}>
        {track.name}
      </span>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(800);

  const duration = Math.max(projectDuration(project) + 30, (viewportWidth - HEADER_WIDTH) / zoom);
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
          <Ruler zoom={zoom} duration={duration} onSeek={seek} />
        </div>
        {project.tracks.map((track) => (
          <div key={track.id} className="flex">
            <TrackHeader track={track} />
            <TrackLane
              track={track}
              width={width}
              zoom={zoom}
              assets={assets}
              selectedClipId={selectedClipId}
            />
          </div>
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
