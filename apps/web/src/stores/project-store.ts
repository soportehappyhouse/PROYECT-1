import {
  autoProjectName,
  PROJECT_NAME_MAX,
  ProjectSchema,
  UNTITLED_PROJECT_NAME,
  type Clip,
  type MediaAsset,
  type Project,
  type CaptionStyle,
  type SubtitleSegment,
  type Track,
  type TrackKind,
} from "@studio/shared";
import { create } from "zustand";
import { clamp, roundTime } from "@/lib/format";
import { createId } from "@/lib/ids";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";
import {
  clipEnd,
  clipRange,
  closeGaps as closeTrackGaps,
  rippleDelete as rippleDeleteClips,
  rippleTime,
  trimToCursor as trimClipToCursor,
  type TimeRange,
  createClipFromAsset,
  createTextClip,
  createTrack,
  findClip,
  firstFreeStart,
  insertClip,
  moveClip,
  nearestFreeStart,
  NO_OVERLAP_KINDS,
  overlapsOnTrack,
  projectDuration,
  removeClip,
  replaceClip,
  sortClips,
  splitClip,
  trackKindForAsset,
  trimClipEnd,
  trimClipStart,
  trimLimits,
} from "@/lib/timeline";
import type { PublishSettings } from "@/lib/ai-types";
import { keepRanges } from "@/lib/cuts";
import { nextPublish, projectPublish, type ProjectWithPublish } from "@/lib/publish";
import { splitClipAtTimes } from "@/lib/scenes";
import { cutClip, speechRanges } from "@/lib/silences";
import { projectReframe, type ReframeSettings } from "@/lib/vision-types";
import { addBreadcrumb } from "./breadcrumbs-store";

/** The undoable part of a project (Sprint 2: + project.reframe). */
interface Snapshot {
  tracks: Track[];
  subtitles: SubtitleSegment[];
  reframe: ReframeSettings | undefined;
  /** Sprint 5: only in the step that renamed/fitted the canvas on the first video (undoable). */
  name?: string;
  settings?: Project["settings"];
}

const HISTORY_LIMIT = 100;
export const MIN_ZOOM = 5; // px per second
export const MAX_ZOOM = 800;

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "local" | "error";

/** Sprint 5: how a click changes the clip selection (Ctrl+click toggles, Shift+click = range). */
export type SelectMode = "replace" | "toggle" | "range";

/** Sprint 5: I/O range marks (not saved in the project; Export reads them). */
export interface InOutRange {
  in: number;
  out: number;
}

export interface ProjectState {
  project: Project;
  /** Primary selected clip (last of `selectedClipIds`), kept for the panels that edit one clip. */
  selectedClipId: string | undefined;
  /** Sprint 5: every selected clip (the last one is the primary). */
  selectedClipIds: string[];
  /** Sprint 5: I/O marks (I sets `in`, O sets `out`); undefined = none. */
  inOut: InOutRange | undefined;
  /** Sprint 5: what the last first-video import changed (name/canvas), for the «Deshacer» toast. */
  firstVideoAdjust: { name?: string; canvas?: { width: number; height: number } } | undefined;
  selectedAssetId: string | undefined;
  playhead: number;
  playing: boolean;
  /** J/K/L shuttle speed (±1, ±2, ±4; negative = backwards); the clock and the preview follow it. */
  playbackRate: number;
  /** Timeline zoom in pixels per second. */
  zoom: number;
  past: Snapshot[];
  future: Snapshot[];
  saveState: SaveState;

  // --- project
  loadProject: (project: Project) => void;
  newProject: (name?: string) => void;
  renameProject: (name: string) => void;
  updateProjectSettings: (patch: Partial<Project["settings"]>) => void;
  setSaveState: (state: SaveState) => void;

  // --- history
  /** Push the current state to the undo stack (call once at the start of a drag gesture). */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  // --- tracks
  addTrack: (kind: TrackKind) => string;
  updateTrack: (trackId: string, patch: Partial<Omit<Track, "id" | "clips">>) => void;
  removeTrack: (trackId: string) => void;

  // --- clips (record=false skips the undo snapshot, for continuous gestures)
  addAssetClip: (asset: MediaAsset, opts?: { trackId?: string; start?: number }) => Clip;
  addTextClip: (opts?: { trackId?: string; start?: number; text?: string }) => Clip;
  addClip: (kind: TrackKind, clip: Omit<Clip, "trackId">, trackId?: string) => Clip;
  moveClip: (clipId: string, start: number, trackId?: string, record?: boolean) => void;
  trimClip: (
    clipId: string,
    edge: "start" | "end",
    time: number,
    maxSourceDuration?: number,
    record?: boolean,
  ) => void;
  splitAt: (time?: number, clipId?: string) => boolean;
  deleteClip: (clipId?: string) => void;
  /** Feedback 10: cut pauses > minGapSec out of a clip (ripple on its track + subtitles). */
  removeSilences: (clipId: string, minGapSec: number) => number;
  /**
   * Sprint 1: remove reviewed cuts (timeline time) from a clip locally, with ripple and subtitle
   * remap (fallback when the api has no timeline.apply-cuts). Returns the seconds removed.
   */
  applyCutsLocally: (clipId: string, cuts: readonly { start: number; end: number }[]) => number;
  /** Sprint 2 «Reencuadrar»: project.reframe (undefined = off); one undo step unless record=false. */
  setReframe: (reframe: ReframeSettings | undefined, record?: boolean) => void;
  /**
   * Sprint 3: adopt the whole project saved by the api (agent.apply / its undo) as one local
   * undo step (tracks, subtitles and reframe are undoable; settings/publish follow the api).
   */
  adoptServerProject: (remote: Project, label: string) => void;
  /** Adopt tracks + subtitles edited by the api (timeline.apply-cuts) as one undo step. */
  applyServerEdit: (remote: Pick<Project, "tracks" | "subtitles">, label: string) => void;
  /** «Cortar en escenas»: split one clip at several times (one undo step); returns new pieces. */
  splitAtTimes: (clipId: string, times: readonly number[]) => number;
  /** Feedback 11: remove every clip using an asset (assetId or renderedAssetId); returns how many. */
  removeClipsUsingAsset: (assetId: string) => number;
  updateClip: (
    clipId: string,
    patch: Partial<Omit<Clip, "id" | "trackId">>,
    record?: boolean,
  ) => void;

  // --- subtitles
  setSubtitles: (segments: SubtitleSegment[]) => void;
  /** Style used by the api to burn subtitles on export (Project.captionStyle). */
  setCaptionStyle: (style: CaptionStyle) => void;
  /** "Quemar subtítulos" (Export panel); the preview follows it too. */
  setBurnSubtitles: (burn: boolean) => void;
  /** «Revisión para redes» (project.publish); not part of undo. */
  setPublish: (patch: Parameters<typeof nextPublish>[1]) => void;
  updateSubtitle: (index: number, patch: Partial<SubtitleSegment>) => void;
  removeSubtitle: (index: number) => void;
  addSubtitle: (segment?: SubtitleSegment) => void;

  // --- Sprint 5: multi-selection, ripple, Q/W, I/O
  /** Select several clips at once (rectangle); `additive` keeps the current selection. */
  selectClips: (ids: readonly string[], additive?: boolean) => void;
  /** Ctrl+A: every clip of the unlocked tracks. */
  selectAll: () => void;
  /** Delete the selected clips (one undo step); `ripple` closes the holes on their tracks. */
  deleteSelected: (opts?: { ripple?: boolean }) => number;
  /** Shift+Supr for explicit ids (context menu). */
  rippleDelete: (ids: readonly string[]) => number;
  /** Move the selected clips by `delta` seconds (from `origins` while dragging). */
  moveSelected: (
    delta: number,
    record?: boolean,
    origins?: Readonly<Record<string, number>>,
  ) => boolean;
  /** «Cerrar huecos de la pista» (default: the track of the primary selected clip). */
  closeGaps: (trackId?: string) => number;
  /** Q / W: trim the start/end of the clip under the cursor to the cursor, with ripple. */
  trimToCursor: (edge: "start" | "end") => boolean;
  /** Same patch on several clips (speed/volume in batch), one undo step. */
  updateClips: (ids: readonly string[], patch: Partial<Omit<Clip, "id" | "trackId">>) => void;
  markIn: (time?: number) => void;
  markOut: (time?: number) => void;
  clearInOut: () => void;

  // --- selection / transport
  /** Select a clip (`mode`: replace, Ctrl+click toggle, Shift+click range on its track). */
  selectClip: (clipId: string | undefined, mode?: SelectMode) => void;
  selectAsset: (assetId: string | undefined) => void;
  setPlayhead: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  /** L: play forward (again = faster, up to 4×). */
  shuttleForward: () => void;
  /** J: play backwards (again = faster, up to 4×). */
  shuttleBackward: () => void;
  /** K: pause and reset the shuttle speed. */
  shuttleStop: () => void;
  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
}

/** Selection state for one primary clip (or none). */
function single(id: string | undefined): Pick<ProjectState, "selectedClipId" | "selectedClipIds"> {
  return { selectedClipId: id, selectedClipIds: id ? [id] : [] };
}

/** Selection state for several clips (the last one is the primary). */
function many(ids: readonly string[]): Pick<ProjectState, "selectedClipId" | "selectedClipIds"> {
  // Dedupe keeping the last occurrence (the clicked clip becomes the primary).
  const unique = [...new Set([...ids].reverse())].reverse();
  return { selectedClipId: unique[unique.length - 1], selectedClipIds: unique };
}

/** Subtitles after cutting `removed` (merged) ranges out of the main video track. */
export function rippleSubtitles(
  subtitles: readonly SubtitleSegment[],
  removed: readonly TimeRange[],
): SubtitleSegment[] {
  if (removed.length === 0) return [...subtitles];
  const out: SubtitleSegment[] = [];
  for (const s of subtitles) {
    const start = rippleTime(s.start, removed);
    const end = rippleTime(s.end, removed);
    if (end - start < 0.05) continue;
    const words = s.words?.map((w) => ({
      ...w,
      start: rippleTime(w.start, removed),
      end: rippleTime(w.end, removed),
    }));
    out.push({ ...s, start, end, ...(words && { words }) });
  }
  return out;
}

/** The main video track (first video track): its ripple also moves the subtitles. */
function mainVideoTrackId(p: Pick<Project, "tracks">): string | undefined {
  return p.tracks.find((t) => t.kind === "video")?.id;
}

/** Canvas of a new project. */
export const DEFAULT_CANVAS = { width: 1920, height: 1080 } as const;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Canvas for a video (same rule as lib/canvas-fit `canvasForVideo`, kept here to avoid an import
 * cycle): its aspect, short side at least 1080 px, never above 4K.
 */
export function canvasSizeForVideo(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const short = Math.min(size.width, size.height);
  const k = Math.min(Math.max(1, 1080 / short), 3840 / Math.max(size.width, size.height));
  return { width: even(size.width * k), height: even(size.height * k) };
}

export function createEmptyProject(name = UNTITLED_PROJECT_NAME): Project {
  const now = new Date().toISOString();
  const kinds: TrackKind[] = ["video", "audio", "text", "motion"];
  const tracks: Track[] = [];
  for (const k of kinds) tracks.push(createTrack(k, tracks));
  return {
    id: createId("prj"),
    name,
    settings: { ...DEFAULT_CANVAS, fps: 30, sampleRate: 48_000 },
    tracks,
    subtitles: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Restore the last project from localStorage (validated), or a fresh one. */
export function loadLocalProject(): Project {
  const raw = readJson(STORAGE_KEYS.project);
  const result = ProjectSchema.safeParse(raw);
  if (!result.success) return createEmptyProject();
  const parsed = result.data;
  // Keep `publish` even while the shared schema does not list it (zod strips unknown keys).
  const publish = (raw as { publish?: unknown }).publish;
  return publish && !("publish" in parsed)
    ? ({
        ...parsed,
        publish: projectPublish({ ...parsed, publish } as Project),
      } as Project)
    : parsed;
}

export function persistLocalProject(project: Project): void {
  writeJson(STORAGE_KEYS.project, project);
}

function snapshot(p: Project, meta = false): Snapshot {
  return {
    tracks: p.tracks,
    subtitles: p.subtitles,
    reframe: projectReframe(p),
    ...(meta ? { name: p.name, settings: p.settings } : {}),
  };
}

/** Whether a snapshot also carries name/settings (its counterpart must carry them too). */
const hasMeta = (s: Snapshot | undefined) => !!s && (s.name !== undefined || !!s.settings);

export const useProjectStore = create<ProjectState>()((set, get) => {
  /** Apply a change to the project, optionally recording an undo snapshot. */
  const commit = (
    mutate: (
      p: Project,
    ) => Partial<
      Pick<Project, "tracks" | "subtitles" | "settings" | "name" | "captionStyle" | "burnSubtitles">
    >,
    record = true,
  ) => {
    const { project, past } = get();
    const patch = mutate(project);
    const next: Project = { ...project, ...patch, updatedAt: new Date().toISOString() };
    set({
      project: next,
      saveState: "dirty",
      ...(record ? { past: [...past, snapshot(project)].slice(-HISTORY_LIMIT), future: [] } : {}),
    });
  };

  /** Drop selected ids whose clip no longer exists. */
  const pruneSelection = () => {
    const { selectedClipIds, project } = get();
    const alive = selectedClipIds.filter((id) => findClip(project, id));
    if (alive.length !== selectedClipIds.length || get().selectedClipId !== alive[alive.length - 1])
      set(many(alive));
  };

  const ensureTrack = (kind: TrackKind, trackId?: string): string => {
    const { project } = get();
    const wanted = trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
    if (wanted && wanted.kind === kind && !wanted.locked) return wanted.id;
    const existing = project.tracks.find((t) => t.kind === kind && !t.locked);
    if (existing) return existing.id;
    const track = createTrack(kind, project.tracks);
    set({ project: { ...project, tracks: [...project.tracks, track] } });
    return track.id;
  };

  /**
   * Feedback 5: a clip dropped onto an occupied range of a video/audio/motion track goes to
   * another track of the same kind that is free there, or to a new one ("Motion 2").
   */
  const freeTrackFor = (kind: TrackKind, trackId: string, start: number, duration: number) => {
    if (!NO_OVERLAP_KINDS.includes(kind)) return trackId;
    const tracks = get().project.tracks;
    const wanted = tracks.find((t) => t.id === trackId);
    if (wanted && !overlapsOnTrack(wanted, start, duration)) return trackId;
    const other = tracks.find(
      (t) => t.kind === kind && !t.locked && !overlapsOnTrack(t, start, duration),
    );
    if (other) return other.id;
    const track = createTrack(kind, tracks);
    const { project } = get();
    set({ project: { ...project, tracks: [...project.tracks, track] } });
    addBreadcrumb("track", `Creó «${track.name}» para no solapar clips`, { trackId: track.id });
    return track.id;
  };

  /**
   * Keep only `ranges` (timeline time) of a clip: pieces packed from clip.start, later clips on
   * its track shifted left, subtitles remapped (feedback 10 + Sprint 1 reviewed cuts).
   */
  const rippleKeep = (
    clipId: string,
    ranges: readonly { start: number; end: number }[],
    label: string,
  ): number => {
    const found = findClip(get().project, clipId);
    if (!found || found.track.locked || ranges.length === 0) return 0;
    const { clip, track } = found;
    const end = clipEnd(clip);
    const { pieces, removed, map, snap } = cutClip(clip, ranges);
    if (pieces.length === 0 || removed < 0.05) return 0;
    const shift = (c: Clip) =>
      c.start >= end - 1e-3 ? { ...c, start: roundTime(c.start - removed) } : c;
    const moveSeg = (s: SubtitleSegment): SubtitleSegment | undefined => {
      const a = snap(s.start, 1);
      const b = snap(s.end, -1);
      if (b - a < 0.05) return undefined; // the segment was all silence
      const words = s.words
        ?.map((w) => ({ ...w, start: map(w.start), end: map(w.end) }))
        .filter(
          (w): w is typeof w & { start: number; end: number } =>
            w.start !== undefined && w.end !== undefined,
        );
      return { ...s, start: a, end: b, ...(words && { words }) };
    };
    addBreadcrumb("clip", `${label} (${removed.toFixed(2)} s) de un clip`, { clipId });
    commit((p) => ({
      tracks: p.tracks.map((t) =>
        t.id === track.id
          ? {
              ...t,
              clips: sortClips([...t.clips.filter((c) => c.id !== clipId).map(shift), ...pieces]),
            }
          : t,
      ),
      subtitles: p.subtitles.map(moveSeg).filter((x): x is SubtitleSegment => x !== undefined),
    }));
    return removed;
  };

  return {
    project: createEmptyProject(),
    selectedClipId: undefined,
    selectedClipIds: [],
    inOut: undefined,
    firstVideoAdjust: undefined,
    selectedAssetId: undefined,
    playhead: 0,
    playing: false,
    playbackRate: 1,
    zoom: 60,
    past: [],
    future: [],
    saveState: "idle",

    loadProject: (project) => {
      addBreadcrumb("project", `Abrió el proyecto «${project.name}»`, { projectId: project.id });
      set({
        project,
        past: [],
        future: [],
        ...single(undefined),
        inOut: undefined,
        playhead: 0,
        playing: false,
        saveState: "saved",
      });
    },
    newProject: (name) => get().loadProject(createEmptyProject(name)),
    renameProject: (name) => {
      const { project, past } = get();
      const next = name.trim().slice(0, PROJECT_NAME_MAX) || UNTITLED_PROJECT_NAME;
      if (next === project.name) return;
      addBreadcrumb("project", `Renombró el proyecto a «${next}»`, {}, "project:rename");
      // Sprint 5: renaming is one undo step (the snapshot carries the old name).
      set({
        project: { ...project, name: next, updatedAt: new Date().toISOString() },
        past: [...past, snapshot(project, true)].slice(-HISTORY_LIMIT),
        future: [],
        saveState: "dirty",
      });
    },
    updateProjectSettings: (patch) => {
      addBreadcrumb("project", "Cambió los ajustes del proyecto", { ...patch }, "project:settings");
      commit((p) => ({ settings: { ...p.settings, ...patch } }), false);
    },
    setSaveState: (saveState) => set({ saveState }),

    checkpoint: () => {
      const { project, past } = get();
      set({ past: [...past, snapshot(project)].slice(-HISTORY_LIMIT), future: [] });
    },
    undo: () => {
      const { past, future, project } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      addBreadcrumb("project", "Deshacer");
      set({
        project: { ...project, ...prev, updatedAt: new Date().toISOString() },
        past: past.slice(0, -1),
        future: [snapshot(project, hasMeta(prev)), ...future].slice(0, HISTORY_LIMIT),
        saveState: "dirty",
      });
    },
    redo: () => {
      const { past, future, project } = get();
      const next = future[0];
      if (!next) return;
      addBreadcrumb("project", "Rehacer");
      set({
        project: { ...project, ...next, updatedAt: new Date().toISOString() },
        past: [...past, snapshot(project, hasMeta(next))].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        saveState: "dirty",
      });
    },

    addTrack: (kind) => {
      const track = createTrack(kind, get().project.tracks);
      addBreadcrumb("track", `Añadió una pista de ${kind}`, { trackId: track.id });
      commit((p) => ({ tracks: [...p.tracks, track] }));
      return track.id;
    },
    updateTrack: (trackId, patch) =>
      commit((p) => ({
        tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      })),
    removeTrack: (trackId) => {
      addBreadcrumb("track", "Eliminó una pista", { trackId });
      commit((p) => ({ tracks: p.tracks.filter((t) => t.id !== trackId) }));
    },

    addAssetClip: (asset, opts = {}) => {
      // Sprint 5 (H7/H26): the first video names the project and sizes a default canvas, in the
      // same undo step as the clip.
      const before = get().project;
      const firstVideo =
        asset.kind === "video" &&
        !before.tracks.some((t) => t.kind === "video" && t.clips.some((c) => c.assetId));
      const autoName = firstVideo ? autoProjectName(before.name, asset) : undefined;
      const canvas =
        firstVideo &&
        asset.width &&
        asset.height &&
        before.settings.width === DEFAULT_CANVAS.width &&
        before.settings.height === DEFAULT_CANVAS.height
          ? canvasSizeForVideo({ width: asset.width, height: asset.height })
          : undefined;
      const fitCanvas =
        canvas &&
        (canvas.width !== before.settings.width || canvas.height !== before.settings.height)
          ? canvas
          : undefined;
      if (autoName || fitCanvas) {
        set({ past: [...get().past, snapshot(before, true)].slice(-HISTORY_LIMIT), future: [] });
        set({
          project: {
            ...get().project,
            ...(autoName ? { name: autoName } : {}),
            ...(fitCanvas ? { settings: { ...before.settings, ...fitCanvas } } : {}),
          },
          firstVideoAdjust: {
            ...(autoName && { name: autoName }),
            ...(fitCanvas && { canvas: fitCanvas }),
          },
        });
      } else get().checkpoint();
      const kind = trackKindForAsset(asset);
      let trackId = ensureTrack(kind, opts.trackId);
      const track = get().project.tracks.find((t) => t.id === trackId)!;
      const base = createClipFromAsset(asset, trackId, opts.start ?? get().playhead);
      const length = clipEnd(base) - base.start;
      const start =
        opts.start !== undefined ? base.start : firstFreeStart(track, base.start, length);
      if (opts.start !== undefined) trackId = freeTrackFor(kind, trackId, start, length);
      const clip = { ...base, start, trackId };
      addBreadcrumb(
        "clip",
        `Añadió el clip «${asset.name}» (${asset.kind}) en ${start.toFixed(2)} s`,
        {
          clipId: clip.id,
          assetId: asset.id,
          trackId,
        },
      );
      commit((p) => ({ tracks: insertClip(p.tracks, clip) }), false);
      set(single(clip.id));
      return clip;
    },
    addTextClip: (opts = {}) => {
      get().checkpoint();
      const trackId = ensureTrack("text", opts.trackId);
      const clip = createTextClip(trackId, opts.start ?? get().playhead, opts.text);
      addBreadcrumb("clip", `Añadió un clip de texto en ${clip.start.toFixed(2)} s`, {
        clipId: clip.id,
        trackId,
      });
      commit((p) => ({ tracks: insertClip(p.tracks, clip) }), false);
      set(single(clip.id));
      return clip;
    },
    addClip: (kind, partial, trackId) => {
      get().checkpoint();
      const length = Math.max(0, (partial.out - partial.in) / (partial.speed || 1));
      const id = freeTrackFor(kind, ensureTrack(kind, trackId), partial.start, length);
      const clip: Clip = { ...partial, trackId: id };
      addBreadcrumb("clip", `Añadió un clip de ${kind} en ${clip.start.toFixed(2)} s`, {
        clipId: clip.id,
        trackId: id,
      });
      commit((p) => ({ tracks: insertClip(p.tracks, clip) }), false);
      set(single(clip.id));
      return clip;
    },
    moveClip: (clipId, start, trackId, record = true) => {
      addBreadcrumb(
        "clip",
        `Movió un clip a ${start.toFixed(2)} s`,
        { clipId, start, ...(trackId && { trackId }) },
        `move:${clipId}`,
      );
      commit((p) => {
        const found = findClip(p, clipId);
        if (!found) return {};
        const target = (trackId && p.tracks.find((t) => t.id === trackId)) || found.track;
        const dest = target.kind === found.track.kind && !target.locked ? target : found.track;
        // Feedback 5: never overlap on video/audio/motion tracks; snap next to the neighbour.
        const free = NO_OVERLAP_KINDS.includes(dest.kind)
          ? nearestFreeStart(dest, start, clipEnd(found.clip) - found.clip.start, clipId)
          : start;
        return { tracks: moveClip(p.tracks, clipId, free, trackId) };
      }, record);
    },
    trimClip: (clipId, edge, time, maxSourceDuration, record = true) => {
      const found = findClip(get().project, clipId);
      if (!found || found.track.locked) return;
      const lim = NO_OVERLAP_KINDS.includes(found.track.kind)
        ? trimLimits(found.track, found.clip)
        : { minStart: 0, maxEnd: Infinity };
      const next =
        edge === "start"
          ? trimClipStart(found.clip, Math.max(lim.minStart, time))
          : trimClipEnd(found.clip, Math.min(lim.maxEnd, time), maxSourceDuration);
      addBreadcrumb(
        "clip",
        `Recortó el ${edge === "start" ? "inicio" : "final"} de un clip a ${time.toFixed(2)} s`,
        { clipId, edge, time },
        `trim:${clipId}:${edge}`,
      );
      commit((p) => ({ tracks: replaceClip(p.tracks, next) }), record);
    },
    splitAt: (time, clipId) => {
      const { project, playhead, selectedClipIds } = get();
      const at = time ?? playhead;
      const under = (c: Clip) => at > c.start && at < clipEnd(c);
      // Sprint 5: the selected clips under the playhead; when none of them is there (e.g. a click
      // on the ruler far from the selection), every unlocked clip under the playhead.
      const wanted = clipId
        ? [clipId]
        : selectedClipIds.filter((id) => {
            const f = findClip(project, id);
            return f && under(f.clip);
          });
      const targets: Clip[] = [];
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (wanted.length ? wanted.includes(c.id) : under(c)) targets.push(c);
        }
      }
      let changed = false;
      let tracks = project.tracks;
      for (const c of targets) {
        const parts = splitClip(c, at);
        if (!parts) continue;
        tracks = insertClip(replaceClip(tracks, parts[0]), parts[1]);
        changed = true;
      }
      if (changed) {
        addBreadcrumb("clip", `Dividió ${targets.length} clip(s) en ${at.toFixed(2)} s`, {
          clipIds: targets.map((c) => c.id),
          at,
        });
        commit(() => ({ tracks }));
      }
      return changed;
    },
    deleteClip: (clipId) => {
      const id = clipId ?? get().selectedClipId;
      if (!id) return;
      const found = findClip(get().project, id);
      if (!found || found.track.locked) return;
      addBreadcrumb("clip", "Eliminó un clip", { clipId: id });
      commit((p) => ({ tracks: removeClip(p.tracks, id) }));
      if (get().selectedClipIds.includes(id))
        set(many(get().selectedClipIds.filter((x) => x !== id)));
    },
    removeSilences: (clipId, minGapSec) => {
      const found = findClip(get().project, clipId);
      if (!found || found.track.locked) return 0;
      const ranges = speechRanges(
        get().project.subtitles,
        found.clip.start,
        clipEnd(found.clip),
        minGapSec,
      );
      return rippleKeep(clipId, ranges, "Quitó silencios");
    },
    applyCutsLocally: (clipId, cuts) => {
      const found = findClip(get().project, clipId);
      if (!found || found.track.locked || cuts.length === 0) return 0;
      return rippleKeep(clipId, keepRanges(found.clip, cuts), "Aplicó cortes revisados");
    },
    setReframe: (reframe, record = true) => {
      addBreadcrumb(
        "project",
        reframe
          ? `Reencuadre ${reframe.target} (${reframe.keyframes.length} keyframes)`
          : "Quitó el reencuadre",
        reframe ? { target: reframe.target } : {},
        "project:reframe",
      );
      const { project, past } = get();
      const next: Project = { ...project, reframe, updatedAt: new Date().toISOString() };
      set({
        project: next,
        saveState: "dirty",
        ...(record ? { past: [...past, snapshot(project)].slice(-HISTORY_LIMIT), future: [] } : {}),
      });
    },
    adoptServerProject: (remote, label) => {
      addBreadcrumb("project", label, { projectId: remote.id });
      const { project, past } = get();
      set({
        project: { ...remote, id: project.id },
        past: [...past, snapshot(project)].slice(-HISTORY_LIMIT),
        future: [],
        saveState: "saved",
      });
      pruneSelection();
    },
    applyServerEdit: (remote, label) => {
      addBreadcrumb("clip", label);
      commit(() => ({ tracks: remote.tracks, subtitles: remote.subtitles }));
      pruneSelection();
    },
    splitAtTimes: (clipId, times) => {
      const found = findClip(get().project, clipId);
      if (!found || found.track.locked) return 0;
      const pieces = splitClipAtTimes(found.clip, times);
      if (pieces.length < 2) return 0;
      addBreadcrumb("clip", `Cortó un clip en ${pieces.length - 1} cambio(s) de escena`, {
        clipId,
      });
      commit((p) => ({
        tracks: p.tracks.map((t) =>
          t.id === found.track.id
            ? { ...t, clips: sortClips([...t.clips.filter((c) => c.id !== clipId), ...pieces]) }
            : t,
        ),
      }));
      return pieces.length - 1;
    },
    removeClipsUsingAsset: (assetId) => {
      const uses = (c: Clip) => c.assetId === assetId || c.renderedAssetId === assetId;
      const n = get().project.tracks.reduce((k, t) => k + t.clips.filter(uses).length, 0);
      if (n === 0) return 0;
      addBreadcrumb("clip", `Quitó ${n} clip(s) que usaban un medio`, { assetId });
      commit((p) => ({
        tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !uses(c)) })),
      }));
      pruneSelection();
      return n;
    },
    updateClip: (clipId, patch, record = true) => {
      const found = findClip(get().project, clipId);
      if (!found) return;
      const fields = Object.keys(patch);
      addBreadcrumb(
        "clip",
        `Editó un clip (${fields.join(", ")})`,
        { clipId, fields },
        `update:${clipId}:${fields.join(",")}`,
      );
      commit((p) => ({ tracks: replaceClip(p.tracks, { ...found.clip, ...patch }) }), record);
    },

    setSubtitles: (segments) => {
      addBreadcrumb("project", `Reemplazó los subtítulos (${segments.length} segmentos)`);
      commit(() => ({ subtitles: [...segments].sort((a, b) => a.start - b.start) }));
    },
    setCaptionStyle: (captionStyle) => commit(() => ({ captionStyle }), false),
    setBurnSubtitles: (burnSubtitles) => commit(() => ({ burnSubtitles }), false),
    setPublish: (patch) => {
      const { project } = get();
      const publish: PublishSettings = nextPublish(projectPublish(project), patch);
      addBreadcrumb("project", "Cambió la revisión para redes", { ...patch }, "project:publish");
      const next: ProjectWithPublish = { ...project, publish, updatedAt: new Date().toISOString() };
      set({ project: next, saveState: "dirty" });
    },
    updateSubtitle: (index, patch) =>
      commit((p) => ({
        subtitles: p.subtitles.map((s, i) => (i === index ? { ...s, ...patch } : s)),
      })),
    removeSubtitle: (index) =>
      commit((p) => ({ subtitles: p.subtitles.filter((_, i) => i !== index) })),
    addSubtitle: (segment) => {
      const at = get().playhead;
      const seg = segment ?? {
        start: roundTime(at),
        end: roundTime(at + 2),
        text: "Nuevo subtítulo",
      };
      commit((p) => ({ subtitles: [...p.subtitles, seg].sort((a, b) => a.start - b.start) }));
    },

    selectClip: (clipId, mode = "replace") => {
      if (!clipId) return set(single(undefined));
      const { selectedClipIds, selectedClipId, project } = get();
      if (mode === "toggle") {
        return set(
          many(
            selectedClipIds.includes(clipId)
              ? selectedClipIds.filter((x) => x !== clipId)
              : [...selectedClipIds, clipId],
          ),
        );
      }
      if (mode === "range" && selectedClipId) {
        const a = findClip(project, selectedClipId);
        const b = findClip(project, clipId);
        if (a && b && a.track.id === b.track.id) {
          const range = clipRange(b.track, selectedClipId, clipId).filter((x) => x !== clipId);
          return set(many([...selectedClipIds, ...range, clipId]));
        }
        return set(many([...selectedClipIds, clipId]));
      }
      set(single(clipId));
    },
    selectClips: (ids, additive = false) =>
      set(many(additive ? [...get().selectedClipIds, ...ids] : ids)),
    selectAll: () => {
      const ids = get()
        .project.tracks.filter((t) => !t.locked)
        .flatMap((t) => t.clips.map((c) => c.id));
      set(many(ids));
    },
    deleteSelected: (opts = {}) => {
      const ids = get().selectedClipIds.length
        ? get().selectedClipIds
        : get().selectedClipId
          ? [get().selectedClipId!]
          : [];
      if (ids.length === 0) return 0;
      if (opts.ripple) return get().rippleDelete(ids);
      const project = get().project;
      const deletable = new Set(
        project.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.map((c) => c.id)),
      );
      const gone = ids.filter((id) => deletable.has(id));
      if (gone.length === 0) return 0;
      addBreadcrumb("clip", `Eliminó ${gone.length} clip(s)`, { clipIds: gone });
      commit((p) => ({
        tracks: p.tracks.map((t) =>
          t.locked ? t : { ...t, clips: t.clips.filter((c) => !gone.includes(c.id)) },
        ),
      }));
      pruneSelection();
      return gone.length;
    },
    rippleDelete: (ids) => {
      const { project } = get();
      const { tracks, removed } = rippleDeleteClips(project.tracks, ids);
      const n = project.tracks.reduce(
        (k, t) => k + (removed[t.id] ? t.clips.filter((c) => ids.includes(c.id)).length : 0),
        0,
      );
      if (n === 0) return 0;
      const main = mainVideoTrackId(project);
      const mainRemoved = main ? (removed[main] ?? []) : [];
      addBreadcrumb("clip", `Borró ${n} clip(s) y cerró el hueco`, { clipIds: [...ids] });
      commit((p) => ({
        tracks,
        ...(mainRemoved.length ? { subtitles: rippleSubtitles(p.subtitles, mainRemoved) } : {}),
      }));
      pruneSelection();
      return n;
    },
    moveSelected: (delta, record = true, origins) => {
      const { project, selectedClipIds } = get();
      const ids = selectedClipIds.filter((id) => {
        const f = findClip(project, id);
        return f && !f.track.locked;
      });
      if (ids.length === 0) return false;
      const startOf = (c: Clip) => origins?.[c.id] ?? c.start;
      // Never before 0: clamp the delta by the earliest clip.
      let d = delta;
      for (const id of ids) {
        const c = findClip(project, id)!.clip;
        d = Math.max(d, -startOf(c));
      }
      const moving = new Set(ids);
      const tracks = project.tracks.map((t) =>
        t.clips.some((c) => moving.has(c.id))
          ? {
              ...t,
              clips: sortClips(
                t.clips.map((c) =>
                  moving.has(c.id) ? { ...c, start: roundTime(startOf(c) + d) } : c,
                ),
              ),
            }
          : t,
      );
      // Feedback 5: a batch move that would overlap a clip on a video/audio/motion track is refused.
      for (const t of tracks) {
        if (!NO_OVERLAP_KINDS.includes(t.kind)) continue;
        for (const c of t.clips)
          if (moving.has(c.id) && overlapsOnTrack(t, c.start, clipEnd(c) - c.start, c.id))
            return false;
      }
      addBreadcrumb(
        "clip",
        `Movió ${ids.length} clip(s) ${d.toFixed(2)} s`,
        { clipIds: ids, delta: d },
        "move:selection",
      );
      commit(() => ({ tracks }), record);
      return true;
    },
    closeGaps: (trackId) => {
      const { project, selectedClipId } = get();
      const id =
        trackId ?? (selectedClipId ? findClip(project, selectedClipId)?.track.id : undefined);
      const track = id ? project.tracks.find((t) => t.id === id) : undefined;
      if (!track || track.locked) return 0;
      const { track: packed, removed } = closeTrackGaps(track);
      if (removed.length === 0) return 0;
      const total = removed.reduce((k, r) => k + r.end - r.start, 0);
      addBreadcrumb("track", `Cerró ${removed.length} hueco(s) de «${track.name}»`, {
        trackId: track.id,
      });
      const isMain = mainVideoTrackId(project) === track.id;
      commit((p) => ({
        tracks: p.tracks.map((t) => (t.id === track.id ? packed : t)),
        ...(isMain ? { subtitles: rippleSubtitles(p.subtitles, removed) } : {}),
      }));
      return roundTime(total);
    },
    trimToCursor: (edge) => {
      const { project, playhead, selectedClipIds } = get();
      const inside = (c: Clip) => playhead > c.start && playhead < clipEnd(c);
      // The selected clip under the cursor, else the first unlocked video/audio clip there.
      let target = [...selectedClipIds]
        .reverse()
        .map((id) => findClip(project, id))
        .find((f) => f && !f.track.locked && inside(f.clip))?.clip;
      if (!target) {
        for (const kind of ["video", "audio", "motion", "text"] as const) {
          const t = project.tracks.find(
            (x) => x.kind === kind && !x.locked && x.clips.some(inside),
          );
          target = t?.clips.find(inside);
          if (target) break;
        }
      }
      if (!target) return false;
      const res = trimClipToCursor(project.tracks, target.id, playhead, edge);
      if (!res) return false;
      const isMain = mainVideoTrackId(project) === res.trackId;
      addBreadcrumb(
        "clip",
        `Recortó el ${edge === "start" ? "comienzo" : "final"} de un clip hasta el cursor (Q/W)`,
        { clipId: target.id, edge, at: playhead },
      );
      commit((p) => ({
        tracks: res.tracks,
        ...(isMain ? { subtitles: rippleSubtitles(p.subtitles, [res.removed]) } : {}),
      }));
      // Q: the cursor goes back to the cut (now at the clip start), like other editors.
      if (edge === "start") set({ playhead: res.removed.start });
      return true;
    },
    updateClips: (ids, patch) => {
      const { project } = get();
      const targets = ids.map((id) => findClip(project, id)).filter((f) => f !== undefined);
      if (targets.length === 0) return;
      const fields = Object.keys(patch);
      addBreadcrumb(
        "clip",
        `Editó ${targets.length} clip(s) (${fields.join(", ")})`,
        { clipIds: [...ids], fields },
        `update:batch:${fields.join(",")}`,
      );
      commit((p) => {
        let tracks = p.tracks;
        for (const f of targets) tracks = replaceClip(tracks, { ...f.clip, ...patch });
        return { tracks };
      });
    },
    markIn: (time) => {
      const t = roundTime(time ?? get().playhead);
      const cur = get().inOut;
      const end = Math.max(projectDuration(get().project), t);
      set({ inOut: { in: t, out: cur && cur.out > t ? cur.out : end } });
    },
    markOut: (time) => {
      const t = roundTime(time ?? get().playhead);
      const cur = get().inOut;
      set({ inOut: { in: cur && cur.in < t ? cur.in : 0, out: t } });
    },
    clearInOut: () => set({ inOut: undefined }),

    selectAsset: (selectedAssetId) => set({ selectedAssetId }),
    setPlayhead: (time) => {
      const max = Math.max(projectDuration(get().project), 0) + 60;
      set({ playhead: roundTime(clamp(time, 0, max)) });
    },
    setPlaying: (playing) => set(playing ? { playing } : { playing, playbackRate: 1 }),
    togglePlaying: () => set({ playing: !get().playing, playbackRate: 1 }),
    shuttleForward: () => {
      const { playing, playbackRate } = get();
      const faster = playing && playbackRate > 0;
      set({ playing: true, playbackRate: faster ? Math.min(4, playbackRate * 2) : 1 });
    },
    shuttleBackward: () => {
      const { playing, playbackRate } = get();
      const faster = playing && playbackRate < 0;
      set({ playing: true, playbackRate: faster ? Math.max(-4, playbackRate * 2) : -1 });
    },
    shuttleStop: () => set({ playing: false, playbackRate: 1 }),
    setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
    zoomBy: (factor) => set({ zoom: clamp(get().zoom * factor, MIN_ZOOM, MAX_ZOOM) }),
  };
});

/** Selected clip + its track (stable selector helper). */
export function selectSelectedClip(state: ProjectState): { clip: Clip; track: Track } | undefined {
  if (!state.selectedClipId) return undefined;
  const found = findClip(state.project, state.selectedClipId);
  return found ? { clip: found.clip, track: found.track } : undefined;
}
