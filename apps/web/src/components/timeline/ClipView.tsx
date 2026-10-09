"use client";

import type { Clip, MediaAsset, Track } from "@studio/shared";
import { useCallback, useRef, useState } from "react";
import { sceneSnapTimes } from "@/hooks/use-scene-markers";
import { BLEND_MODE_LABELS, layerSummary } from "@/lib/layers";
import { fileUrl } from "@/lib/api";
import { clipDuration, clipEnd, snapClipStart, snapTime } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useKeyframeStore } from "@/stores/keyframe-store";
import { useSettingsStore, type SnapSettings } from "@/stores/settings-store";
import { ClipContextMenu, clipMenuHasItems } from "./ClipContextMenu";
import { KeyframeDiamonds } from "./KeyframeDiamonds";
import { Waveform } from "./Waveform";

export const TRACK_COLORS: Record<Track["kind"], string> = {
  video: "bg-sky-600/80 border-sky-400",
  audio: "bg-emerald-600/80 border-emerald-400",
  text: "bg-amber-600/80 border-amber-400",
  motion: "bg-fuchsia-600/80 border-fuchsia-400",
};

const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;

type Gesture = {
  mode: "move" | "trim-start" | "trim-end";
  pointerX: number;
  originStart: number;
  originEnd: number;
  started: boolean;
  /** Sprint 5: starts of every selected clip when the drag moves a multi-selection. */
  group?: Record<string, number>;
  /** A plain click on a clip of a multi-selection selects only it on release (no drag). */
  collapseOnClick?: boolean;
};

/**
 * Sprint 5: snap points allowed by the magnet menu (cursor, clip edges, I/O marks) + 0. Clips in
 * `exclude` (the ones being dragged) do not attract.
 */
export function magnetPoints(
  tracks: readonly Track[],
  exclude: ReadonlySet<string>,
  playhead: number,
  snap: SnapSettings,
  inOut?: { in: number; out: number },
): number[] {
  const points = new Set<number>([0]);
  if (snap.playhead) points.add(playhead);
  if (snap.inOut && inOut) {
    points.add(inOut.in);
    points.add(inOut.out);
  }
  if (snap.clipEdges)
    for (const t of tracks)
      for (const c of t.clips) {
        if (exclude.has(c.id)) continue;
        points.add(c.start);
        points.add(clipEnd(c));
      }
  return [...points];
}

export function clipLabel(clip: Clip, asset: MediaAsset | undefined): string {
  if (clip.text !== undefined) return clip.text || "Texto";
  if (clip.motion) return `Motion · ${clip.motion.template}`;
  return asset?.name ?? "Clip sin medio";
}

export function ClipView({
  clip,
  track,
  asset,
  zoom,
  height,
  selected,
}: {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
  zoom: number;
  height: number;
  selected: boolean;
}) {
  const gesture = useRef<Gesture | undefined>(undefined);
  // Sprint 4 M1: right-click menu («Cambiar cara…» / «Deshacer cambio de cara»).
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const duration = clipDuration(clip);
  const width = Math.max(2, duration * zoom);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, mode: Gesture["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const store = useProjectStore.getState();
    // Sprint 5 (H10): Ctrl+click toggles, Shift+click adds the range on the track; a plain click
    // on a clip that is already part of a multi-selection keeps it (to drag them together).
    const toggle = e.ctrlKey || e.metaKey;
    const inGroup = store.selectedClipIds.length > 1 && store.selectedClipIds.includes(clip.id);
    if (toggle) store.selectClip(clip.id, "toggle");
    else if (e.shiftKey) store.selectClip(clip.id, "range");
    else if (!inGroup) store.selectClip(clip.id);
    const after = useProjectStore.getState();
    const group =
      mode === "move" && after.selectedClipIds.length > 1 && after.selectedClipIds.includes(clip.id)
        ? Object.fromEntries(
            after.selectedClipIds.map((id) => {
              for (const t of after.project.tracks) {
                const c = t.clips.find((x) => x.id === id);
                if (c) return [id, c.start];
              }
              return [id, 0];
            }),
          )
        : undefined;
    // A click on the clip body drops the keyframe selection (Supr deletes the clip again).
    if (useKeyframeStore.getState().selected) useKeyframeStore.getState().select(undefined);
    if (track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      mode,
      pointerX: e.clientX,
      originStart: clip.start,
      originEnd: clipEnd(clip),
      started: false,
      ...(group ? { group } : {}),
      collapseOnClick: inGroup && !toggle && !e.shiftKey,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.pointerX;
    if (!g.started) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      g.started = true;
      useProjectStore.getState().checkpoint();
    }
    const store = useProjectStore.getState();
    const snap = useSettingsStore.getState().snap;
    const dt = dx / store.zoom;
    const threshold = SNAP_PX / store.zoom;
    // Scene markers (when shown) are snap points too.
    const exclude = new Set(g.group ? Object.keys(g.group) : [clip.id]);
    const points = snap.enabled
      ? [
          ...magnetPoints(store.project.tracks, exclude, store.playhead, snap, store.inOut),
          ...sceneSnapTimes(),
        ]
      : [];
    if (g.mode === "move" && g.group) {
      let start = Math.max(0, g.originStart + dt);
      if (snap.enabled) start = Math.max(0, snapClipStart(start, duration, points, threshold));
      store.moveSelected(start - g.originStart, false, g.group);
    } else if (g.mode === "move") {
      let start = Math.max(0, g.originStart + dt);
      if (snap.enabled) start = Math.max(0, snapClipStart(start, duration, points, threshold));
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-track-id]");
      const trackId = target?.dataset.trackKind === track.kind ? target.dataset.trackId : undefined;
      store.moveClip(clip.id, start, trackId, false);
    } else if (g.mode === "trim-start") {
      let t = g.originStart + dt;
      if (snap.enabled) t = snapTime(t, points, threshold);
      store.trimClip(clip.id, "start", t, undefined, false);
    } else {
      let t = g.originEnd + dt;
      if (snap.enabled) t = snapTime(t, points, threshold);
      store.trimClip(clip.id, "end", t, asset?.durationSec, false);
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = undefined;
    if (g && !g.started && g.collapseOnClick) useProjectStore.getState().selectClip(clip.id);
  };

  const thumb =
    track.kind === "video" && asset?.thumbnailPath ? fileUrl(asset.thumbnailPath) : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Clip ${clipLabel(clip, asset)}`}
      aria-pressed={selected}
      data-clip-id={clip.id}
      className={cn(
        "group absolute top-1 cursor-grab overflow-hidden rounded border text-[11px] text-white shadow-sm active:cursor-grabbing",
        TRACK_COLORS[track.kind],
        selected && "ring-2 ring-white ring-offset-1 ring-offset-primary",
        track.hidden && "opacity-40",
      )}
      style={{
        left: clip.start * zoom,
        width,
        height: height - 8,
        ...(thumb
          ? {
              backgroundImage: `url("${thumb}")`,
              backgroundSize: "auto 100%",
              backgroundRepeat: "repeat-x",
            }
          : {}),
      }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => {
        if (!clipMenuHasItems(track, clip, asset)) return;
        e.preventDefault();
        e.stopPropagation();
        // Right click on a clip of the selection keeps the selection (batch actions).
        if (!useProjectStore.getState().selectedClipIds.includes(clip.id))
          useProjectStore.getState().selectClip(clip.id);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter")
          useProjectStore
            .getState()
            .selectClip(
              clip.id,
              e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "replace",
            );
      }}
    >
      {track.kind === "audio" && asset ? (
        <Waveform
          asset={asset}
          inSec={clip.in}
          outSec={clip.out}
          height={height - 22}
          color="#ffffff"
        />
      ) : null}
      <div className="pointer-events-none relative truncate bg-black/25 px-1.5 py-0.5 font-medium">
        {clipLabel(clip, asset)}
        {clip.speed !== 1 ? <span className="ml-1 opacity-80">{clip.speed}×</span> : null}
        {clip.voiceEffects.length > 0 ? <span className="ml-1 opacity-80">FX</span> : null}
        {clip.matte ? <span className="ml-1 opacity-80">Recorte</span> : null}
        {clip.trackRef ? <span className="ml-1 opacity-80">Sigue</span> : null}
        {clip.faceSwap ? (
          <span className="ml-1 opacity-80" title="Cara cambiada con IA">
            IA cara
          </span>
        ) : null}
        {clip.blendMode || clip.maskRef ? (
          <span className="ml-1 opacity-80" title={layerSummary(clip)}>
            {clip.blendMode && clip.blendMode !== "normal" ? BLEND_MODE_LABELS[clip.blendMode] : ""}
            {clip.blendMode && clip.blendMode !== "normal" && clip.maskRef ? " · " : ""}
            {clip.maskRef ? "Máscara" : ""}
          </span>
        ) : null}
      </div>
      <KeyframeDiamonds clip={clip} track={track} zoom={zoom} />
      {menu ? (
        <ClipContextMenu clip={clip} track={track} asset={asset} at={menu} onClose={closeMenu} />
      ) : null}
      {!track.locked ? (
        <>
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
            onPointerDown={(e) => onPointerDown(e, "trim-start")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
            onPointerDown={(e) => onPointerDown(e, "trim-end")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </>
      ) : null}
    </div>
  );
}
