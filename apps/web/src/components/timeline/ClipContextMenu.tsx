"use client";

import type { Clip, MediaAsset, Track } from "@studio/shared";
import { ScanFace, Undo2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { MenuItem } from "@/components/ui/menu";
import { canSwapFace, useFaceStore } from "@/stores/face-store";

/**
 * Right-click menu of a timeline clip (sprint 4 M1: «Cambiar cara…» on video clips and «Deshacer
 * cambio de cara» on swapped ones). Returns null when nothing applies to the clip.
 */
export function clipMenuHasItems(track: Track, clip: Clip, asset: MediaAsset | undefined): boolean {
  return !!clip.faceSwap || canSwapFace(track, asset);
}

export function ClipContextMenu({
  clip,
  track,
  asset,
  at,
  onClose,
}: {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Menú del clip"
      className="fixed z-50 min-w-56 rounded-md border bg-card p-1 text-sm text-card-foreground shadow-lg"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {canSwapFace(track, asset) && !clip.faceSwap ? (
        <MenuItem onSelect={run(() => void useFaceStore.getState().openWizard(clip.id))}>
          <span className="inline-flex items-center gap-1.5">
            <ScanFace className="size-3.5" /> Cambiar cara…
          </span>
        </MenuItem>
      ) : null}
      {clip.faceSwap ? (
        <MenuItem onSelect={run(() => void useFaceStore.getState().undo(clip.id))}>
          <span className="inline-flex items-center gap-1.5">
            <Undo2 className="size-3.5" /> Deshacer cambio de cara
          </span>
        </MenuItem>
      ) : null}
    </div>
  );
}
