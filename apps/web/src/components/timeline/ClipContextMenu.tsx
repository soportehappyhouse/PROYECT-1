"use client";

import type { Clip, MediaAsset, Track } from "@studio/shared";
import { BetweenHorizontalStart, ScanFace, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef } from "react";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { displayKeys } from "@/lib/shortcuts";
import { trackGaps } from "@/lib/timeline";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canSwapFace, useFaceStore } from "@/stores/face-store";

/**
 * Right-click menu of a timeline clip: Sprint 5 «Borrar», «Borrar y cerrar hueco» and «Cerrar
 * huecos de la pista» (always), Sprint 4 «Cambiar cara…» / «Deshacer cambio de cara».
 */
export function clipMenuHasItems(
  _track: Track,
  _clip: Clip,
  _asset: MediaAsset | undefined,
): boolean {
  return true;
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
  const keys = useSettingsStore((s) => s.shortcuts);
  const count = useProjectStore((s) =>
    s.selectedClipIds.includes(clip.id) ? s.selectedClipIds.length : 1,
  );
  const hint = (id: "timeline.delete" | "timeline.rippleDelete" | "timeline.closeGaps") =>
    keys[id] ? displayKeys(keys[id]) : undefined;
  const gaps = trackGaps(track).length;
  const n = count > 1 ? ` (${count} clips)` : "";
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Menú del clip"
      className="fixed z-50 min-w-56 rounded-md border bg-card p-1 text-sm text-card-foreground shadow-lg"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <MenuItem
        disabled={track.locked}
        hint={hint("timeline.delete")}
        onSelect={run(() => {
          useProjectStore.getState().deleteSelected();
        })}
      >
        <span className="inline-flex items-center gap-1.5">
          <Trash2 className="size-3.5" /> Borrar{n}
        </span>
      </MenuItem>
      <MenuItem
        disabled={track.locked}
        hint={hint("timeline.rippleDelete")}
        onSelect={run(() => {
          useProjectStore.getState().deleteSelected({ ripple: true });
        })}
      >
        Borrar y cerrar hueco{n}
      </MenuItem>
      <MenuItem
        disabled={track.locked || gaps === 0}
        hint={hint("timeline.closeGaps")}
        onSelect={run(() => {
          const secs = useProjectStore.getState().closeGaps(track.id);
          if (secs > 0) toast.message(`Huecos cerrados (${secs.toFixed(2)} s)`);
        })}
      >
        <span className="inline-flex items-center gap-1.5">
          <BetweenHorizontalStart className="size-3.5" /> Cerrar huecos de la pista
          {gaps ? ` (${gaps})` : ""}
        </span>
      </MenuItem>
      {canSwapFace(track, asset) || clip.faceSwap ? <MenuSeparator /> : null}
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
