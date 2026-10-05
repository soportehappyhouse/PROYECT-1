"use client";

import { useMemo } from "react";
import { assetScenes, sceneMarkers, type SceneMarker, type ScenesLookup } from "@/lib/scenes";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { useScenesStore } from "@/stores/scenes-store";

/** Scenes of an asset: this session's analyze.scenes result, else `asset.scenes` from the api. */
export function scenesLookup(): ScenesLookup {
  const byAsset = useScenesStore.getState().byAsset;
  const assets = useMediaStore.getState().assets;
  return (id) => byAsset[id] ?? assetScenes(assets[id]);
}

/** Marker times to snap to (empty when the markers are hidden). */
export function sceneSnapTimes(): number[] {
  if (!useScenesStore.getState().visible) return [];
  return sceneMarkers(useProjectStore.getState().project, scenesLookup()).map((m) => m.time);
}

/** Visible scene markers of the project (timeline time). */
export function useSceneMarkers(): SceneMarker[] {
  const tracks = useProjectStore((s) => s.project.tracks);
  const byAsset = useScenesStore((s) => s.byAsset);
  const visible = useScenesStore((s) => s.visible);
  const assets = useMediaStore((s) => s.assets);
  return useMemo(
    () => (visible ? sceneMarkers({ tracks }, (id) => byAsset[id] ?? assetScenes(assets[id])) : []),
    [tracks, byAsset, visible, assets],
  );
}
