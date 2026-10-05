"use client";

import type { Rect } from "@studio/shared";
import { useMemo, useRef, useState } from "react";
import {
  canvasToSource,
  composeAt,
  reframeCropAt,
  sourceToCanvas,
  type Layer,
} from "@/lib/compositor";
import { sourceTimeAt, findClip } from "@/lib/timeline";
import { cachedTrack } from "@/lib/vision-api";
import { frameAt, useMaskStore } from "@/stores/mask-store";
import { useMediaStore } from "@/stores/media-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

type Pt = { x: number; y: number };

/** Box from two corners (canvas px). */
function boxOf(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * SVG on top of the preview canvas, in project pixels (viewBox = canvas): selection outline,
 * safe-area guides, reframe crop (draft or applied), the SAM mask with its points, and the box
 * drawn for «Seguir objeto».
 */
export function PreviewOverlay() {
  const project = useProjectStore((s) => s.project);
  const playhead = useProjectStore((s) => s.playhead);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const assets = useMediaStore((s) => s.assets);
  const tool = usePreviewStore((s) => s.tool);
  const toolClipId = usePreviewStore((s) => s.toolClipId);
  const safeGuides = usePreviewStore((s) => s.safeGuides);
  const draft = usePreviewStore((s) => s.reframeDraft);
  const mask = useMaskStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ a: Pt; b: Pt } | undefined>(undefined);
  const { width: W, height: H } = project.settings;

  const comp = useMemo(
    () => composeAt({ project, assets, time: playhead, trackFile: cachedTrack }),
    [project, assets, playhead],
  );
  const layerOf = (id: string | undefined): Layer | undefined =>
    id ? comp.layers.find((l) => l.clipId === id) : undefined;
  const selected = layerOf(selectedClipId);
  const toolLayer = layerOf(toolClipId);
  const crop = reframeCropAt(project, playhead, draft);

  /** Pointer -> canvas px through the SVG transform. */
  const toCanvas = (e: React.PointerEvent | React.MouseEvent): Pt | undefined => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return undefined;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const toolClip = toolClipId ? findClip(project, toolClipId)?.clip : undefined;
  const onMaskClick = (e: React.MouseEvent, label: 1 | 0) => {
    e.preventDefault();
    const p = toCanvas(e);
    if (!p || !toolLayer || !toolClip) return;
    const src = canvasToSource(toolLayer, p);
    if (!src) return;
    const st = useMaskStore.getState();
    const frame = frameAt(sourceTimeAt(toolClip, playhead), st.fps, st.frames);
    void st.addPoint(frame, src.x, src.y, e.altKey ? 0 : label);
  };

  const interactive = tool !== "none" && !!toolLayer;
  const maskFrame =
    toolClip && mask.frame !== undefined
      ? frameAt(sourceTimeAt(toolClip, playhead), mask.fps, mask.frames) === mask.frame
      : false;
  const full = toolLayer ? sourceToCanvas(toolLayer, { x: 0, y: 0, w: 1, h: 1 }) : undefined;

  return (
    <svg
      ref={svgRef}
      data-testid="preview-overlay"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="absolute inset-0 size-full"
      style={{
        pointerEvents: interactive ? "auto" : "none",
        cursor: interactive ? "crosshair" : undefined,
      }}
      onClick={(e) => tool === "mask" && onMaskClick(e, mask.label)}
      onContextMenu={(e) => tool === "mask" && onMaskClick(e, 0)}
      onPointerDown={(e) => {
        if (tool !== "track-box") return;
        const p = toCanvas(e);
        if (!p) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setDrag({ a: p, b: p });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = toCanvas(e);
        if (p) setDrag({ ...drag, b: p });
      }}
      onPointerUp={() => {
        if (!drag || !toolLayer || !toolClipId) return setDrag(undefined);
        const r = boxOf(drag.a, drag.b);
        setDrag(undefined);
        if (r.width < 8 || r.height < 8) return;
        const a = canvasToSource(toolLayer, { x: r.x, y: r.y });
        const b = canvasToSource(toolLayer, { x: r.x + r.width, y: r.y + r.height });
        if (!a || !b) return;
        void useVisionStore
          .getState()
          .trackObject(toolClipId, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
      }}
    >
      {safeGuides ? (
        <g data-testid="safe-guides" fill="none" strokeWidth={Math.max(1, W / 960)}>
          <rect
            x={W * 0.05}
            y={H * 0.05}
            width={W * 0.9}
            height={H * 0.9}
            stroke="rgba(255,255,255,.45)"
            strokeDasharray="12 8"
          />
          <rect
            x={W * 0.1}
            y={H * 0.1}
            width={W * 0.8}
            height={H * 0.8}
            stroke="rgba(250,204,21,.6)"
            strokeDasharray="6 6"
          />
          <line
            x1={W / 2 - 20}
            x2={W / 2 + 20}
            y1={H / 2}
            y2={H / 2}
            stroke="rgba(255,255,255,.5)"
          />
          <line
            y1={H / 2 - 20}
            y2={H / 2 + 20}
            x1={W / 2}
            x2={W / 2}
            stroke="rgba(255,255,255,.5)"
          />
        </g>
      ) : null}

      {crop ? (
        <g data-testid="reframe-crop">
          <path
            fillRule="evenodd"
            fill="rgba(0,0,0,.55)"
            d={`M0 0H${W}V${H}H0Z M${crop.x * W} ${crop.y * H}h${crop.w * W}v${crop.h * H}h${-crop.w * W}Z`}
          />
          <rect
            x={crop.x * W}
            y={crop.y * H}
            width={crop.w * W}
            height={crop.h * H}
            fill="none"
            stroke={draft ? "#f59e0b" : "#22d3ee"}
            strokeWidth={Math.max(2, W / 480)}
          />
        </g>
      ) : null}

      {selected && tool === "none" && selected.kind !== "text" ? (
        <rect
          x={selected.rect.x}
          y={selected.rect.y}
          width={selected.rect.width}
          height={selected.rect.height}
          fill="none"
          stroke={selected.tracked ? "#a78bfa" : "rgba(255,255,255,.7)"}
          strokeDasharray="10 6"
          strokeWidth={Math.max(1, W / 960)}
        />
      ) : null}
      {selected?.kind === "text" && selected.text?.center ? (
        <circle
          cx={selected.text.center.x}
          cy={selected.text.center.y}
          r={Math.max(4, W / 240)}
          fill="none"
          stroke={selected.tracked ? "#a78bfa" : "rgba(255,255,255,.8)"}
          strokeWidth={2}
        />
      ) : null}

      {tool === "mask" && full && mask.maskUrl && maskFrame ? (
        <image
          data-testid="mask-overlay"
          href={mask.maskUrl}
          x={full.x}
          y={full.y}
          width={full.width}
          height={full.height}
          preserveAspectRatio="none"
          opacity={0.55}
          style={{ mixBlendMode: "screen", filter: "sepia(1) saturate(6) hue-rotate(80deg)" }}
        />
      ) : null}
      {tool === "mask" && toolLayer && maskFrame
        ? mask.points.map((p, i) => {
            const c = sourceToCanvas(toolLayer, { x: p.x, y: p.y, w: 0, h: 0 });
            const r = Math.max(6, W / 160);
            return (
              <g key={i}>
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={r}
                  fill={p.label ? "#22c55e" : "#ef4444"}
                  stroke="#fff"
                  strokeWidth={2}
                />
                <text
                  x={c.x}
                  y={c.y + r * 0.45}
                  textAnchor="middle"
                  fontSize={r * 1.4}
                  fill="#fff"
                  fontWeight={700}
                >
                  {p.label ? "+" : "−"}
                </text>
              </g>
            );
          })
        : null}
      {interactive && full ? (
        <rect
          x={full.x}
          y={full.y}
          width={full.width}
          height={full.height}
          fill="none"
          stroke="#a78bfa"
          strokeDasharray="4 4"
          strokeWidth={Math.max(1, W / 960)}
        />
      ) : null}
      {drag
        ? (() => {
            const r = boxOf(drag.a, drag.b);
            return (
              <rect
                data-testid="track-box"
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                fill="rgba(167,139,250,.15)"
                stroke="#a78bfa"
                strokeWidth={Math.max(2, W / 480)}
              />
            );
          })()
        : null}
    </svg>
  );
}
