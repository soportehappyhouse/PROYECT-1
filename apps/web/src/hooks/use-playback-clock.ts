"use client";

import { useEffect } from "react";
import { masterClock } from "@/lib/master-clock";
import { projectDuration } from "@/lib/timeline";
import { useProjectStore } from "@/stores/project-store";

/**
 * Advances the playhead while `playing`, reading the preview's master clock (driven by the
 * bottom-most video when the multilayer preview runs; monotonic otherwise). A seek made while
 * playing (ruler click, frame step) re-bases the clock.
 */
export function usePlaybackClock(): void {
  const playing = useProjectStore((s) => s.playing);
  useEffect(() => {
    const start = useProjectStore.getState();
    if (!playing) {
      masterClock.pause(start.playhead);
      return;
    }
    masterClock.play(start.playhead, start.playbackRate);
    let lastSet = start.playhead;
    let rate = start.playbackRate;
    let raf = 0;
    const tick = () => {
      const store = useProjectStore.getState();
      if (Math.abs(store.playhead - lastSet) > 1e-3) masterClock.seek(store.playhead);
      if (store.playbackRate !== rate) {
        rate = store.playbackRate;
        masterClock.setRate(rate);
      }
      const end = projectDuration(store.project);
      const next = masterClock.now();
      if (next <= 0 && rate < 0) {
        store.setPlayhead(0);
        store.setPlaying(false);
        return;
      }
      if (end > 0 && next >= end) {
        store.setPlayhead(end);
        store.setPlaying(false);
        return;
      }
      store.setPlayhead(next);
      lastSet = useProjectStore.getState().playhead;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      masterClock.pause(useProjectStore.getState().playhead);
    };
  }, [playing]);
}
