"use client";

import { useRef } from "react";
import { formatTime } from "@/lib/format";

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Tick spacing (seconds) so labels are at least `minPx` apart. */
export function rulerStep(zoom: number, minPx = 70): number {
  return STEPS.find((s) => s * zoom >= minPx) ?? STEPS[STEPS.length - 1]!;
}

export function Ruler({
  zoom,
  duration,
  onSeek,
}: {
  zoom: number;
  duration: number;
  onSeek: (time: number) => void;
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
      tabIndex={-1}
      className="relative h-6 cursor-pointer select-none border-b bg-card"
      style={{ width: duration * zoom }}
      onPointerDown={(e) => {
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
    </div>
  );
}
