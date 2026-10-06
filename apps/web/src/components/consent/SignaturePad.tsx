"use client";

import { Eraser } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";

export interface SignaturePadHandle {
  /** PNG of the signature, or undefined when nothing was drawn. */
  toBlob: () => Promise<Blob | undefined>;
  clear: () => void;
  isEmpty: () => boolean;
}

/** «Firma en pantalla»: the person signs with the mouse, pen or finger (white PNG, black ink). */
export function SignaturePad({
  ref,
  onChange,
  height = 140,
}: {
  ref?: Ref<SignaturePadHandle>;
  onChange?: (empty: boolean) => void;
  height?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | undefined>(undefined);
  const [empty, setEmpty] = useState(true);
  // The parent passes an inline callback: keep the latest in a ref so the canvas is only cleared
  // on mount and on «Borrar firma», never on a re-render.
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  const ctx = () => canvas.current?.getContext("2d") ?? null;
  const reset = useCallback(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    setEmpty(true);
    changed.current?.(true);
  }, []);

  useEffect(() => {
    reset();
  }, [reset]);

  useImperativeHandle(
    ref,
    () => ({
      clear: reset,
      isEmpty: () => empty,
      toBlob: () =>
        new Promise<Blob | undefined>((resolve) => {
          const c = canvas.current;
          if (!c || empty || typeof c.toBlob !== "function") return resolve(undefined);
          c.toBlob((b) => resolve(b ?? undefined), "image/png");
        }),
    }),
    [empty, reset],
  );

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * c.width,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvas}
        width={600}
        height={Math.round((600 * height) / 360)}
        aria-label="Recuadro para firmar"
        className="w-full touch-none rounded-md border bg-white"
        style={{ height }}
        onPointerDown={(e) => {
          drawing.current = true;
          last.current = point(e);
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const g = ctx();
          const p = point(e);
          if (g && last.current) {
            g.strokeStyle = "#111111";
            g.lineWidth = 3;
            g.lineCap = "round";
            g.beginPath();
            g.moveTo(last.current.x, last.current.y);
            g.lineTo(p.x, p.y);
            g.stroke();
            if (empty) {
              setEmpty(false);
              changed.current?.(false);
            }
          }
          last.current = p;
        }}
        onPointerUp={() => {
          drawing.current = false;
          last.current = undefined;
        }}
        onPointerLeave={() => {
          drawing.current = false;
          last.current = undefined;
        }}
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{empty ? "Firmá dentro del recuadro" : "Firma lista"}</span>
        <Button size="xs" variant="ghost" onClick={reset}>
          <Eraser /> Borrar firma
        </Button>
      </div>
    </div>
  );
}
