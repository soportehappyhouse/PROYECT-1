"use client";

import { useRef } from "react";
import { formatTime } from "@/lib/format";
import type { SceneMarker } from "@/lib/scenes";
import { isTextEditable } from "@/lib/shortcuts";
import type { InOutRange } from "@/stores/project-store";

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Tick spacing (seconds) so labels are at least `minPx` apart. */
export function rulerStep(zoom: number, minPx = 70): number {
  return STEPS.find((s) => s * zoom >= minPx) ?? STEPS[STEPS.length - 1]!;
}

/**
 * Sprint 5 (H5): clicking the ruler must not take the keyboard focus (react-hotkeys-hook treats
 * role=slider as a form field and S/Space/J/K/L/Supr stopped working). The focus goes to the
 * timeline (`role="application"`) unless it is already on one of its clips.
 */
export function keepTimelineFocus(from: HTMLElement | null): void {
  const app = from?.closest<HTMLElement>('[role="application"]');
  if (!app) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const insideApp = active instanceof HTMLElement && app.contains(active);
  if (!insideApp || isTextEditable(active) || active?.getAttribute("role") === "slider")
    app.focus({ preventScroll: true });
}

export function Ruler({
  zoom,
  duration,
  onSeek,
  markers = [],
  inOut,
  playhead = 0,
}: {
  zoom: number;
  duration: number;
  onSeek: (time: number) => void;
  /** Scene changes (analyze.scenes) drawn as amber flags. */
  markers?: readonly SceneMarker[];
  /** Sprint 5: I/O range marks. */
  inOut?: InOutRange;
  playhead?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const step = rulerStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const timeAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? Math.max(0, (clientX - rect.left) / zoom) : 0;
  };

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Regla de tiempo"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={playhead}
      aria-valuetext={formatTime(playhead)}
      tabIndex={-1}
      className="relative h-6 cursor-pointer select-none border-b bg-card"
      style={{ width: duration * zoom }}
      onPointerDown={(e) => {
        // H5: no focus for the ruler (keeps every shortcut alive).
        e.preventDefault();
        keepTimelineFocus(e.currentTarget);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) onSeek(timeAt(e.clientX));
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 h-full border-l border-border pl-1 text-[10px] leading-6 text-muted-foreground"
          style={{ left: t * zoom }}
        >
          {formatTime(t, step < 1 ? 1 : 0)}
        </div>
      ))}
      {inOut ? (
        <div
          data-testid="inout-ruler"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 border-x-2 border-primary bg-primary/25"
          style={{ left: inOut.in * zoom, width: Math.max(2, (inOut.out - inOut.in) * zoom) }}
        >
          <span className="absolute top-0 left-0.5 text-[9px] font-bold text-primary">I</span>
          <span className="absolute top-0 right-0.5 text-[9px] font-bold text-primary">O</span>
        </div>
      ) : null}
      {markers.map((m) => (
        <div
          key={`${m.clipId}:${m.time}`}
          data-testid="scene-marker"
          title={`Cambio de escena · ${formatTime(m.time)}`}
          className="pointer-events-none absolute bottom-0 h-3 w-0 border-l-2 border-amber-500"
          style={{ left: m.time * zoom }}
        >
          <span className="absolute -top-0.5 -left-[5px] size-2 rotate-45 bg-amber-500" />
        </div>
      ))}
    </div>
  );
}
