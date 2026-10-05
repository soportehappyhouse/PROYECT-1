"use client";

import type { Clip, MediaAsset, Track } from "@studio/shared";
import { useMemo } from "react";
import { findClip } from "@/lib/timeline";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";

export interface SelectedClip {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
}

/** The selected clip, its track and asset (memoized; stable across unrelated renders). */
export function useSelectedClip(): SelectedClip | undefined {
  const project = useProjectStore((s) => s.project);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const assets = useMediaStore((s) => s.assets);
  return useMemo(() => {
    if (!selectedClipId) return undefined;
    const found = findClip(project, selectedClipId);
    if (!found) return undefined;
    return {
      clip: found.clip,
      track: found.track,
      asset: found.clip.assetId ? assets[found.clip.assetId] : undefined,
    };
  }, [project, selectedClipId, assets]);
}

/** True when the clip carries audio that the voice/subtitle tools can process. */
export function hasAudio(
  sel: SelectedClip | undefined,
): sel is SelectedClip & { clip: Clip & { assetId: string } } {
  if (!sel?.clip.assetId) return false;
  if (sel.asset) return sel.asset.kind === "audio" || sel.asset.kind === "video";
  return sel.track.kind === "audio" || sel.track.kind === "video";
}

export function SelectedClipHint({ sel, need }: { sel: SelectedClip | undefined; need: string }) {
  if (hasAudio(sel)) {
    return (
      <p className="rounded-md bg-muted px-2 py-1 text-xs">
        Clip seleccionado: <strong>{sel.asset?.name ?? sel.clip.assetId}</strong>
      </p>
    );
  }
  return <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{need}</p>;
}
