import {
  buildScript,
  cutTimeline,
  deleteRangesPlan,
  fixSegmentText,
  fmtS,
  gapsToTimeline,
  isAcoustic,
  SCRIPT_RULES,
  scriptIsStale,
  timelineToSource,
  type Clip,
  type EditPlan,
  type FitDurationPreview,
  type FitDurationRequest,
  type Project,
  type Script,
  type ScriptAudioGap,
  type ScriptBuildAudio,
  type ScriptCut,
  type ScriptCutReason,
  type SubtitleSegment,
  type Word,
} from "@studio/shared";
import { useProjectStore } from "@/stores/project-store";

/**
 * Sprint 6 M1 «Guion» (web side, pure). The panel always builds the Script locally from the
 * project (`buildScript` of @studio/shared, the same function as the api), so a cut shows at once.
 * The only thing that comes from the api is the audio artifact of script.transcribe: its acoustic
 * gaps are kept here in SOURCE seconds of each asset and mapped to the timeline again after every
 * edit (`audioForProject`).
 */

/** An acoustic «eh» Whisper did not write, in source seconds of `assetId`. */
export interface SourceGap {
  assetId: string;
  start: number;
  end: number;
}

export interface ScriptAudioMeta {
  jobId: string;
  noise_floor_db: number;
}

const PAD_S = SCRIPT_RULES.cut_pad_max_ms / 1000;

export function mediaClips(project: Pick<Project, "tracks">): Clip[] {
  return project.tracks
    .filter((t) => t.kind === "video" || t.kind === "audio")
    .flatMap((t) => t.clips.filter((c) => c.assetId));
}

/** Acoustic pseudo-words of an api Script -> source-time gaps (undo the 60 ms pads). */
export function acousticFromScript(script: Script, project: Pick<Project, "tracks">): SourceGap[] {
  const clips = mediaClips(project);
  const out: SourceGap[] = [];
  for (const w of script.words) {
    if (!isAcoustic(w)) continue;
    const mid = (w.start + w.end) / 2;
    for (const c of clips) {
      const src = timelineToSource(mid, [c], c.assetId!);
      if (src === undefined) continue;
      const a = timelineToSource(w.start - PAD_S, [c], c.assetId!) ?? c.in;
      const b = timelineToSource(w.end + PAD_S, [c], c.assetId!) ?? c.out;
      out.push({ assetId: c.assetId!, start: a, end: b });
      break;
    }
  }
  return out;
}

/** The audio input of buildScript for the current project (gaps in timeline seconds). */
export function audioForProject(
  project: Pick<Project, "tracks">,
  gaps: readonly SourceGap[],
  meta: ScriptAudioMeta | undefined,
): ScriptBuildAudio | undefined {
  if (!meta) return undefined;
  const clips = mediaClips(project);
  const loud = meta.noise_floor_db + SCRIPT_RULES.acoustic_db_over_floor + 10;
  const byAsset = new Map<string, ScriptAudioGap[]>();
  for (const g of gaps) {
    const list = byAsset.get(g.assetId) ?? [];
    list.push({ start: g.start, end: g.end, rms_db: loud, voiced: true });
    byAsset.set(g.assetId, list);
  }
  const timeline = [...byAsset].flatMap(([assetId, list]) => gapsToTimeline(list, clips, assetId));
  return { jobId: meta.jobId, noise_floor_db: meta.noise_floor_db, gaps: timeline };
}

export function localScript(
  project: Project,
  gaps: readonly SourceGap[],
  meta: ScriptAudioMeta | undefined,
): Script {
  return buildScript(project, audioForProject(project, gaps, meta), {
    stale: scriptIsStale(project),
  });
}

/** Tracks + subtitles after removing `cuts` (every unlocked track, 12 ms join fades). */
export function cutProject(
  project: Project,
  cuts: readonly Pick<ScriptCut, "start" | "end">[],
  newId: () => string,
): { project: Project; removed_s: number } {
  const out = cutTimeline(project, cuts, { fadeMs: SCRIPT_RULES.join_fade_ms, newId });
  return { project: out.project, removed_s: out.removed_s };
}

/** Clip to transcribe: the selected media clip, else the first video/audio clip with an asset. */
export function scriptTargetClip(
  project: Pick<Project, "tracks">,
  selectedClipId?: string,
): Clip | undefined {
  const clips = mediaClips(project);
  return clips.find((c) => c.id === selectedClipId) ?? clips.sort((a, b) => a.start - b.start)[0];
}

/** Next (dir 1) / previous (dir −1) word index with a non-safe filler, or a long pause after it. */
export function nextReviewIndex(
  script: Pick<Script, "words" | "pauses">,
  from: number,
  dir: 1 | -1,
): number | undefined {
  const longAfter = new Set(script.pauses.filter((p) => p.long).map((p) => p.after));
  const hit = (w: Word) => (!!w.filler && w.filler.level !== "safe") || longAfter.has(w.id);
  for (let i = from + dir; i >= 0 && i < script.words.length; i += dir)
    if (hit(script.words[i]!)) return i;
  return undefined;
}

/** Word ids between two ids (inclusive, script order). */
export function wordRange(words: readonly Word[], a: string, b: string): string[] {
  const i = words.findIndex((w) => w.id === a);
  const j = words.findIndex((w) => w.id === b);
  if (i < 0 || j < 0) return [b];
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return words.slice(lo, hi + 1).map((w) => w.id);
}

export type FitChoice = "pause" | "filler" | "sentence" | "speed";

/** The fit preview groups the panel shows with a checkbox (fillers safe + other in one). */
export function fitChoices(preview: FitDurationPreview): { id: FitChoice; label_es: string }[] {
  const out: { id: FitChoice; label_es: string }[] = [];
  const by = (lv: string) => preview.groups.filter((g) => g.level === lv);
  const pauses = by("pauses");
  if (pauses.length) out.push({ id: "pause", label_es: pauses[0]!.label_es });
  const fillers = [...by("fillers_safe"), ...by("fillers_other")];
  if (fillers.length)
    out.push({ id: "filler", label_es: fillers.map((g) => g.label_es).join(" · ") });
  const sentences = by("sentences");
  if (sentences.length) out.push({ id: "sentence", label_es: sentences[0]!.label_es });
  const speed = by("speed");
  if (speed.length) out.push({ id: "speed", label_es: speed[0]!.label_es });
  return out;
}

const REASON_CHOICE: Record<ScriptCutReason, FitChoice> = {
  pause: "pause",
  filler: "filler",
  words: "filler",
  sentence: "sentence",
};

/**
 * Audit S6 E14: «acelerar» only exists with every cut group (the api recomputes fit_duration);
 * unchecking another group unchecks it, and checking it checks them all back.
 */
export function toggleFitChoice(
  preview: FitDurationPreview,
  enabled: readonly FitChoice[],
  id: FitChoice,
  on: boolean,
): FitChoice[] {
  const ids = fitChoices(preview).map((c) => c.id);
  if (id === "speed" && on) return ids;
  const next = on ? [...new Set([...enabled, id])] : enabled.filter((x) => x !== id);
  return !on && id !== "speed" ? next.filter((x) => x !== "speed") : next;
}

/** Duration the checked groups give (the preview's own total when everything is checked). */
export function fitShownTotal(
  preview: FitDurationPreview,
  enabled: ReadonlySet<FitChoice>,
): number {
  if (fitChoices(preview).every((c) => enabled.has(c.id))) return preview.to_s;
  const removed = preview.cuts
    .filter((c) => enabled.has(REASON_CHOICE[c.reason]))
    .reduce((s, c) => s + (c.end - c.start), 0);
  return Math.max(0, preview.from_s - removed);
}

/**
 * EditPlan for «Aplicar» of a fit preview with some groups unchecked: all checked (and a speed-up)
 * = the api plan as is (fit_duration recomputed at apply time); otherwise delete_words with the
 * cuts of the checked groups.
 */
export function fitPlanFor(
  preview: FitDurationPreview,
  enabled: ReadonlySet<FitChoice>,
  req: Pick<FitDurationRequest, "target_s">,
): EditPlan | undefined {
  const all = fitChoices(preview).every((c) => enabled.has(c.id));
  if (all && preview.plan) return preview.plan;
  const cuts = preview.cuts.filter((c) => enabled.has(REASON_CHOICE[c.reason]));
  const removed = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  return deleteRangesPlan(
    cuts,
    `Dejalo en ${fmtS(req.target_s)} s: −${fmtS(removed)} s (${cuts.length} cortes)`,
    cuts.some((c) => c.reason === "sentence"),
  );
}

// ---- H11: editing a segment's text in Subtítulos keeps the word timings ---------------------------

/** Keystrokes closer than this are one edit (one undo step). */
export const TEXT_EDIT_GROUP_MS = 800;

interface TextBurst {
  index: number;
  at: number;
  base: SubtitleSegment;
}
let burst: TextBurst | undefined;

/**
 * Sprint 6 M1 (H11): new text of subtitle `index` with `fixWords` (equal words keep their measured
 * timings, replacements are spread by letters, insertions take ≤ 60 % of the gap). Keystrokes within
 * 800 ms are one undo step, and every keystroke is diffed against the segment as it was when the
 * edit started (estimates never compound).
 */
export function editSubtitleText(index: number, text: string, now = Date.now()): void {
  const store = useProjectStore.getState();
  const current = store.project.subtitles[index];
  if (!current) return;
  const fresh = !burst || burst.index !== index || now - burst.at > TEXT_EDIT_GROUP_MS;
  if (fresh) burst = { index, at: now, base: current };
  const base = burst!.base;
  burst!.at = now;
  const next = fixSegmentText(base, text);
  if (fresh) {
    store.updateSubtitle(index, { text: next.text, words: next.words });
    return;
  }
  const subtitles = store.project.subtitles.map((s, i) => (i === index ? next : s));
  useProjectStore.setState({
    project: { ...store.project, subtitles, updatedAt: new Date().toISOString() },
    saveState: "dirty",
  });
}

/** Tests: forget the current edit burst. */
export function resetTextEditBurst(): void {
  burst = undefined;
}
