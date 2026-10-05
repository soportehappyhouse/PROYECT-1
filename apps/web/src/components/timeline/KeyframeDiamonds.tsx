"use client";

import type { Clip, Track } from "@studio/shared";
import { useRef } from "react";
import { keyframesOf } from "@/lib/keyframes";
import { KEYFRAME_PROPS, PROP_COLORS, PROP_LABELS, type KeyframeProp } from "@/lib/vision-types";
import { useKeyframeStore } from "@/stores/keyframe-store";
import { useProjectStore } from "@/stores/project-store";

/** Height of the diamonds row at the bottom of a clip. */
export const DIAMOND_ROW = 12;
const DRAG_THRESHOLD_PX = 3;

/**
 * Keyframes of a clip as colored diamonds in one row (every property collapsed; color =
 * property). Click selects it and moves the playhead there; drag retimes it (one undo step).
 * UI idea from HeyGen HyperFrames `KeyframeDiamond.tsx` (Apache-2.0); code is ours.
 */
export function KeyframeDiamonds({
  clip,
  track,
  zoom,
}: {
  clip: Clip;
  track: Track;
  zoom: number;
}) {
  const selected = useKeyframeStore((s) =>
    s.selected?.clipId === clip.id ? s.selected : undefined,
  );
  const drag = useRef<{ x: number; t0: number; prop: KeyframeProp; started: boolean } | undefined>(
    undefined,
  );
  const items = KEYFRAME_PROPS.flatMap((prop) =>
    [...keyframesOf(clip, prop)].sort((a, b) => a.t - b.t).map((k, index) => ({ prop, index, k })),
  );
  if (items.length === 0) return null;

  return (
    <div
      aria-label="Keyframes"
      className="absolute inset-x-0 bottom-0 bg-black/30"
      style={{ height: DIAMOND_ROW }}
    >
      {items.map(({ prop, index, k }) => {
        const isSel = selected?.prop === prop && selected.index === index;
        return (
          <button
            key={`${prop}:${index}`}
            type="button"
            data-keyframe={prop}
            aria-label={`Keyframe de ${PROP_LABELS[prop]} en ${k.t.toFixed(2)} s`}
            aria-pressed={isSel}
            title={`${PROP_LABELS[prop]} · ${k.t.toFixed(2)} s · ${k.ease}`}
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize border border-black/60"
            style={{
              left: k.t * zoom,
              background: PROP_COLORS[prop],
              outline: isSel ? "2px solid white" : undefined,
              zIndex: isSel ? 2 : 1,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const p = useProjectStore.getState();
              p.selectClip(clip.id);
              useKeyframeStore.getState().select({ clipId: clip.id, prop, index });
              p.setPlayhead(clip.start + k.t);
              if (track.locked) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, t0: k.t, prop, started: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              if (!d.started) {
                if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
                d.started = true;
                useKeyframeStore.getState().beginDrag();
              }
              const kf = useKeyframeStore.getState();
              const idx = kf.selected?.clipId === clip.id ? kf.selected.index : index;
              const t = d.t0 + dx / useProjectStore.getState().zoom;
              kf.move(clip.id, d.prop, idx, t, false);
              useProjectStore.getState().setPlayhead(clip.start + Math.max(0, t));
            }}
            onPointerUp={() => {
              drag.current = undefined;
            }}
            onPointerCancel={() => {
              drag.current = undefined;
            }}
          />
        );
      })}
    </div>
  );
}
