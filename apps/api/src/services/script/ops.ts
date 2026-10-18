import {
  buildScript,
  cutTimeline,
  findPhrase,
  fitDuration,
  fmtS,
  planWordCuts,
  replaceWordsText,
  SCRIPT_RULES,
  speedUpTimeline,
  timelineDuration,
  type EditOpOf,
  type Project,
  type Script,
  type ScriptCutsRequest,
  type ScriptCutsResponse,
  type SubtitleSegment,
} from "@studio/shared";
import {
  computeCuts,
  computeFit,
  getScript,
  refinedFitCuts,
  scriptError,
  type ScriptDeps,
} from "./service.js";

/**
 * Sprint 6 M1: the three script ops of the EditPlan (resolver preview + agent.apply). Deps are
 * registered once by app.ts/routes (`setScriptDeps`) so the synchronous resolver can read the
 * audio artifacts; without them the Script is built from the subtitles alone (no acoustic gaps).
 */

let registered: ScriptDeps | undefined;

export function setScriptDeps(deps: ScriptDeps | undefined): void {
  registered = deps;
}

export function scriptDeps(): ScriptDeps | undefined {
  return registered;
}

/** Script of a project with whatever audio artifacts are known. */
export function scriptOf(project: Project): Script {
  return registered ? getScript(registered, project) : buildScript(project);
}

type DeleteWordsOp = EditOpOf<"delete_words">;
type FitOp = EditOpOf<"fit_duration">;
type FixOp = EditOpOf<"fix_text">;

export const NO_SCRIPT_ES = "Primero transcribí el video (Guion → Transcribir).";

/** ScriptCutsRequest equivalent of a delete_words op (text → word ids of every occurrence). */
export function deleteWordsRequest(script: Script, op: DeleteWordsOp): ScriptCutsRequest {
  const wordIds = op.text ? findPhrase(script.words, op.text).flat() : [];
  return {
    ...(wordIds.length > 0 && { wordIds }),
    ...(op.ranges && { ranges: op.ranges }),
    ...(op.fillers && { fillers: op.fillers }),
    ...(op.long_pauses && { shortenLongPauses: true }),
    avoidHarsh: true,
  };
}

/** Cuts of a delete_words op on a project (energy refined when the artifacts are there). */
export function deleteWordsCuts(project: Project, op: DeleteWordsOp): ScriptCutsResponse {
  const script = scriptOf(project);
  if (script.words.length === 0) throw scriptError("SCRIPT_EMPTY");
  const req = deleteWordsRequest(script, op);
  if (op.text && !req.wordIds && !req.ranges && !req.fillers && !req.shortenLongPauses)
    return { cuts: [], removed_s: 0, skipped: [] };
  if (registered) return computeCuts(registered, project, req, { allowEmpty: true });
  // No deps (tests of the bare resolver): same plan, no energy.
  return computeCutsBare(script, req);
}

function computeCutsBare(script: Script, req: ScriptCutsRequest): ScriptCutsResponse {
  return planWordCuts(script, req);
}

const LEVEL_ES: Record<NonNullable<DeleteWordsOp["fillers"]>, string> = {
  safe: "seguras",
  probable: "seguras y probables",
  all: "(todas)",
};

/** «Quitar 8 muletillas seguras (−3,4 s)». */
export function deleteWordsPreview(op: DeleteWordsOp, res: ScriptCutsResponse): string {
  const parts: string[] = [];
  const n = (reason: string) => res.cuts.filter((c) => c.reason === reason).length;
  if (op.fillers) parts.push(`${n("filler")} muletillas ${LEVEL_ES[op.fillers]}`);
  if (op.long_pauses) parts.push(`${n("pause")} pausas largas`);
  if (op.text) parts.push(`«${op.text}» (${n("words") + n("filler")} veces)`);
  if (op.ranges) parts.push(`${op.ranges.length} tramos`);
  const skipped = res.skipped.length
    ? `; ${res.skipped.length} sin cortar para evitar cortes bruscos`
    : "";
  return `Quitar ${parts.join(", ")} (−${fmtS(res.removed_s)} s)${skipped}`;
}

/** Remove the cuts on every unlocked track + subtitles (12 ms join fades). */
export function applyScriptCuts(
  project: Project,
  cuts: readonly { start: number; end: number }[],
  newId: () => string,
): { project: Project; removed_s: number } {
  const out = cutTimeline(project, cuts, { fadeMs: SCRIPT_RULES.join_fade_ms, newId });
  return { project: out.project, removed_s: out.removed_s };
}

export function applyDeleteWords(
  project: Project,
  op: DeleteWordsOp,
  newId: () => string,
): { project: Project; removed_s: number; cuts: number; skipped: number } {
  const res = deleteWordsCuts(project, op);
  if (res.cuts.length === 0) throw scriptError("SCRIPT_NOTHING_TO_CUT");
  const out = applyScriptCuts(project, res.cuts, newId);
  return { ...out, cuts: res.cuts.length, skipped: res.skipped.length };
}

export function fitPreview(project: Project, op: FitOp) {
  const req = {
    target_s: op.target_s,
    ...(op.tolerance_s !== undefined && { tolerance_s: op.tolerance_s }),
    ...(op.allow_speedup !== undefined && { allow_speedup: op.allow_speedup }),
    ...(op.allow_sentences !== undefined && { allow_sentences: op.allow_sentences }),
  };
  if (registered) return computeFit(registered, project, req);
  const script = scriptOf(project);
  if (script.words.length === 0) throw scriptError("SCRIPT_EMPTY");
  return fitDuration(script, req);
}

export function applyFit(
  project: Project,
  op: FitOp,
  newId: () => string,
): { project: Project; from_s: number; to_s: number; speed?: number } {
  const preview = fitPreview(project, op);
  // Integration S6: the same energy-refined cuts as `delete_words {ranges}` (and the preview).
  const cuts =
    (registered && refinedFitCuts(registered, project, preview.cuts)?.cuts) || preview.cuts;
  let next = project;
  if (cuts.length) next = applyScriptCuts(project, cuts, newId).project;
  if (preview.speed) next = speedUpTimeline(next, preview.speed);
  return {
    project: next,
    from_s: preview.from_s,
    to_s: timelineDuration(next),
    ...(preview.speed && { speed: preview.speed }),
  };
}

/** Occurrences of `find` a fix_text op corrects (word ids per occurrence), or a question. */
export function fixTextTargets(
  project: Project,
  op: FixOp,
  at?: number,
): { hits: string[][]; segments: number[] } | { question: string } {
  const script = scriptOf(project);
  const hits = findPhrase(script.words, op.find);
  // Segments without words get estimated words in the Script: one search covers both.
  const segments: number[] = [];
  const total = hits.length + segments.length;
  if (total === 0)
    return { question: `No encontré «${op.find}» en los subtítulos. ¿Cómo aparece escrito?` };
  if (op.all) return { hits, segments };
  if (at !== undefined) {
    const inSeg = (si: number) => {
      const s = project.subtitles[si]!;
      return at >= s.start - 0.5 && at <= s.end + 0.5;
    };
    const h = hits.filter((ids) => inSeg(Number(ids[0]!.split(":")[0])));
    const g = segments.filter(inSeg);
    if (h.length + g.length === 0)
      return { question: `En ${fmtS(at)} s no aparece «${op.find}». ¿En qué momento está?` };
    return { hits: h.slice(0, 1), segments: h.length ? [] : g.slice(0, 1) };
  }
  if (total > 1)
    return {
      question: `«${op.find}» aparece ${total} veces. ¿Corrijo todas o la de qué momento?`,
    };
  return { hits, segments };
}

export function applyFixText(
  project: Project,
  op: FixOp,
  targets: { hits: string[][]; segments: number[] },
): { project: Project; corrected: number; estimated: number } {
  let subtitles: SubtitleSegment[] = project.subtitles;
  // Replace from the last occurrence backwards: ids of earlier ones stay valid.
  const ordered = [...targets.hits].sort((a, b) => cmpId(b[0]!, a[0]!));
  for (const ids of ordered) subtitles = replaceWordsText(subtitles, ids, op.replace);
  const re = new RegExp(escapeRe(op.find), "i");
  for (const si of targets.segments)
    subtitles = subtitles.map((s, i) =>
      i === si ? { ...s, text: s.text.replace(re, op.replace) } : s,
    );
  const before = project.subtitles.flatMap((s) => s.words ?? []).filter((w) => w.corrected).length;
  const after = subtitles.flatMap((s) => s.words ?? []).filter((w) => w.corrected).length;
  return {
    project: { ...project, subtitles },
    corrected: targets.hits.length + targets.segments.length,
    estimated: Math.max(0, after - before),
  };
}

function cmpId(a: string, b: string): number {
  const [sa, wa] = a.split(":").map(Number) as [number, number];
  const [sb, wb] = b.split(":").map(Number) as [number, number];
  return sa - sb || wa - wb;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
