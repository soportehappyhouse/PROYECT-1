"use client";

import { useEffect } from "react";
import { projectDuration } from "@/lib/timeline";
import { useProjectStore } from "@/stores/project-store";

/** Advances the playhead in real time while `playing` (the preview media follows it). */
export function usePlaybackClock(): void {
  const playing = useProjectStore((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const store = useProjectStore.getState();
      const dt = (now - last) / 1000;
      last = now;
      const end = projectDuration(store.project);
      const next = store.playhead + dt;
      if (end > 0 && next >= end) {
        store.setPlayhead(end);
        store.setPlaying(false);
        return;
      }
      store.setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}
