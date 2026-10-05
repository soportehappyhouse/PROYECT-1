import { useProjectStore } from "@/stores/project-store";

let stopCurrent: (() => void) | undefined;

/**
 * Play `[start, end]` of the timeline in the Vista previa panel and pause at `end` («Escuchar» of
 * the cuts review). Any user action that pauses or seeks away ends it.
 */
export function playRange(start: number, end: number): void {
  stopCurrent?.();
  const store = useProjectStore.getState();
  store.setPlaying(false);
  store.setPlayhead(start);
  store.setPlaying(true);
  const unsubscribe = useProjectStore.subscribe((s) => {
    if (!s.playing) return stop();
    if (s.playhead >= end || s.playhead < start - 0.05) {
      stop();
      if (s.playing) useProjectStore.getState().setPlaying(false);
    }
  });
  function stop() {
    unsubscribe();
    if (stopCurrent === stop) stopCurrent = undefined;
  }
  stopCurrent = stop;
}
