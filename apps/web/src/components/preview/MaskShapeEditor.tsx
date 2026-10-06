"use client";

import { maskShapeRect, type Clip, type ClipMaskShape } from "@studio/shared";
import { useRef } from "react";
import type { Layer } from "@/lib/compositor";
import { dragMaskShape, handlePoint, MASK_HANDLES, type MaskHandle } from "@/lib/layers";
import { useProjectStore } from "@/stores/project-store";

type Pt = { x: number; y: number };

const CURSORS: Record<MaskHandle, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/**
 * Sprint 3b: editor of a clip's shape mask on top of the preview (SVG in project pixels): drag
 * inside the shape to move it, drag the 8 handles to resize. One undo step per drag (checkpoint
 * on pointer down, live updates without history). Feather is drawn as a second dashed outline.
 */
export function MaskShapeEditor({
  layer,
  clip,
  shape,
  toCanvas,
  unit,
}: {
  layer: Layer;
  clip: Clip;
  shape: ClipMaskShape;
  toCanvas: (e: React.PointerEvent) => Pt | undefined;
  /** Stroke unit (project px per screen px, roughly). */
  unit: number;
}) {
  const drag = useRef<{ handle: MaskHandle; from: Pt; start: ClipMaskShape } | undefined>(
    undefined,
  );
  const r = maskShapeRect(layer.rect, shape);
  const feather = shape.feather * (layer.mask?.kind === "shape" ? layer.mask.featherScale : 1);
  const hs = Math.max(6, unit * 9);

  const down = (handle: MaskHandle) => (e: React.PointerEvent) => {
    const p = toCanvas(e);
    if (!p) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    useProjectStore.getState().checkpoint();
    drag.current = { handle, from: p, start: shape };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    if (!p) return;
    const next = dragMaskShape(d.start, d.handle, p.x - d.from.x, p.y - d.from.y, layer.rect);
    useProjectStore.getState().updateClip(clip.id, { maskRef: next }, false);
  };
  const up = () => {
    drag.current = undefined;
  };

  const outline = (inset: number, dash?: string) =>
    shape.shape === "ellipse" ? (
      <ellipse
        cx={r.x + r.width / 2}
        cy={r.y + r.height / 2}
        rx={Math.max(1, r.width / 2 + inset)}
        ry={Math.max(1, r.height / 2 + inset)}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={unit * 1.5}
        strokeDasharray={dash}
      />
    ) : (
      <rect
        x={r.x - inset}
        y={r.y - inset}
        width={Math.max(1, r.width + 2 * inset)}
        height={Math.max(1, r.height + 2 * inset)}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={unit * 1.5}
        strokeDasharray={dash}
      />
    );

  return (
    <g data-testid="mask-shape-editor" onPointerMove={move} onPointerUp={up}>
      {outline(0)}
      {feather > 1 ? outline(feather / 2, `${unit * 4} ${unit * 4}`) : null}
      {feather > 1 ? outline(-feather / 2, `${unit * 4} ${unit * 4}`) : null}
      <rect
        data-testid="mask-move"
        aria-label="Mover la máscara"
        x={r.x}
        y={r.y}
        width={Math.max(1, r.width)}
        height={Math.max(1, r.height)}
        fill="rgba(34,211,238,.08)"
        stroke="rgba(34,211,238,.5)"
        strokeDasharray={`${unit * 6} ${unit * 4}`}
        strokeWidth={unit}
        style={{ pointerEvents: "all", cursor: CURSORS.move }}
        onPointerDown={down("move")}
        onPointerMove={move}
        onPointerUp={up}
      >
        <title>Arrastrá para mover la máscara{shape.invert ? " (invertida)" : ""}</title>
      </rect>
      {MASK_HANDLES.map((h) => {
        const p = handlePoint(r, h);
        return (
          <rect
            key={h}
            data-testid={`mask-handle-${h}`}
            x={p.x - hs / 2}
            y={p.y - hs / 2}
            width={hs}
            height={hs}
            fill="#0e7490"
            stroke="#fff"
            strokeWidth={unit}
            style={{ pointerEvents: "all", cursor: CURSORS[h] }}
            onPointerDown={down(h)}
            onPointerMove={move}
            onPointerUp={up}
          >
            <title>Arrastrá para cambiar el tamaño</title>
          </rect>
        );
      })}
    </g>
  );
}
