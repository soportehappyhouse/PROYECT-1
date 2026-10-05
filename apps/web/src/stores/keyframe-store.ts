import { toast } from "sonner";
import { create } from "zustand";
import {
  addKeyframe,
  copyKeyframes,
  keyframeProps,
  keyframesOf,
  moveKeyframe,
  pasteKeyframes,
  removeKeyframe,
  updateKeyframe,
  valueAt,
  type ClipPatch,
  type KeyframeClipboard,
} from "@/lib/keyframes";
import { interpolate, sortKeyframes } from "@/lib/interpolate";
import { clipEnd, findClip } from "@/lib/timeline";
import {
  projectReframe,
  PROP_LABELS,
  type CropBox,
  type Ease,
  type Keyframe,
  type KeyframeProp,
} from "@/lib/vision-types";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useMediaStore } from "./media-store";
import { useProjectStore } from "./project-store";

/** Selected keyframe (inspector + timeline highlight). clipId "project" = reframe crop. */
export interface KeyframeSelection {
  clipId: string;
  prop: KeyframeProp;
  index: number;
}

export const REFRAME_OWNER = "project";

interface KeyframeState {
  /** Property `K` keys (and the inspector list shows). */
  activeProp: KeyframeProp;
  selected: KeyframeSelection | undefined;
  clipboard: KeyframeClipboard | undefined;
  setActiveProp: (prop: KeyframeProp) => void;
  select: (sel: KeyframeSelection | undefined) => void;
  /** K: keyframe of the active property at the playhead on the selected clip. */
  addAtPlayhead: (prop?: KeyframeProp, clipId?: string) => boolean;
  /** Drag gesture: call begin once (undo checkpoint), then move with record=false. */
  beginDrag: () => void;
  move: (clipId: string, prop: KeyframeProp, index: number, t: number, record?: boolean) => void;
  remove: (clipId: string, prop: KeyframeProp, index: number) => void;
  setEase: (clipId: string, prop: KeyframeProp, index: number, ease: Ease) => void;
  setValue: (clipId: string, prop: KeyframeProp, index: number, v: Keyframe["v"]) => void;
  setTime: (clipId: string, prop: KeyframeProp, index: number, t: number) => void;
  clearProp: (clipId: string, prop: KeyframeProp) => void;
  copy: (clipId: string, props?: KeyframeProp[]) => boolean;
  paste: (clipId: string) => boolean;
  // Reframe crop keyframes (project.reframe), same gestures.
  addReframeAtPlayhead: () => boolean;
  updateReframe: (index: number, change: Partial<Keyframe<CropBox>>) => void;
  removeReframe: (index: number) => void;
}

function clipCtx(clipId: string) {
  const store = useProjectStore.getState();
  const found = findClip(store.project, clipId);
  if (!found || found.track.locked) return undefined;
  return { store, ...found };
}

function apply(clipId: string, patch: ClipPatch, record = true): void {
  if (Object.keys(patch).length === 0) return;
  useProjectStore.getState().updateClip(clipId, patch, record);
}

export const useKeyframeStore = create<KeyframeState>()((set, get) => ({
  activeProp: "position",
  selected: undefined,
  clipboard: undefined,
  setActiveProp: (activeProp) => set({ activeProp }),
  select: (selected) => {
    if (selected && selected.clipId !== REFRAME_OWNER) set({ selected, activeProp: selected.prop });
    else set({ selected });
  },
  addAtPlayhead: (prop, clipId) => {
    const store = useProjectStore.getState();
    const id = clipId ?? store.selectedClipId;
    const ctx = id ? clipCtx(id) : undefined;
    if (!ctx) return false;
    const allowed = keyframeProps(ctx.track.kind);
    const p = prop ?? get().activeProp;
    const target = allowed.includes(p) ? p : allowed[0];
    if (!target) return false;
    const local = store.playhead - ctx.clip.start;
    if (local < -1e-3 || store.playhead > clipEnd(ctx.clip) + 1e-3) return false;
    const assetId =
      ctx.track.kind === "motion"
        ? (ctx.clip.renderedAssetId ?? ctx.clip.assetId)
        : ctx.clip.assetId;
    const v = valueAt(ctx.clip, target, ctx.track.kind, store.playhead, {
      canvas: { width: store.project.settings.width, height: store.project.settings.height },
      asset: assetId ? useMediaStore.getState().assets[assetId] : undefined,
    });
    const { patch, index } = addKeyframe(ctx.clip, target, local, v);
    addBreadcrumb("clip", `Keyframe de ${PROP_LABELS[target]} en ${store.playhead.toFixed(2)} s`, {
      clipId: ctx.clip.id,
      prop: target,
    });
    apply(ctx.clip.id, patch);
    set({ selected: { clipId: ctx.clip.id, prop: target, index }, activeProp: target });
    return true;
  },
  beginDrag: () => useProjectStore.getState().checkpoint(),
  move: (clipId, prop, index, t, record = true) => {
    const ctx = clipCtx(clipId);
    if (!ctx) return;
    const res = moveKeyframe(ctx.clip, prop, index, t);
    apply(clipId, res.patch, record);
    set({ selected: { clipId, prop, index: res.index } });
  },
  remove: (clipId, prop, index) => {
    const ctx = clipCtx(clipId);
    if (!ctx) return;
    apply(clipId, removeKeyframe(ctx.clip, prop, index));
    set({ selected: undefined });
  },
  setEase: (clipId, prop, index, ease) => {
    const ctx = clipCtx(clipId);
    if (ctx) apply(clipId, updateKeyframe(ctx.clip, prop, index, { ease }));
  },
  setValue: (clipId, prop, index, v) => {
    const ctx = clipCtx(clipId);
    if (ctx) apply(clipId, updateKeyframe(ctx.clip, prop, index, { v }));
  },
  setTime: (clipId, prop, index, t) => get().move(clipId, prop, index, t),
  clearProp: (clipId, prop) => {
    const ctx = clipCtx(clipId);
    if (!ctx || keyframesOf(ctx.clip, prop).length === 0) return;
    const list = keyframesOf(ctx.clip, prop);
    let patch: ClipPatch = {};
    for (let i = list.length - 1; i >= 0; i--)
      patch = removeKeyframe({ ...ctx.clip, ...patch } as typeof ctx.clip, prop, i);
    apply(clipId, patch);
    set({ selected: undefined });
  },
  copy: (clipId, props) => {
    // Copying also works on locked tracks.
    const found = findClip(useProjectStore.getState().project, clipId);
    if (!found) return false;
    const board = copyKeyframes(found.clip, props);
    if (!board) return false;
    set({ clipboard: board });
    return true;
  },
  paste: (clipId) => {
    const board = get().clipboard;
    const ctx = clipCtx(clipId);
    if (!board || !ctx) return false;
    const local = Math.max(0, ctx.store.playhead - ctx.clip.start);
    const patch = pasteKeyframes(ctx.clip, board, local, keyframeProps(ctx.track.kind));
    if (Object.keys(patch).length === 0) return false;
    apply(clipId, patch);
    return true;
  },
  addReframeAtPlayhead: () => {
    const store = useProjectStore.getState();
    const reframe = projectReframe(store.project);
    if (!reframe) return false;
    const t = Math.round(store.playhead * 1000) / 1000;
    const v = interpolate(reframe.keyframes, t) ?? { x: 0, y: 0, w: 1, h: 1 };
    const keyframes = sortKeyframes([
      ...reframe.keyframes.filter((k) => Math.abs(k.t - t) >= 1 / 120),
      { t, v, ease: "linear" as Ease },
    ]);
    store.setReframe({ ...reframe, keyframes, mode: "manual" });
    set({
      selected: {
        clipId: REFRAME_OWNER,
        prop: "crop",
        index: keyframes.findIndex((k) => k.t === t),
      },
    });
    return true;
  },
  updateReframe: (index, change) => {
    const store = useProjectStore.getState();
    const reframe = projectReframe(store.project);
    if (!reframe?.keyframes[index]) return;
    const keyframes = sortKeyframes(
      reframe.keyframes.map((k, i) => (i === index ? { ...k, ...change } : k)),
    );
    store.setReframe({ ...reframe, keyframes, mode: "manual" });
  },
  removeReframe: (index) => {
    const store = useProjectStore.getState();
    const reframe = projectReframe(store.project);
    if (!reframe) return;
    store.setReframe({
      ...reframe,
      keyframes: reframe.keyframes.filter((_, i) => i !== index),
      mode: "manual",
    });
    set({ selected: undefined });
  },
}));

/**
 * `K` (playback.pause): while playing it pauses (J/K/L); stopped with a clip selected it adds a
 * keyframe of the active property at the playhead. Returns true when it added one.
 */
export function keyOrPause(): boolean {
  const p = useProjectStore.getState();
  if (p.playing) {
    p.shuttleStop();
    return false;
  }
  if (!p.selectedClipId) {
    p.shuttleStop();
    return false;
  }
  const added = useKeyframeStore.getState().addAtPlayhead();
  if (!added) {
    p.shuttleStop();
    toast.message("Mové el cursor sobre el clip seleccionado para agregar un keyframe");
  }
  return added;
}
