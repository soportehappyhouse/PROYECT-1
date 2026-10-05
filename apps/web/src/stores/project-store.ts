import {
  ProjectSchema,
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
  createClipFromAsset,
  createTextClip,
  createTrack,
  findClip,
  firstFreeStart,
  insertClip,
  moveClip,
  projectDuration,
  removeClip,
  replaceClip,
  splitClip,
  trackKindForAsset,
  trimClipEnd,
  trimClipStart,
} from "@/lib/timeline";
import { addBreadcrumb } from "./breadcrumbs-store";

/** The undoable part of a project. */
interface Snapshot {
  tracks: Track[];
  subtitles: SubtitleSegment[];
}

const HISTORY_LIMIT = 100;
export const MIN_ZOOM = 5; // px per second
export const MAX_ZOOM = 800;

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "local" | "error";

export interface ProjectState {
  project: Project;
  selectedClipId: string | undefined;
  selectedAssetId: string | undefined;
  playhead: number;
  playing: boolean;
  /** Timeline zoom in pixels per second. */
  zoom: number;
  snapping: boolean;
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
  updateClip: (
    clipId: string,
    patch: Partial<Omit<Clip, "id" | "trackId">>,
    record?: boolean,
  ) => void;

  // --- subtitles
  setSubtitles: (segments: SubtitleSegment[]) => void;
  /** Style used by the api to burn subtitles on export (Project.captionStyle). */
  setCaptionStyle: (style: CaptionStyle) => void;
  updateSubtitle: (index: number, patch: Partial<SubtitleSegment>) => void;
  removeSubtitle: (index: number) => void;
  addSubtitle: (segment?: SubtitleSegment) => void;

  // --- selection / transport
  selectClip: (clipId: string | undefined) => void;
  selectAsset: (assetId: string | undefined) => void;
  setPlayhead: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
  toggleSnapping: () => void;
}

export function createEmptyProject(name = "Proyecto sin título"): Project {
  const now = new Date().toISOString();
  const kinds: TrackKind[] = ["video", "audio", "text", "motion"];
  const tracks: Track[] = [];
  for (const k of kinds) tracks.push(createTrack(k, tracks));
  return {
    id: createId("prj"),
    name,
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48_000 },
    tracks,
    subtitles: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Restore the last project from localStorage (validated), or a fresh one. */
export function loadLocalProject(): Project {
  const raw = readJson(STORAGE_KEYS.project);
  const parsed = ProjectSchema.safeParse(raw);
  return parsed.success ? parsed.data : createEmptyProject();
}

export function persistLocalProject(project: Project): void {
  writeJson(STORAGE_KEYS.project, project);
}

function snapshot(p: Project): Snapshot {
  return { tracks: p.tracks, subtitles: p.subtitles };
}

export const useProjectStore = create<ProjectState>()((set, get) => {
  /** Apply a change to the project, optionally recording an undo snapshot. */
  const commit = (
    mutate: (
      p: Project,
    ) => Partial<Pick<Project, "tracks" | "subtitles" | "settings" | "name" | "captionStyle">>,
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

  return {
    project: createEmptyProject(),
    selectedClipId: undefined,
    selectedAssetId: undefined,
    playhead: 0,
    playing: false,
    zoom: 60,
    snapping: true,
    past: [],
    future: [],
    saveState: "idle",

    loadProject: (project) => {
      addBreadcrumb("project", `Abrió el proyecto «${project.name}»`, { projectId: project.id });
      set({
        project,
        past: [],
        future: [],
        selectedClipId: undefined,
        playhead: 0,
        playing: false,
        saveState: "saved",
      });
    },
    newProject: (name) => get().loadProject(createEmptyProject(name)),
    renameProject: (name) => commit(() => ({ name: name.trim() || "Proyecto sin título" }), false),
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
        future: [snapshot(project), ...future].slice(0, HISTORY_LIMIT),
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
        past: [...past, snapshot(project)].slice(-HISTORY_LIMIT),
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
      get().checkpoint();
      const kind = trackKindForAsset(asset);
      const trackId = ensureTrack(kind, opts.trackId);
      const track = get().project.tracks.find((t) => t.id === trackId)!;
      const base = createClipFromAsset(asset, trackId, opts.start ?? get().playhead);
      const start =
        opts.start !== undefined
          ? base.start
          : firstFreeStart(track, base.start, clipEnd(base) - base.start);
      const clip = { ...base, start };
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
      set({ selectedClipId: clip.id });
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
      set({ selectedClipId: clip.id });
      return clip;
    },
    addClip: (kind, partial, trackId) => {
      get().checkpoint();
      const id = ensureTrack(kind, trackId);
      const clip: Clip = { ...partial, trackId: id };
      addBreadcrumb("clip", `Añadió un clip de ${kind} en ${clip.start.toFixed(2)} s`, {
        clipId: clip.id,
        trackId: id,
      });
      commit((p) => ({ tracks: insertClip(p.tracks, clip) }), false);
      set({ selectedClipId: clip.id });
      return clip;
    },
    moveClip: (clipId, start, trackId, record = true) => {
      addBreadcrumb(
        "clip",
        `Movió un clip a ${start.toFixed(2)} s`,
        { clipId, start, ...(trackId && { trackId }) },
        `move:${clipId}`,
      );
      commit((p) => ({ tracks: moveClip(p.tracks, clipId, start, trackId) }), record);
    },
    trimClip: (clipId, edge, time, maxSourceDuration, record = true) => {
      const found = findClip(get().project, clipId);
      if (!found || found.track.locked) return;
      const next =
        edge === "start"
          ? trimClipStart(found.clip, time)
          : trimClipEnd(found.clip, time, maxSourceDuration);
      addBreadcrumb(
        "clip",
        `Recortó el ${edge === "start" ? "inicio" : "final"} de un clip a ${time.toFixed(2)} s`,
        { clipId, edge, time },
        `trim:${clipId}:${edge}`,
      );
      commit((p) => ({ tracks: replaceClip(p.tracks, next) }), record);
    },
    splitAt: (time, clipId) => {
      const { project, playhead, selectedClipId } = get();
      const at = time ?? playhead;
      const targetId = clipId ?? selectedClipId;
      // Split the selected clip, or every unlocked clip under the playhead when none is selected.
      const targets: Clip[] = [];
      for (const t of project.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) {
          if (targetId ? c.id === targetId : at > c.start && at < clipEnd(c)) targets.push(c);
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
      if (get().selectedClipId === id) set({ selectedClipId: undefined });
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

    selectClip: (selectedClipId) => set({ selectedClipId }),
    selectAsset: (selectedAssetId) => set({ selectedAssetId }),
    setPlayhead: (time) => {
      const max = Math.max(projectDuration(get().project), 0) + 60;
      set({ playhead: roundTime(clamp(time, 0, max)) });
    },
    setPlaying: (playing) => set({ playing }),
    togglePlaying: () => set({ playing: !get().playing }),
    setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
    zoomBy: (factor) => set({ zoom: clamp(get().zoom * factor, MIN_ZOOM, MAX_ZOOM) }),
    toggleSnapping: () => set({ snapping: !get().snapping }),
  };
});

/** Selected clip + its track (stable selector helper). */
export function selectSelectedClip(state: ProjectState): { clip: Clip; track: Track } | undefined {
  if (!state.selectedClipId) return undefined;
  const found = findClip(state.project, state.selectedClipId);
  return found ? { clip: found.clip, track: found.track } : undefined;
}
